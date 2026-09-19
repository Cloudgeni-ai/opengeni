import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  withWorkspaceSubjectSessionActivityRls,
  submitHumanPromptInTransaction,
  claimSessionWorkForAttempt,
  ensureSessionReasoningConfiguration,
  getActiveSessionHistoryItems,
  applySessionTurnSettlement,
  applyContextCompaction,
} from "../src/index";
import { readReasoningConfiguration } from "@opengeni/codex";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("reasoning-configuration");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
test("effort changes persist once before accepted input while baseline stays fixed and stale attempts fail", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "reasoning",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "reasoning",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  async function claim(effort: "low" | "high") {
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: `do ${effort}`,
        resources: [],
        reasoningEffort: effort,
        reasoningEffortFallback: effort,
        source: "user",
      }),
    );
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error("not claimed");
    return result.turn;
  }
  const first = await claim("low");
  const identity = (turn: typeof first, effort: "low" | "high") => ({
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: turn.id,
    expectedExecutionGeneration: turn.executionGeneration,
    expectedAttemptId: turn.activeAttemptId!,
    effort,
  });
  expect(await ensureSessionReasoningConfiguration(client.db, identity(first, "low"))).toBe("low");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(first, "low"))).toBe("low");
  const original = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(original.filter((row) => readReasoningConfiguration(row.item))).toHaveLength(1);
  expect(readReasoningConfiguration(original[0]!.item)?.effort).toBe("low");
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: first.id,
    triggerEventId: first.triggerEventId,
    attemptId: first.activeAttemptId!,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: {} }],
  });
  const second = await claim("high");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(second, "high"))).toBe(
    "low",
  );
  const updated = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(updated.slice(0, original.length).map((row) => row.item)).toEqual(
    original.map((row) => row.item),
  );
  expect(
    updated
      .filter((row) => readReasoningConfiguration(row.item))
      .map((row) => readReasoningConfiguration(row.item)?.effort),
  ).toEqual(["low", "high"]);
  const control = [...updated].reverse().find((row) => readReasoningConfiguration(row.item))!.item;
  const compacted = await applyContextCompaction(client.db, {
    ...identity(second, "high"),
    replacementItems: [],
    summaryItem: { type: "compaction", encrypted_content: "test" },
    trailingItems: [control],
  });
  expect(compacted.applied).toBe(true);
  const replay = await getActiveSessionHistoryItems(client.db, workspaceId, session.id);
  expect(replay[0]!.item.type).toBe("compaction");
  expect(readReasoningConfiguration(replay[1]!.item)?.effort).toBe("high");
  expect(await ensureSessionReasoningConfiguration(client.db, identity(second, "high"))).toBe(
    "low",
  );
  await expect(
    ensureSessionReasoningConfiguration(client.db, identity(first, "low")),
  ).rejects.toThrow("fenced");
}, 180_000);
