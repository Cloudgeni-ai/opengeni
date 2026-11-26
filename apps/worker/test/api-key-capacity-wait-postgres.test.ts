import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  getSessionSystemUpdateById,
  getSubscriptionCoreCapacityWaitForSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  sendAgentMessageInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import {
  ANTHROPIC_API_KEYS_OUT_OF_CREDITS,
  AnthropicRequestError,
  createProductionAgentRuntime,
} from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { createActivityTestHarness } from "../src/activities";
import {
  API_KEY_CAPACITY_WAIT_BINDING,
  reconcileCoreCapacityWait,
} from "../src/activities/subscription-core-codex-waits";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const fixture = await acquireSharedTestDatabase("api-key-capacity-wait");
  if (!fixture) throw new Error("Real PostgreSQL is required");
  shared = fixture;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("credit refusal holds the same turn, queues incoming input and notifies only once across timed rechecks", async () => {
  const id = crypto.randomUUID();
  const subjectId = `user:${id}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "api-key-wait-test",
    accountExternalId: id,
    accountName: "API key wait",
    workspaceExternalSource: "api-key-wait-test",
    workspaceExternalId: id,
    workspaceName: "API key wait",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  async function createChat(text: string) {
    const session = await createSession(client.db, {
      ...scope,
      createdBy: { kind: "subject", subjectId },
      initialMessage: text,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      ...scope,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    return session.id;
  }

  const sessionId = await createChat("Start conversation");
  const senderId = await createChat("Send the target an update");
  const senderAttemptId = crypto.randomUUID();
  const sender = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: senderId,
    workflowId: `session-${senderId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: senderAttemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (sender.action !== "claimed") throw new Error(`Sender claim: ${sender.reason}`);
  const send = (text: string) =>
    withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (tx) =>
      sendAgentMessageInTransaction(tx, {
        ...scope,
        targetSessionId: sessionId,
        actor: {
          type: "agent_attempt",
          sessionId: senderId,
          turnId: sender.turn.id,
          executionGeneration: sender.turn.executionGeneration,
          attemptId: senderAttemptId,
        },
        operationKey: crypto.randomUUID(),
        text,
      }),
    );

  const model = new ScriptedModel([
    { outputText: "Started." },
    {
      error: new AnthropicRequestError(
        "Every Anthropic API key of this organization is out of credits.",
        402,
        ANTHROPIC_API_KEYS_OUT_OF_CREDITS,
        undefined,
        new Headers(),
      ),
    },
    { error: Object.assign(new Error("Payment required"), { status: 402 }) },
    { outputText: "Handled the first update." },
    { outputText: "Handled the queued update." },
  ]);
  const bus = new MemoryEventBus();
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    }),
    db: client.db,
    bus,
    runtime: createProductionAgentRuntime({ model }),
  });
  const workflowRunId = crypto.randomUUID();
  const run = () =>
    activities.runAgentTurn({
      ...scope,
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId,
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
  const events = () =>
    listSessionEvents(client.db, scope.workspaceId, sessionId, { after: 0, limit: 200 });
  const update = (updateId: string) =>
    getSessionSystemUpdateById(client.db, scope.workspaceId, sessionId, updateId);
  const legacyClaim = (turnId: string) =>
    shared.admin.begin(async (tx) => {
      await tx`set local opengeni.session_inference_claim = '1'`;
      await tx`update session_turns set status = 'running' where id = ${turnId}::uuid`;
    });
  const peek = () =>
    getSubscriptionCoreCapacityWaitForSession(client.db, scope.workspaceId, sessionId);
  const checkDue = async () => {
    const waiter = await peek();
    if (!waiter) throw new Error("Missing capacity waiter");
    return await reconcileCoreCapacityWait({ db: client.db, bus }, API_KEY_CAPACITY_WAIT_BINDING, {
      ...scope,
      sessionId,
      waiterId: waiter.waiterId,
      generation: waiter.generation,
      now: waiter.nextCheckAt,
    });
  };

  expect((await run()).status).toBe("idle");
  const first = await send("First input must stay attached to the exact turn");
  const parked = await run();
  expect(parked.status).toBe("waiting_capacity");
  if (parked.status !== "waiting_capacity" || !parked.capacityWait) throw new Error("No wait ref");
  expect(await getSession(client.db, scope.workspaceId, sessionId)).toMatchObject({
    status: "waiting_capacity",
    activeTurnId: parked.turnId,
  });
  expect(await update(first.updateId)).toMatchObject({ deliveredTurnId: parked.turnId });
  expect(await events()).toContainEqual(
    expect.objectContaining({
      type: "turn.capacity_waiting",
      payload: expect.objectContaining({
        waitReason: "api_key_credits_exhausted",
        quotaScope: "credits",
      }),
    }),
  );

  const second = await send("Second input must not be consumed while the target cannot run");
  expect(second.readAt).toBe("when_next_turn_starts");
  expect(await update(second.updateId)).toMatchObject({ state: "pending" });
  await expect(legacyClaim(parked.turnId)).rejects.toThrow("API key capacity claim protocol v1");
  const notDue = await activities.reconcileCodexCapacityWait({
    ...scope,
    sessionId,
    ...parked.capacityWait,
    cause: "queue",
  });
  expect(notDue).toMatchObject({ action: "waiting", nextCheckAt: parked.capacityWait.nextCheckAt });
  expect((await run()).status).toBe("unclaimed");
  expect(model.calls).toBe(2);

  expect((await checkDue())?.action).toBe("resumed");
  await expect(legacyClaim(parked.turnId)).rejects.toThrow("API key capacity claim protocol v1");
  expect(await run()).toMatchObject({ status: "waiting_capacity", turnId: parked.turnId });
  expect(await update(second.updateId)).toMatchObject({ state: "pending" });
  const stillWaiting = await events();
  expect(stillWaiting.filter((event) => event.type === "session.notification.posted")).toHaveLength(
    1,
  );
  expect(
    stillWaiting.filter((event) => event.type === "session.notification.withdrawn"),
  ).toHaveLength(0);
  expect(stillWaiting.filter((event) => event.type === "turn.failed")).toHaveLength(0);

  expect((await checkDue())?.action).toBe("resumed");
  expect(await run()).toMatchObject({ status: "idle", turnId: parked.turnId });
  expect(JSON.stringify(model.requests[3]?.input)).toContain("First input must stay attached");
  expect(JSON.stringify(model.requests[3]?.input)).not.toContain(
    "Second input must not be consumed",
  );
  expect(await peek()).toBeNull();
  expect(await update(second.updateId)).toMatchObject({ state: "pending" });
  await run();
  expect(JSON.stringify(model.requests[4]?.input)).toContain("Second input must not be consumed");
  const completed = await events();
  expect(completed.filter((event) => event.type === "session.notification.posted")).toHaveLength(1);
  expect(completed.filter((event) => event.type === "session.notification.withdrawn")).toHaveLength(
    1,
  );
  expect(completed.filter((event) => event.type === "turn.failed")).toHaveLength(0);
}, 120_000);
