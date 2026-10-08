import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  getSessionTurn,
  requestSessionCompaction,
  withWorkspaceRls,
  recordStartedContextCompaction,
  requestSessionTurnRecovery,
  markSessionAttemptQuiesced,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { eq } from "drizzle-orm";
import { AnthropicSizeRecoveryExhaustedError } from "@opengeni/runtime";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  maybeCompactContext,
  type CompactionSummarizer,
} from "../src/activities/context-compaction";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("claude-byte-compaction");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const size = {
  requestBytes: 16_000,
  limitBytes: 24_000_000,
  imageCount: 1,
  imageBase64Bytes: 4000,
  systemBytes: 1,
  toolsBytes: 1,
};
async function fixture() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Byte recovery",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Byte recovery",
    subjectId: "synthetic-byte-owner",
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const suffix = [
    {
      type: "reasoning",
      providerData: {
        anthropic: {
          block: { type: "thinking", thinking: "inspect", signature: "signed-fixture" },
        },
      },
    },
    { type: "function_call", callId: "read-image", name: "inspect", arguments: "{}" },
    { type: "function_call_result", callId: "read-image", output: "unread image ".repeat(400) },
  ];
  const items = [
    { type: "message", role: "user", content: "Keep all completed work" },
    { type: "message", role: "assistant", content: "completed evidence ".repeat(300) },
    { type: "message", role: "user", content: "Inspect the next image" },
    ...suffix,
  ];
  await withWorkspaceRls(client.db, grant.workspaceId, async (db) => {
    await db.insert(schema.sessionHistoryItems).values(
      items.map((item, position) => ({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        item,
        position,
      })),
    );
  });
  await requestSessionCompaction(client.db, grant.workspaceId, session.id);
  const attemptId = crypto.randomUUID();
  const workflowRunId = crypto.randomUUID();
  const dispatchId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId,
    attemptId,
    dispatchId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Expected a claimed compaction");
  return {
    claimedTurn: claimed.turn,
    workflowRunId,
    dispatchId,
    grant,
    session,
    items,
    suffix,
    scope: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
}

test("byte recovery checkpoints the fitting prefix and retains the complete latest signed tool batch", async () => {
  const { scope, suffix, items } = await fixture();
  let calls = 0;
  const summarize: CompactionSummarizer = async (_settings, input) => {
    calls++;
    expect(JSON.stringify(input)).not.toContain("signed-fixture");
    expect(JSON.stringify(input)).not.toContain("unread image");
    expect(JSON.stringify(input)).toContain("completed evidence");
    return "The earlier evidence was inspected. Keep the next complete tool batch and do not repeat completed work.";
  };
  summarize.measureInputBytes = async (_settings, input) =>
    Buffer.byteLength(JSON.stringify(input));
  const options = {
    force: true,
    trigger: "overflow" as const,
    requestSizeRecovery: { maxBytes: 8000, size },
  };
  const result = await maybeCompactContext(
    client.db,
    testSettings(),
    scope,
    null,
    summarize,
    options,
  );
  expect(result.compacted).toBe(true);
  expect(calls).toBe(1);
  const active = (
    await getActiveSessionHistoryItems(client.db, scope.workspaceId, scope.sessionId)
  ).map((row) => row.item);
  expect(active.slice(-suffix.length)).toEqual(suffix);
  expect(items.slice(-suffix.length)).toEqual(suffix);
  expect(
    (await getSessionTurn(client.db, scope.workspaceId, scope.turnId))!.metadata
      .claudeRequestSizeRecoveryUsed,
  ).toBe(true);
  await expect(
    maybeCompactContext(client.db, testSettings(), scope, null, summarize, options),
  ).rejects.toThrow("one automatic size-recovery");
  expect(calls).toBe(1);
  expect(
    (await getActiveSessionHistoryItems(client.db, scope.workspaceId, scope.sessionId)).map(
      (row) => row.item,
    ),
  ).toEqual(active);
}, 60_000);

