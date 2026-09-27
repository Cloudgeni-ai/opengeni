import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionHistoryItems,
  applyContextCompaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionFunctionToolResults,
  initializeSessionStartAtomically,
  nextSessionHistoryPosition,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-tool-results");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

async function claimedSession(db: ReturnType<typeof createDb>["db"]) {
  const suffix = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `tool-results-${suffix}`,
      accountName: "Tool results test",
      workspaceExternalSource: "test",
      workspaceExternalId: `tool-results-${suffix}`,
      workspaceName: "Tool results test",
      subjectId: `tool-results-${suffix}`,
    })
  ).workspaceGrants[0]!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId!, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("claim failed");
  const write = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    turnId: claimed.turn.id,
    expectedExecutionGeneration: claimed.turn.executionGeneration,
    expectedAttemptId: attemptId,
  };
  return {
    write,
    append: async (...items: Record<string, unknown>[]) => {
      const start = await nextSessionHistoryPosition(db, write.workspaceId, write.sessionId);
      expect(
        await appendSessionHistoryItems(db, {
          ...write,
          items: items.map((item, index) => ({ position: start + index, item })),
        }),
      ).toBe(true);
    },
    results: async (toolName = "skill_read") =>
      (
        await getActiveSessionFunctionToolResults(db, {
          workspaceId: write.workspaceId,
          sessionId: write.sessionId,
          toolName,
        })
      ).map((row) => row.item.callId),
  };
}

const call = (name: string, callId: string) => ({
  type: "function_call",
  name,
  callId,
  arguments: "{}",
});
const result = (name: string, callId: string) => ({
  type: "function_call_result",
  name,
  callId,
  output: [{ type: "input_text", text: "{}" }],
});

test("returns only active results whose call is active earlier in the same session", async () => {
  if (!client) return;
  const session = await claimedSession(client.db);
  const other = await claimedSession(client.db);
  await other.append(call("skill_read", "other-session"), result("skill_read", "other-session"));
  await session.append(
    { type: "message", role: "user", content: "read the skill" },
    call("skill_read", "summarized"),
    result("skill_read", "summarized"),
  );
  expect(await session.results()).toEqual(["summarized"]);

  const compacted = await applyContextCompaction(client.db, {
    ...session.write,
    replacementItems: [{ type: "message", role: "user", content: "read the skill" }],
    summaryItem: { type: "message", role: "user", content: "Summary." },
  });
  expect(compacted.applied).toBe(true);
  expect(await session.results()).toEqual([]);

  await session.append(
    call("skill_read", "paired"),
    result("skill_read", "paired"),
    result("skill_read", "orphan"),
    result("skill_read", "late-call"),
    call("skill_read", "late-call"),
    call("exec_command", "other-tool"),
    result("exec_command", "other-tool"),
    { type: "function_call", name: "skill_read", call_id: "snake", arguments: "{}" },
    { type: "function_call_result", name: "skill_read", call_id: "snake", output: "{}" },
  );
  expect(
    (
      await getActiveSessionFunctionToolResults(client.db, {
        workspaceId: session.write.workspaceId,
        sessionId: session.write.sessionId,
        toolName: "skill_read",
      })
    ).map((row) => row.item.callId ?? row.item.call_id),
  ).toEqual(["paired", "snake"]);
  expect(await session.results("exec_command")).toEqual(["other-tool"]);
  expect(await other.results()).toEqual(["other-session"]);
}, 180_000);
