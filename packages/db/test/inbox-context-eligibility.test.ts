import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  appendSessionEvents,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionQueueSnapshot,
  listSessionSystemUpdatesForTurn,
  sendAgentMessageInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("inbox-context-eligibility");
  if (!acquired) throw new Error("PostgreSQL fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(unprovedStarted = false) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Inbox eligibility",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Inbox eligibility",
    subjectId: `subject-${suffix}`,
  });
  const g = access.workspaceGrants[0]!;
  async function claim(sessionId: string) {
    const attemptId = crypto.randomUUID();
    const result = await claimSessionWorkForAttempt(client.db, g.workspaceId!, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error(`Expected claim: ${result.reason}`);
    return { turn: result.turn, attemptId };
  }
  async function start() {
    const session = await createSession(client.db, {
      accountId: g.accountId,
      workspaceId: g.workspaceId!,
      initialMessage: "Work",
      resources: [],
      metadata: {},
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceSubjectSessionActivityRls(client.db, g.workspaceId!, g.subjectId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: g.accountId,
        workspaceId: g.workspaceId!,
        sessionId: session.id,
        subjectId: g.subjectId,
        actor: { type: "human", subjectId: g.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Continue",
        resources: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        reasoningEffortFallback: "medium",
        source: "user",
        personalConnectionDelegations: [],
        mcpAccountBindings: [],
      }),
    );
    return claim(session.id);
  }
  const receiver = await start();
  if (unprovedStarted) {
    const [audit] = await appendSessionEvents(client.db, g.workspaceId!, receiver.turn.sessionId, [
      { type: "turn.started", turnId: receiver.turn.id, payload: { turnId: receiver.turn.id } },
    ]);
    expect(audit!.turnAttemptId).toBeNull();
    const [row] = await shared.admin`select execution_context_turn_id from sessions
      where id=${receiver.turn.sessionId}`;
    expect(row!.execution_context_turn_id).toBeNull();
    await expect(
      (async () => {
        await shared.admin`update sessions set execution_context_turn_id=${receiver.turn.id}
          where id=${receiver.turn.sessionId}`;
      })(),
    ).rejects.toThrow("execution context requires an exact started request");
  }
  for (const started of [true, false]) {
    const result = await applySessionTurnSettlement(client.db, g.workspaceId!, {
      sessionId: receiver.turn.sessionId,
      turnId: receiver.turn.id,
      triggerEventId: receiver.turn.triggerEventId,
      attemptId: receiver.attemptId,
      turnStatus: started ? "running" : "completed",
      sessionStatus: started ? "running" : "idle",
      activeTurnId: started ? receiver.turn.id : null,
      events: started ? [{ type: "turn.started", payload: { turnId: receiver.turn.id } }] : [],
    });
    expect(result.action).toBe("settled");
  }
  const sender = await start();
  const message = await withWorkspaceSessionActivityRls(client.db, g.workspaceId!, (tx) =>
    sendAgentMessageInTransaction(tx, {
      accountId: g.accountId,
      workspaceId: g.workspaceId!,
      targetSessionId: receiver.turn.sessionId,
      actor: {
        type: "agent_attempt",
        sessionId: sender.turn.sessionId,
        turnId: sender.turn.id,
        attemptId: sender.attemptId,
        executionGeneration: sender.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
      text: "Agent result",
    }),
  );
  async function consume(contextExpected: boolean) {
    const preview = await getSessionQueueSnapshot(
      client.db,
      g.workspaceId!,
      receiver.turn.sessionId,
    );
    expect(preview).not.toBeNull();
    const next = await claim(receiver.turn.sessionId);
    const [row] = await shared.admin`
      select execution_context_turn_id from session_turns where id=${next.turn.id}`;
    expect(row!.execution_context_turn_id).toBe(contextExpected ? receiver.turn.id : null);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      g.workspaceId!,
      receiver.turn.sessionId,
      next.turn.id,
    );
    expect(delivered.map((update) => update.id)).toEqual([message.updateId]);
  }
  return { sender, message, consume };
}

test("an unproved start remains audit evidence without blocking a later exact start", async () => {
  const { consume } = await fixture(true);
  await consume(true);
});

test.each([
  ["lineage", null],
  ["lineage", "future_restriction"],
  ["context", null],
  ["context", "future_restriction"],
  ["turn_policy", "developer_setup"],
  ["turn_policy", "future_restriction"],
  ["session_policy", "future_restriction"],
  ["turn_policy", null],
] as const)("historical %s restriction %j remains fail closed", async (source, value) => {
  const { sender, message, consume } = await fixture();
  // Preserve synthetic historical JSON, including policy versions the current parser cannot read.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = 'replica'`;
    const restriction = tx.json({ credentialRestriction: value });
    if (source === "lineage") {
      await tx`update session_system_updates set lineage = lineage || ${restriction}::jsonb
        where id=${message.updateId}`;
    } else if (source === "context") {
      await tx`update session_turns set initiator_context = initiator_context || ${restriction}::jsonb
        where id=${sender.turn.id}`;
    } else {
      const metadata = tx.json({
        turnExecutionPolicyV1: { version: 999, credentialRestriction: value },
      });
      if (source === "turn_policy") {
        await tx`update session_turns set metadata = metadata || ${metadata}::jsonb where id=${sender.turn.id}`;
      } else {
        await tx`update sessions set metadata = metadata || ${metadata}::jsonb where id=${sender.turn.sessionId}`;
      }
    }
  });
  await expect(consume(false)).rejects.toThrow(
    source === "lineage" || source === "context"
      ? "Malformed frozen credential restriction"
      : "Malformed turn execution policy",
  );
  const [row] = await shared.admin`select state, delivered_turn_id from session_system_updates
    where id=${message.updateId}`;
  expect(row!.state).toBe("pending");
  expect(row!.delivered_turn_id).toBeNull();
});

test.each([
  ["1.0", true],
  ['"1"', false],
  ["1.5", false],
  ["0", false],
] as const)(
  "persisted JSON generation %s selects the expected execution lane",
  async (generation, contextExpected) => {
    const { message, consume } = await fixture();
    await shared.admin.unsafe(
      "update session_system_updates set lineage = jsonb_set(lineage, '{callerExecutionGeneration}', $1::text::jsonb) where id=$2::uuid",
      [generation, message.updateId],
    );
    await consume(contextExpected);
  },
);
