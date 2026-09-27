import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  listSessionSystemUpdatesForTurn,
  requestSessionTurnRecovery,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("model-time-context");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

// Independent oracle for the rendered wall clock: minute-precision UTC plus
// the English weekday, computed without the production formatter.
function utcMinute(value: string | Date): string {
  const date = new Date(value);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const iso = date.toISOString();
  return `${weekday} ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Model time context test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Model time context test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return { grant: { ...grant, workspaceId: grant.workspaceId! }, session };
}

async function claim(workspaceId: string, sessionId: string) {
  const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`work was not claimed: ${result.reason}`);
  return result.turn;
}

describe("time context in durable model history", () => {
  test("an accepted message carries its frozen acceptance time, unchanged across recovery", async () => {
    const { grant, session } = await fixture();
    const accepted = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId: session.id,
            subjectId: grant.subjectId,
            actor: { type: "human", subjectId: grant.subjectId },
            operationKey: `send-${crypto.randomUUID()}`,
            delivery: "send",
            text: "Which users signed up today?",
            resources: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
    );
    // Accepted well before the claim: the model must see when the user sent
    // the message, read from the durable turn row, not the claim clock.
    await shared.admin`
      update session_turns set created_at = '2026-01-02T03:04:59.999Z'
      where workspace_id = ${grant.workspaceId} and id = ${accepted.turnId}`;

    const turn = await claim(grant.workspaceId, session.id);
    expect(turn.id).toBe(accepted.turnId);
    const history = await getActiveSessionHistoryItems(client.db, grant.workspaceId, session.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.item).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "[Message sent Friday 2026-01-02 03:04 UTC]" },
        { type: "input_text", text: "Which users signed up today?" },
      ],
    });

    // A replacement attempt reuses the persisted row byte for byte.
    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId: turn.activeAttemptId!,
      reason: "worker_lost",
    });
    expect(recovery.action).toBe("recovering");
    const replacement = await claim(grant.workspaceId, session.id);
    expect(replacement.id).toBe(turn.id);
    expect(replacement.executionGeneration).toBe(turn.executionGeneration + 1);
    expect(await getActiveSessionHistoryItems(client.db, grant.workspaceId, session.id)).toEqual(
      history,
    );
  });

  test("a machine-input batch states when it was delivered and when each input was created", async () => {
    const { grant, session } = await fixture();
    const childSessionId = crypto.randomUUID();
    const added = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: childSessionId,
      dedupeKey: `child-${childSessionId}`,
      summary: "Child completed",
      payload: { type: "child_terminal_result", childSessionId, status: "idle" },
    });
    if (!added.added) throw new Error("system update was not inserted");
    await shared.admin`
      update session_system_updates set created_at = '2026-01-02T03:04:30Z'
      where workspace_id = ${grant.workspaceId} and id = ${added.update.id}`;

    const turn = await claim(grant.workspaceId, session.id);
    expect(turn.source).toBe("system");
    const [delivered] = await listSessionSystemUpdatesForTurn(
      client.db,
      grant.workspaceId,
      session.id,
      turn.id,
    );
    expect(delivered?.deliveredAt).toBeTruthy();
    const history = await getActiveSessionHistoryItems(client.db, grant.workspaceId, session.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(delivered!.deliveredHistoryItemId!);
    const content = String(history[0]?.item.content);
    expect(content).toStartWith(
      [
        "[OpenGeni internal updates]",
        "These platform updates were delivered together for this inference.",
        `Delivered: ${utcMinute(delivered!.deliveredAt!)}`,
        "",
      ].join("\n"),
    );
    const batch = JSON.parse(content.slice(content.indexOf("{"))) as {
      updates: Array<Record<string, unknown>>;
    };
    expect(batch.updates).toEqual([
      expect.objectContaining({
        id: added.update.id,
        kind: "child_terminal_result",
        createdAt: "Friday 2026-01-02 03:04 UTC",
      }),
    ]);
  });
});