test("failed summaries retain history, consume recovery once, and stale attempts cannot consume it", async () => {
  const { scope, items } = await fixture();
  const fenced = await recordStartedContextCompaction(client.db, {
    ...scope,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: crypto.randomUUID(),
    trigger: "overflow",
    requestSizeRecovery: size,
  });
  expect(fenced.recorded).toBe(false);
  expect(
    (await getSessionTurn(client.db, scope.workspaceId, scope.turnId))!.metadata
      .claudeRequestSizeRecoveryUsed,
  ).toBeUndefined();
  const summarize: CompactionSummarizer = async () => {
    throw new Error("synthetic checkpoint failure");
  };
  summarize.measureInputBytes = async (_settings, input) =>
    Buffer.byteLength(JSON.stringify(input));
  await expect(
    maybeCompactContext(client.db, testSettings(), scope, null, summarize, {
      force: true,
      trigger: "overflow",
      requestSizeRecovery: { maxBytes: 8000, size },
    }),
  ).rejects.toThrow("synthetic checkpoint failure");
  expect(
    (await getActiveSessionHistoryItems(client.db, scope.workspaceId, scope.sessionId)).map(
      (row) => row.item,
    ),
  ).toEqual(items);
  expect(
    (await getSessionTurn(client.db, scope.workspaceId, scope.turnId))!.metadata
      .claudeRequestSizeRecoveryUsed,
  ).toBe(true);
}, 60_000);

test("a recovered attempt cannot spend a second byte recovery and exposes a terminal reason", async () => {
  const { scope, items, claimedTurn, workflowRunId, dispatchId } = await fixture();
  expect(
    (
      await recordStartedContextCompaction(client.db, {
        ...scope,
        expectedExecutionGeneration: scope.executionGeneration,
        expectedAttemptId: scope.attemptId,
        trigger: "overflow",
        requestSizeRecovery: size,
      })
    ).recorded,
  ).toBe(true);
  const nextAttempt = crypto.randomUUID();
  expect(
    await requestSessionTurnRecovery(client.db, scope.workspaceId, {
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      triggerEventId: claimedTurn.triggerEventId,
      reason: "worker_shutdown",
    }),
  ).toMatchObject({ action: "recovering" });
  await markSessionAttemptQuiesced(client.db, {
    ...scope,
    temporalWorkflowId: `session-${scope.sessionId}`,
    temporalWorkflowRunId: workflowRunId,
    temporalActivityId: dispatchId,
  });
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: nextAttempt,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claimed.action).toBe("claimed");
  if (claimed.action !== "claimed") throw new Error("Recovery was not claimed");
  expect(claimed.turn.id).toBe(scope.turnId);
  const restarted = {
    ...scope,
    attemptId: nextAttempt,
    executionGeneration: claimed.turn.executionGeneration,
  };
  const started = await recordStartedContextCompaction(client.db, {
    ...restarted,
    expectedExecutionGeneration: restarted.executionGeneration,
    expectedAttemptId: nextAttempt,
    trigger: "overflow",
    requestSizeRecovery: size,
  });
  expect(started).toEqual({ recorded: false, reason: "request_size_recovery_exhausted" });
  expect(
    (await getActiveSessionHistoryItems(client.db, scope.workspaceId, scope.sessionId)).map(
      (row) => row.item,
    ),
  ).toEqual(items);
  expect(agentRunFailurePayload(new AnthropicSizeRecoveryExhaustedError())).toMatchObject({
    code: "anthropic_request_size_recovery_exhausted",
    retryable: false,
  });
}, 60_000);

test("cancellation during summarization fences the replacement and keeps the source intact", async () => {
  const { scope, items } = await fixture();
  const summarize: CompactionSummarizer = async () => {
    await withWorkspaceRls(client.db, scope.workspaceId, async (db) => {
      await db
        .update(schema.sessionTurns)
        .set({ status: "cancelled" })
        .where(eq(schema.sessionTurns.id, scope.turnId));
    });
    return "A checkpoint that must never become active after cancellation.";
  };
  summarize.measureInputBytes = async (_settings, input) =>
    Buffer.byteLength(JSON.stringify(input));
  await expect(
    maybeCompactContext(client.db, testSettings(), scope, null, summarize, {
      force: true,
      trigger: "overflow",
      requestSizeRecovery: { maxBytes: 8000, size },
    }),
  ).rejects.toThrow("fenced");
  expect(
    (await getActiveSessionHistoryItems(client.db, scope.workspaceId, scope.sessionId)).map(
      (row) => row.item,
    ),
  ).toEqual(items);
}, 60_000);
