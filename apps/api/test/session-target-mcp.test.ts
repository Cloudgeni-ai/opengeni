import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AccessGrant } from "@opengeni/contracts";
import { type ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  mutateSessionControlInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-target-mcp");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Voice interface",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Voice interface",
    subjectId: `voice-${crypto.randomUUID()}`,
  });
  const owner = access.workspaceGrants[0]!;
  const { accountId, workspaceId } = owner;
  const make = async () =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
  const claim = async (sessionId: string) => {
    const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Not claimed: ${claimed.reason}`);
    return claimed;
  };
  const caller = await make();
  await initializeSessionStartAtomically(client.db, {
    accountId,
    workspaceId,
    sessionId: caller.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const active = await claim(caller.id);
  const target = await make();
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    principalKind: "agent_attempt",
    permissions: ["sessions:read", "sessions:control"],
    metadata: {
      sessionId: caller.id,
      turnId: active.turn.id,
      attemptId: active.turn.activeAttemptId!,
      executionGeneration: active.turn.executionGeneration,
      firstPartyMcpTools: [
        "session_target_get",
        "session_target_set",
        "session_message_status",
        "session_send_message",
        "session_steer",
        "session_events",
        "session_get",
      ],
    },
  };
  const noop = async () => undefined;
  const deps = {
    db: client.db,
    settings: testSettings({ databaseUrl: shared.appUrl }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
  const makeCall = () => {
    const server = buildOpenGeniMcpServer(deps, grant);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const tools = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler(args: unknown, extra: unknown): Promise<any> }
          >;
        }
      )._registeredTools;
      const result = await tools[name]!.handler(args, {});
      if (result.isError) throw new Error(JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
  };
  const settle = async (
    claimed: Awaited<ReturnType<typeof claim>>,
    output: string,
    failed = false,
  ) => {
    await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: claimed.turn.sessionId,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus: failed ? "failed" : "completed",
      sessionStatus: failed ? "failed" : "idle",
      activeTurnId: null,
      events: [
        {
          type: failed ? "turn.failed" : "turn.completed",
          payload: failed ? { error: output } : { output },
        },
      ],
    });
  };
  return {
    owner,
    grant,
    deps,
    caller,
    active,
    target,
    claim,
    make,
    makeCall,
    call: makeCall(),
    settle,
  };
}

test("target selection survives MCP reload, clear fences stale retry, and selection dispatches nothing", async () => {
  const f = await fixture();
  expect(await f.call("session_target_get")).toMatchObject({ version: 0, sessionId: null });
  const request = { sessionId: f.target.id, expectedVersion: 0, operationId: crypto.randomUUID() };
  const first = await f.call("session_target_set", request);
  expect(first).toMatchObject({ sessionId: f.target.id, version: 1 });
  expect(await f.makeCall()("session_target_get")).toMatchObject(first);
  expect(await f.call("session_target_set", request)).toEqual(first);
  expect(
    await listOutstandingSessionSystemUpdates(client.db, f.owner.workspaceId, f.target.id),
  ).toEqual([]);
  expect(
    await f.call("session_target_set", {
      sessionId: null,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    }),
  ).toMatchObject({ version: 2, sessionId: null });
  await expect(f.call("session_target_set", request)).rejects.toThrow("changed");
});

test("target access is checked at selection and again after reload; inaccessible selection can be cleared", async () => {
  const f = await fixture();
  const foreign = await fixture();
  await expect(
    f.call("session_target_set", {
      sessionId: foreign.target.id,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  await f.call("session_target_set", {
    sessionId: f.target.id,
    expectedVersion: 0,
    operationId: crypto.randomUUID(),
  });
  // A host's live narrowing must apply even to a previously selected target.
  f.deps.sessionAuthorization = {
    authorizeSession: async (input) =>
      input.target.sessionId === f.target.id
        ? { allowed: false, reason: "revoked" }
        : { allowed: true },
    resolveListScope: async () => ({ kind: "all" }),
  } as NonNullable<ApiRouteDeps["sessionAuthorization"]>;
  expect(await f.makeCall()("session_target_get")).toMatchObject({
    version: 1,
    sessionId: null,
    unavailable: true,
  });
  f.deps.sessionAuthorization = null;
  expect(
    await f.call("session_target_set", {
      sessionId: null,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    }),
  ).toMatchObject({ sessionId: null });
  await f.settle(f.active, "done");
  await expect(
    f.call("session_target_set", {
      sessionId: f.target.id,
      expectedVersion: 2,
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
});

test.each([false, true])(
  "message receipt follows only its consuming turn and relays its actual outcome (failed=%s)",
  async (failed) => {
    const f = await fixture();
    // An unrelated older result must not satisfy this new request.
    await appendSessionEvents(client.db, f.owner.workspaceId, f.target.id, [
      { type: "turn.completed", payload: { output: "Old unrelated answer" } },
    ]);
    const request = {
      sessionId: f.target.id,
      text: "Check the requested work",
      idempotencyKey: crypto.randomUUID(),
    };
    const sent = await f.call("session_send_message", request);
    const replay = await f.call("session_send_message", request);
    expect(replay.resource.id).toBe(sent.resource.id);
    const statusRequest = { sessionId: f.target.id, updateId: sent.resource.id };
    expect(await f.call("session_message_status", statusRequest)).toMatchObject({
      delivery: "pending",
      turnId: null,
      outcome: null,
    });
    const claimed = await f.claim(f.target.id);
    expect(await f.call("session_message_status", statusRequest)).toMatchObject({
      delivery: "delivered",
      turnId: claimed.turn.id,
      outcome: null,
    });
    await f.settle(claimed, "Exact requested outcome", failed);
    const status = await f.call("session_message_status", statusRequest);
    expect(status).toMatchObject({
      turnId: claimed.turn.id,
      turnStatus: failed ? "failed" : "completed",
      nextAction: { arguments: { view: "results" } },
    });
    const result = await f.call(status.nextAction.tool, status.nextAction.arguments);
    expect(JSON.stringify(result)).toContain("Exact requested outcome");
    expect(JSON.stringify(result)).not.toContain("Old unrelated answer");
    await expect(
      f.call("session_message_status", { sessionId: f.caller.id, updateId: sent.resource.id }),
    ).rejects.toThrow();
  },
);

test.each(["cancelled", "superseded"] as const)(
  "message receipt relays the exact %s reason without unrelated outcomes",
  async (turnStatus) => {
    const f = await fixture();
    const type = `turn.${turnStatus}` as const;
    const unrelated = [
      { type: "turn.completed" as const, payload: { output: "Unrelated answer" } },
      { type, payload: { reason: "Unrelated interruption" } },
    ];
    await appendSessionEvents(client.db, f.owner.workspaceId, f.target.id, unrelated);
    const sent = await f.call("session_send_message", {
      sessionId: f.target.id,
      text: "Check the requested work",
      idempotencyKey: crypto.randomUUID(),
    });
    const claimed = await f.claim(f.target.id);
    const reason = `Exact requested ${turnStatus} reason`;
    await applySessionTurnSettlement(client.db, f.owner.workspaceId, {
      sessionId: f.target.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.turn.activeAttemptId!,
      turnStatus,
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type, payload: { reason } }],
    });
    await appendSessionEvents(client.db, f.owner.workspaceId, f.target.id, unrelated);
    const status = await f.call("session_message_status", {
      sessionId: f.target.id,
      updateId: sent.resource.id,
    });
    expect(status).toMatchObject({
      delivery: "delivered",
      turnId: claimed.turn.id,
      turnStatus,
      outcome: { type },
    });
    expect(status.nextAction).toEqual({
      tool: "session_events",
      arguments: {
        sessionId: f.target.id,
        view: "debug",
        includeTypes: [type],
        payloadMode: "full",
        after: status.outcome.sequence - 1,
        before: status.outcome.sequence + 1,
        limit: 1,
      },
    });
    const result = await f.call(status.nextAction.tool, status.nextAction.arguments);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type,
      sequence: status.outcome.sequence,
      turnId: claimed.turn.id,
      payload: { reason },
    });
    expect(JSON.stringify(result)).not.toContain("Unrelated");
  },
);

test("paused Send stays pending without implicit resume; explicit Steer uses the same receipt tracking", async () => {
  const f = await fixture();
  await withWorkspaceSessionActivityRls(client.db, f.owner.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: f.owner.accountId,
      workspaceId: f.owner.workspaceId,
      sessionId: f.target.id,
      actor: { type: "human", subjectId: f.owner.subjectId },
      operationKey: crypto.randomUUID(),
      action: "pause",
    }),
  );
  const sent = await f.call("session_send_message", {
    sessionId: f.target.id,
    text: "Later",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(sent.facts.resumeRequired).toBe(true);
  expect(
    await f.call("session_message_status", { sessionId: f.target.id, updateId: sent.resource.id }),
  ).toMatchObject({ delivery: "pending", outcome: null });
  const steered = await f.call("session_steer", {
    sessionId: f.target.id,
    instruction: "Change direction now",
    idempotencyKey: crypto.randomUUID(),
  });
  const claimed = await f.claim(f.target.id);
  expect(
    await f.call("session_message_status", {
      sessionId: f.target.id,
      updateId: steered.resource.id,
    }),
  ).toMatchObject({ delivery: "delivered", turnId: claimed.turn.id });
});
