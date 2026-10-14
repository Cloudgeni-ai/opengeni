import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { tool } from "@openai/agents";
import * as opengeniDb from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  MemoryEventBus,
  testSettings,
  ScriptedModel,
  functionCall,
  assistantMessage,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  acceptSessionApprovalDecision,
  bootstrapWorkspace,
  checkSessionUsageLimitAdmission,
  createDb,
  createSession,
  fenceSessionUsageReceipt,
  getActiveSessionHistoryItemsPaged,
  getSession,
  getSessionGoal,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  listSessionEvents,
  maintainSessionUsageLimits,
  readSessionUsageLimit,
  setSessionUsageLimitInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { DrizzleQueryError } from "drizzle-orm";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";
import { POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE } from "../src/activities/types";
import type { ControlActivityServices } from "../src/activities/types";
import { createGoalActivities } from "../src/activities/goals";
import {
  heldSessionUsageReceiptCount,
  resetSessionUsageReceiptCustodyForTests,
} from "../src/activities/agent-turn/session-usage-custody";

// per-task usage limits through the real worker turn path, real PostgreSQL in
// the production posture (NOSUPERUSER NOBYPASSRLS migration owner, dedicated
// data schema, restricted application role, FORCE RLS) and the real SDK call
// flow with an offline ScriptedModel. No provider, network or paid model.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("session-usage-limit-worker");
  if (!acquired) throw new Error("Native PostgreSQL required for session usage limit tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:session-usage-limit:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "session-usage-limit",
    accountExternalId: crypto.randomUUID(),
    accountName: "Session usage limit",
    workspaceExternalSource: "session-usage-limit",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Session usage limit",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function startSession(
  ctx: Ctx,
  input: { goal?: string; parentSessionId?: string; message?: string } = {},
) {
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: input.message ?? "Run the local tool, then answer",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: input.goal ? { text: input.goal } : null,
  });
  return session;
}

async function setLimit(ctx: Ctx, sessionId: string, limitMicros: number | null) {
  const current = await usage(ctx, sessionId);
  const result = await withWorkspaceSubjectSessionActivityRls(
    app.db,
    ctx.workspaceId,
    ctx.subjectId,
    async (tx) =>
      await setSessionUsageLimitInTransaction(tx, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId,
        limitMicros,
        expectedVersion: current.version,
        operationId: crypto.randomUUID(),
        actor: { subjectId: ctx.subjectId, type: "human" },
        producerEnabled: true,
      }),
  );
  expect(result.outcome).toBe("ok");
}

async function usage(ctx: Ctx, sessionId: string) {
  const read = await readSessionUsageLimit(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId,
  });
  if (read.outcome !== "ok") throw new Error(`usage read ${read.outcome}`);
  return read.state;
}

async function receipts(sessionId: string) {
  return await shared.admin<
    Array<{ source_id: string; amount_micros: string | null; pricing_source: string | null }>
  >`select source_id, amount_micros, pricing_source
      from opengeni_private.session_usage_limit_receipts where source_session_id = ${sessionId}
      order by recorded_at, source_id`;
}

/** Offline runtime: the production SDK call flow over a ScriptedModel plus one local tool. */
function scriptedRuntime(scripted: ScriptedModel, gated = false): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      },
    }),
    buildAgent: (...args) => {
      const agent = production.buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline no-op",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => "local result",
        }),
      );
      if (gated) {
        agent.tools.push(
          tool({
            name: "gated_fixture",
            description: "Offline no-op that needs a person's approval",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            needsApproval: true,
            execute: async () => "gated result",
          }),
        );
      }
      return agent;
    },
  };
}

type Pricing = "priced" | "known_free" | "unpriced";

/** Self-hosted, no credits: the limit is independent of the funding path. */
function settingsFor(pricing: Pricing) {
  return testSettings({
    databaseUrl: shared.appUrl,
    openaiModel: "scripted-model",
    sandboxBackend: "none",
    // The test fixture's default catalog prices scripted-model at a configured $0.
    ...(pricing === "unpriced" ? { modelPricingJson: JSON.stringify({}) } : {}),
    ...(pricing === "priced"
      ? {
          modelPricingJson: JSON.stringify({
            "scripted-model": {
              inputMicrosPerMillionTokens: 1_000_000,
              outputMicrosPerMillionTokens: 0,
              marginBps: 5_000,
            },
          }),
        }
      : {}),
  });
}

async function runTurn(
  ctx: Ctx,
  sessionId: string,
  scripted: ScriptedModel,
  pricing: Pricing = "priced",
) {
  const activities = createActivityTestHarness({
    settings: settingsFor(pricing),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted),
  });
  return await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

async function events(ctx: Ctx, sessionId: string) {
  return await listSessionEvents(app.db, ctx.workspaceId, sessionId, { after: 0, limit: 200 });
}

function paidToolCall(id: string) {
  return {
    id,
    inputTokens: 100,
    outputText: "x",
    output: [functionCall("local_fixture", {}, `call-${id}`)],
  };
}

test("AC07/AC10: a settled response reaching the limit stops before the next dispatch as an idle non-failure, pausing the goal", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx, { goal: "Finish the fixture task" });
  await setLimit(ctx, session.id, 100);
  const scripted = new ScriptedModel([
    paidToolCall(`first-${session.id}`),
    { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
  ]);
  const result = await runTurn(ctx, session.id, scripted);

  expect(result.status).toBe("idle");
  expect(scripted.calls).toBe(1);
  // The canonical PRE-margin estimate (100 tokens at $1/M = 100 micros), not
  // the 50% margin-inclusive charge.
  const state = await usage(ctx, session.id);
  expect(state).toMatchObject({
    status: "reached",
    limitMicros: 100,
    usedMicros: 100,
    pricedCalls: 1,
    unpricedCalls: 0,
    coverage: "complete",
  });
  expect(await receipts(session.id)).toHaveLength(1);

  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(timeline.some((event) => event.type === "usage.exhausted")).toBe(false);
  const completed = timeline.filter((event) => event.type === "turn.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]!.payload).toMatchObject({
    output: "",
    segmentLimit: "session_usage_limit",
    sessionUsageLimit: {
      code: "session_usage_limit_reached",
      basis: "model_api_equivalent_v1",
      rootSessionId: session.id,
      limitMicros: 100,
      usedMicros: 100,
    },
  });
  expect(JSON.stringify(completed[0]!.payload)).not.toContain("budget_exhausted");
  // The already-admitted tool call and its output stay paired in history.
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  const items = history.map((row) => row.item as { type?: string; call_id?: string });
  expect(items.some((item) => item.type === "function_call")).toBe(true);
  expect(items.some((item) => item.type === "function_call_result")).toBe(true);
  expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "idle",
    activeTurnId: null,
  });
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });

  // AC09: raising the limit never resumes anything by itself.
  await setLimit(ctx, session.id, 10_000);
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });
  expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({ status: "idle" });
  const after = await events(ctx, session.id);
  expect(after.filter((event) => event.type === "turn.started")).toHaveLength(
    timeline.filter((event) => event.type === "turn.started").length,
  );
  expect(
    after.filter((event) => event.type === "session.usage_limit.updated").at(-1)?.payload,
  ).toMatchObject({ limitMicros: 10_000, previousLimitMicros: 100, version: 2 });
});

test("AC07: a zero limit stops the claimed start before any provider dispatch", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx, { goal: "Never starts" });
  await setLimit(ctx, session.id, 0);
  const scripted = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
  ]);
  const result = await runTurn(ctx, session.id, scripted);
  expect(result.status).toBe("idle");
  expect(scripted.calls).toBe(0);
  expect(await receipts(session.id)).toHaveLength(0);
  const timeline = await events(ctx, session.id);
  expect(timeline.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
    segmentLimit: "session_usage_limit",
    sessionUsageLimit: { limitMicros: 0, usedMicros: 0 },
  });
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });
  // No refusal loop: a second dispatch finds nothing to run and spends nothing.
  const again = await runTurn(ctx, session.id, scripted);
  expect(scripted.calls).toBe(0);
  expect(again.status as string).toBe("unclaimed");
  expect(
    (await events(ctx, session.id)).filter((event) => event.type === "turn.completed"),
  ).toHaveLength(1);
});

test("AC02/AC05: a child's usage counts against its root, and a reached root stops the child", async () => {
  const ctx = await fixture();
  const root = await startSession(ctx, { message: "Root task" });
  await setLimit(ctx, root.id, 150);
  const child = await startSession(ctx, { parentSessionId: root.id, message: "Child work" });
  const childModel = new ScriptedModel([
    paidToolCall(`child-${child.id}`),
    { inputTokens: 100, output: [assistantMessage("child done")] },
  ]);
  const childResult = await runTurn(ctx, child.id, childModel);
  // 100 recorded, below 150: the second call is admitted (no reservation),
  // and it can take the total over the limit (overshoot of admitted calls).
  expect(childModel.calls).toBe(2);
  expect(childResult.status).toBe("idle");
  const rootState = await usage(ctx, root.id);
  expect(rootState).toMatchObject({ usedMicros: 200, status: "reached", limitMicros: 150 });
  expect(await usage(ctx, child.id)).toMatchObject({
    rootSessionId: root.id,
    inherited: true,
    usedMicros: 200,
  });
  expect(await receipts(child.id)).toHaveLength(2);

  const rootModel = new ScriptedModel([
    { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
  ]);
  expect((await runTurn(ctx, root.id, rootModel)).status).toBe("idle");
  expect(rootModel.calls).toBe(0);
  expect(
    (await events(ctx, root.id)).find((event) => event.type === "turn.completed")?.payload,
  ).toMatchObject({ segmentLimit: "session_usage_limit", sessionUsageLimit: { usedMicros: 200 } });
});

test("AC13: a configured $0 model is known free; an unpriced call is disclosed and excluded", async () => {
  // Shared body below so the test reads top-down.
  await knownFreeAndUnpriced();
});

test("AC07/AC10: a root's active goal pauses through the real continuation path after a descendant exhausts the shared limit, without a wake loop or auto-resume", async () => {
  const ctx = await fixture();
  const root = await startSession(ctx, { goal: "Coordinate the child", message: "Root task" });
  await setLimit(ctx, root.id, 250);
  const rootModel = new ScriptedModel([{ inputTokens: 100, output: [assistantMessage("ok")] }]);
  expect((await runTurn(ctx, root.id, rootModel)).status).toBe("idle");
  expect(await getSessionGoal(app.db, ctx.workspaceId, root.id)).toMatchObject({
    status: "active",
  });
  const child = await startSession(ctx, { parentSessionId: root.id, message: "Child work" });
  const childModel = new ScriptedModel([
    paidToolCall(`goal-child-${child.id}`),
    { inputTokens: 100, output: [assistantMessage("child done")] },
  ]);
  await runTurn(ctx, child.id, childModel);
  expect(await usage(ctx, root.id)).toMatchObject({ usedMicros: 300, status: "reached" });

  const services = {
    db: app.db,
    bus: new MemoryEventBus(),
    settings: testSettings({
      databaseUrl: shared.appUrl,
      billingMode: "disabled",
      usageLimitsMode: "none",
      goalIdleBackoffMs: [0],
      goalIdleBackoffMaxMs: 0,
    }),
    entitlements: null,
  } as unknown as ControlActivityServices;
  const goals = createGoalActivities(async () => services);
  const continueRoot = () =>
    goals.maybeContinueGoal({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: root.id,
      workflowId: `session-${root.id}`,
    });
  expect(await continueRoot()).toEqual({ action: "paused" });
  expect(await getSessionGoal(app.db, ctx.workspaceId, root.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });
  const continuations = async () =>
    (await listOutstandingSessionSystemUpdates(app.db, ctx.workspaceId, root.id)).filter(
      (update) => update.kind === "goal_continuation",
    );
  expect(await continuations()).toEqual([]);
  // A repeated wake neither re-pauses noisily nor queues work.
  const pausedEvents = async () =>
    (await events(ctx, root.id)).filter((event) => event.type === "goal.paused").length;
  const pausedOnce = await pausedEvents();
  expect((await continueRoot()).action).not.toBe("continue");
  expect(await pausedEvents()).toBe(pausedOnce);
  expect(await continuations()).toEqual([]);
  // Raising the limit does not resume the goal by itself.
  await setLimit(ctx, root.id, 10_000);
  expect((await continueRoot()).action).not.toBe("continue");
  expect(await getSessionGoal(app.db, ctx.workspaceId, root.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });
  expect(rootModel.calls).toBe(1);
});

test("AC09: an approval given after the limit is reached resumes into a stop without another model request, keeping history paired and the goal paused", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx, {
    goal: "Needs an approval",
    message: "Use the gated tool",
  });
  await setLimit(ctx, session.id, 1_000_000);
  const scripted = new ScriptedModel([
    {
      id: `gated-${session.id}`,
      inputTokens: 100,
      outputText: "x",
      output: [functionCall("gated_fixture", {}, `gated-call-${session.id}`)],
    },
    { inputTokens: 100, output: [assistantMessage("must not dispatch after the limit")] },
  ]);
  const activities = createActivityTestHarness({
    settings: settingsFor("priced"),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted, true),
  });
  const first = await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(first.status).toBe("requires_action");
  expect(scripted.calls).toBe(1);
  // While waiting, another part of the task uses the rest of the limit.
  await setLimit(ctx, session.id, 100);
  expect(await usage(ctx, session.id)).toMatchObject({ status: "reached", usedMicros: 100 });
  const requested = (await events(ctx, session.id)).find(
    (event) => event.type === "session.requiresAction",
  );
  const approvalId = (requested?.payload as { approvals?: Array<{ id: string }> } | undefined)
    ?.approvals?.[0]?.id;
  expect(approvalId).toBeTruthy();
  const decision = await acceptSessionApprovalDecision(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    subjectId: ctx.subjectId,
    payload: { approvalId, decision: "approve" },
    clientEventId: crypto.randomUUID(),
  });
  if (decision.action !== "accepted") throw new Error(`decision ${decision.action}`);
  const resumed = await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "approval", triggerEventId: decision.event.id },
  });
  expect(resumed.status).toBe("idle");
  // No model request after the limit; usage unchanged.
  expect(scripted.calls).toBe(1);
  expect(await usage(ctx, session.id)).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(
    timeline.filter(
      (event) =>
        event.type === "turn.completed" &&
        (event.payload as { segmentLimit?: string }).segmentLimit === "session_usage_limit",
    ),
  ).toHaveLength(1);
  // The approved call is not run after the limit (the resume stopped at its
  // first admission); the timeline keeps the request and the decision, and
  // model history holds no orphaned call, so a later message continues cleanly.
  expect(timeline.some((event) => event.type === "user.approvalDecision")).toBe(true);
  expect(timeline.some((event) => event.type === "agent.toolCall.output")).toBe(false);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  const items = history.map(
    (row) => row.item as { type?: string; callId?: string; call_id?: string },
  );
  const callIds = items
    .filter((item) => item.type === "function_call")
    .map((item) => item.callId ?? item.call_id);
  const resultIds = new Set(
    items
      .filter((item) => item.type === "function_call_result")
      .map((item) => item.callId ?? item.call_id),
  );
  for (const id of callIds) expect(resultIds.has(id)).toBe(true);
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "paused",
    pausedReason: "session_usage_limit",
  });
  expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "idle",
    activeTurnId: null,
  });
});

async function knownFreeAndUnpriced() {
  const ctx = await fixture();
  const free = await startSession(ctx);
  await setLimit(ctx, free.id, 1);
  const freeModel = new ScriptedModel([
    paidToolCall(`free-${free.id}`),
    { inputTokens: 100, output: [assistantMessage("done")] },
  ]);
  expect((await runTurn(ctx, free.id, freeModel, "known_free")).status).toBe("idle");
  expect(freeModel.calls).toBe(2);
  expect(await usage(ctx, free.id)).toMatchObject({
    usedMicros: 0,
    pricedCalls: 0,
    freeCalls: 2,
    unpricedCalls: 0,
    coverage: "complete",
    status: "within",
  });
  expect((await receipts(free.id)).map((row) => [row.amount_micros, row.pricing_source])).toEqual([
    ["0", "configured_list_price"],
    ["0", "configured_list_price"],
  ]);

  const unpriced = await startSession(ctx);
  await setLimit(ctx, unpriced.id, 1);
  const unpricedModel = new ScriptedModel([
    paidToolCall(`unpriced-${unpriced.id}`),
    { inputTokens: 100, output: [assistantMessage("done")] },
  ]);
  expect((await runTurn(ctx, unpriced.id, unpricedModel, "unpriced")).status).toBe("idle");
  expect(unpricedModel.calls).toBe(2);
  expect(await usage(ctx, unpriced.id)).toMatchObject({
    usedMicros: 0,
    pricedCalls: 0,
    freeCalls: 0,
    unpricedCalls: 2,
    coverage: "partial",
    status: "within",
  });
  expect(
    (await receipts(unpriced.id)).map((row) => [row.amount_micros, row.pricing_source]),
  ).toEqual([
    [null, null],
    [null, null],
  ]);
}

function connectionClosed() {
  return new DrizzleQueryError(
    "select session_usage_limit_command($1)",
    [],
    Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" }),
  );
}

function dbFailureSourceRows(rows: Awaited<ReturnType<typeof receipts>>, sessionId: string) {
  return rows.filter((row) => row.source_id.includes(`dbfail-${sessionId}`));
}

test("F1/AC13: a one-off receipt write failure is held and written before the next request; no provider replay, recorded once", async () => {
  resetSessionUsageReceiptCustodyForTests();
  const ctx = await fixture();
  const session = await startSession(ctx);
  await setLimit(ctx, session.id, 1_000_000);
  const original = opengeniDb.settleSessionUsageReceipt;
  let failures = 0;
  const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
    async (db, input) => {
      if (input.sessionId === session.id && failures === 0) {
        failures++;
        throw connectionClosed();
      }
      return await original(db, input);
    },
  );
  const scripted = new ScriptedModel([
    paidToolCall(`dbfail-${session.id}`),
    { inputTokens: 100, output: [assistantMessage("done")] },
    { inputTokens: 100, output: [assistantMessage("must never be requested")] },
  ]);
  try {
    await runTurn(ctx, session.id, scripted);
  } finally {
    settle.mockRestore();
  }
  expect(failures).toBe(1);
  // The response was kept: the turn continued from it with exactly one more request.
  expect(scripted.calls).toBe(2);
  const rows = await receipts(session.id);
  expect(dbFailureSourceRows(rows, session.id)).toEqual([
    expect.objectContaining({ amount_micros: "100", pricing_source: "configured_list_price" }),
  ]);
  expect(rows).toHaveLength(2);
  expect(await usage(ctx, session.id)).toMatchObject({
    usedMicros: 200,
    pricedCalls: 2,
    coverage: "complete",
  });
  expect(heldSessionUsageReceiptCount(session.id)).toBe(0);
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
});

test("F1/AC13: a persistent receipt failure stops before the next request, the recovery lane writes the original receipt, and the replacement attempt does not replay the provider", async () => {
  resetSessionUsageReceiptCustodyForTests();
  const ctx = await fixture();
  const session = await startSession(ctx);
  await setLimit(ctx, session.id, 1_000_000);
  const scripted = new ScriptedModel([
    paidToolCall(`dbfail-${session.id}`),
    { inputTokens: 100, output: [assistantMessage("done")] },
    { inputTokens: 100, output: [assistantMessage("must never be requested")] },
  ]);
  const activities = createActivityTestHarness({
    settings: settingsFor("priced"),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: scriptedRuntime(scripted),
  });
  const original = opengeniDb.settleSessionUsageReceipt;
  // The task meter's database path is down for this session (every receipt
  // write fails), and the call's billing write failed too, so its durable
  // usage event carries no price for the event meter to record.
  const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
    async (db, input) => {
      if (input.sessionId === session.id) throw connectionClosed();
      return await original(db, input);
    },
  );
  const originalUsage = opengeniDb.recordUsageEvent;
  let usageFailures = 0;
  const usageWrite = spyOn(opengeniDb, "recordUsageEvent").mockImplementation(async (db, input) => {
    if (
      String(input.sourceResourceId ?? "").includes(`dbfail-${session.id}`) &&
      usageFailures === 0
    ) {
      usageFailures++;
      throw connectionClosed();
    }
    return await originalUsage(db, input);
  });
  const attemptId = crypto.randomUUID();
  let thrown: unknown;
  try {
    await activities.runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
  } catch (error) {
    thrown = error;
  } finally {
    settle.mockRestore();
    usageWrite.mockRestore();
  }
  expect(usageFailures).toBe(1);
  // Stopped before the next request: never admitted on an undercount.
  expect(scripted.calls).toBe(1);
  expect((thrown as { type?: string } | undefined)?.type).toBe(
    POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE,
  );
  const detail = (thrown as { details?: unknown[] }).details?.[0] as {
    sessionUsageReceipts?: Array<Record<string, unknown>>;
  };
  // The typed failure detail (durable in workflow history) carries the
  // content-free receipt under its original source identity.
  expect(detail.sessionUsageReceipts).toEqual([
    expect.objectContaining({
      sessionId: session.id,
      sourceId: expect.stringContaining(`dbfail-${session.id}`),
      amountMicros: 100,
      pricingSource: "configured_list_price",
    }),
  ]);
  // A different worker process handles recovery: this process's custody is gone.
  resetSessionUsageReceiptCustodyForTests();
  const lane = spyOn(opengeniDb, "settleSessionUsageReceipt");
  try {
    const recovered = await activities.failSessionAttempt({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      attemptId,
      workflowId: `session-${session.id}`,
      retryDelayMs: 1_000,
      postClaimDatabaseRecovery: detail as never,
      trigger: { kind: "next" },
      error: "post-claim database recovery",
    });
    expect((recovered as { action?: string }).action).not.toBe("stale");
    expect(lane.mock.calls.map((args) => args[1].sourceId)).toEqual([
      expect.stringContaining(`dbfail-${session.id}`),
    ]);
  } finally {
    lane.mockRestore();
  }
  // The replacement attempt continues from the kept response.
  await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(scripted.calls).toBe(2);
  const rows = await receipts(session.id);
  expect(dbFailureSourceRows(rows, session.id)).toEqual([
    expect.objectContaining({ amount_micros: "100", pricing_source: "configured_list_price" }),
  ]);
  expect(await usage(ctx, session.id)).toMatchObject({
    usedMicros: 200,
    pricedCalls: 2,
    coverage: "complete",
  });
});

test("re-review N3: a final response whose direct receipt write keeps failing completes once; its committed usage event already recorded the exact receipt", async () => {
  resetSessionUsageReceiptCustodyForTests();
  const ctx = await fixture();
  const session = await startSession(ctx, { message: "Answer directly" });
  await setLimit(ctx, session.id, 1_000_000);
  const scripted = new ScriptedModel([
    { id: `final-${session.id}`, inputTokens: 100, output: [assistantMessage("done")] },
    { inputTokens: 100, output: [assistantMessage("must never be requested")] },
  ]);
  const original = opengeniDb.settleSessionUsageReceipt;
  let directFailures = 0;
  const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
    async (db, input) => {
      if (input.sessionId === session.id) {
        directFailures++;
        throw connectionClosed();
      }
      return await original(db, input);
    },
  );
  let result: Awaited<ReturnType<typeof runTurn>>;
  try {
    result = await runTurn(ctx, session.id, scripted);
  } finally {
    settle.mockRestore();
  }
  expect(directFailures).toBe(1);
  // One request, a normal completion: no recovery, so no second request.
  expect(result.status).toBe("idle");
  expect(scripted.calls).toBe(1);
  expect(heldSessionUsageReceiptCount(session.id)).toBe(0);
  expect(await receipts(session.id)).toEqual([
    expect.objectContaining({
      source_id: expect.stringContaining(`final-${session.id}`),
      amount_micros: "100",
      pricing_source: "configured_list_price",
    }),
  ]);
  expect(await usage(ctx, session.id)).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
  const types = (await events(ctx, session.id)).map((event) => event.type);
  expect(types).toContain("turn.completed");
  expect(types).not.toContain("turn.recovery.requested");
  expect(types).not.toContain("turn.failed");
});

/** One final-answer turn with a provider response id the lossless codec must encode. */
async function codecEncodedKeyTurn(responseId: string, failDirectOnce: boolean) {
  resetSessionUsageReceiptCustodyForTests();
  const ctx = await fixture();
  const session = await startSession(ctx, { message: "Answer directly" });
  await setLimit(ctx, session.id, 1_000_000);
  const scripted = new ScriptedModel([
    { id: responseId, inputTokens: 100, output: [assistantMessage("done")] },
    { inputTokens: 100, output: [assistantMessage("must never be requested")] },
  ]);
  const original = opengeniDb.settleSessionUsageReceipt;
  let directCalls = 0;
  const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
    async (db, input) => {
      if (input.sessionId === session.id && ++directCalls === 1 && failDirectOnce) {
        throw connectionClosed();
      }
      return await original(db, input);
    },
  );
  let status: string | null = null;
  let thrown: unknown = null;
  try {
    status = (await runTurn(ctx, session.id, scripted)).status;
  } catch (error) {
    thrown = error;
  } finally {
    settle.mockRestore();
  }
  const types = (await events(ctx, session.id)).map((event) => event.type);
  const observed = {
    status,
    thrown: thrown === null ? null : String(thrown),
    calls: scripted.calls,
    held: heldSessionUsageReceiptCount(session.id),
    receipts: (await receipts(session.id)).map((row) => row.amount_micros),
    usage: await usage(ctx, session.id),
    completed: types.includes("turn.completed"),
    failed: types.includes("turn.failed"),
    recovery: types.includes("turn.recovery.requested"),
  };
  return observed;
}

test("final guard: a lone-surrogate response id over the trigger bound once encoded never loses its known usage", async () => {
  // 404 UTF-16 units decode to 1,022 bytes but are stored as a 1,122-byte
  // encoded key, which the event trigger skips; the direct write is refused.
  const observed = await codecEncodedKeyTurn(`n3-\ud800${"y".repeat(400)}`, false);
  expect(observed.calls).toBe(1);
  // Recorded once (under the digest of the stored identity), never $0 complete.
  expect(observed).toMatchObject({ status: "idle", held: 0, completed: true, failed: false });
  expect(observed.receipts).toEqual(["100"]);
  expect(observed.usage).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
});

test("final guard: a held receipt for a lone-surrogate id is not dropped because the event skipped it", async () => {
  // The decoded key fits 1,024 bytes, but the event stores a 1,122-byte
  // encoded key that the trigger skips. The hold must be written, not dropped.
  const observed = await codecEncodedKeyTurn(`n3h-\ud800${"x".repeat(399)}`, true);
  expect(observed.calls).toBe(1);
  expect(observed).toMatchObject({ status: "idle", held: 0, completed: true, failed: false });
  expect(observed.receipts).toEqual(["100"]);
  expect(observed.usage).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
});

test("final guard: a short lone-surrogate response id is not treated as metered under its raw identity", async () => {
  const observed = await codecEncodedKeyTurn(`n3s-\ud800${"z".repeat(95)}`, false);
  expect(observed.calls).toBe(1);
  // The event trigger and the direct writer share the stored identity: once.
  expect(observed).toMatchObject({ status: "idle", held: 0, completed: true, failed: false });
  expect(observed.receipts).toEqual(["100"]);
  expect(observed.usage).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
});

test("final guard: a response id carrying the codec prefix is never counted as zero", async () => {
  const observed = await codecEncodedKeyTurn(
    `opengeni_lossless_json_string_v2_81f06e15:${"p".repeat(40)}`,
    true,
  );
  expect(observed.calls).toBe(1);
  // The held receipt is kept (the key is stored encoded) and its retry
  // deduplicates against the event's receipt: counted exactly once.
  expect(observed).toMatchObject({ status: "idle", held: 0, completed: true, failed: false });
  expect(observed.receipts).toEqual(["100"]);
  expect(observed.usage).toMatchObject({ usedMicros: 100, pricedCalls: 1 });
});

/** A runtime whose tool emulates a sandbox single model call that leaves a marker owed. */
function custodyMarkerRuntime(
  scripted: ScriptedModel,
  ctx: Ctx,
  sessionId: string,
  sourceId: string,
  leave: "fenced" | "overdue",
): OpenGeniRuntime {
  const base = scriptedRuntime(scripted);
  return {
    ...base,
    buildAgent: (...args) => {
      const agent = base.buildAgent(...args);
      const index = agent.tools.findIndex((t) => (t as { name?: string }).name === "local_fixture");
      agent.tools.splice(
        index,
        1,
        tool({
          name: "local_fixture",
          description: "Offline: a single model call whose receipt is still owed",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            const admitted = await checkSessionUsageLimitAdmission(app.db, {
              accountId: ctx.accountId,
              workspaceId: ctx.workspaceId,
              sessionId,
              runtime: true,
              openSourceId: sourceId,
            });
            expect(admitted.allowed).toBe(true);
            if (leave === "fenced") {
              await fenceSessionUsageReceipt(app.db, {
                accountId: ctx.accountId,
                workspaceId: ctx.workspaceId,
                sessionId,
                sourceId,
              });
            } else {
              // Its owner died: the open marker is past the overdue window.
              await shared.admin`update opengeni_private.session_usage_limit_receipts
                set recorded_at = now() - interval '16 minutes'
                where source_id = ${sourceId}`;
            }
            return "local result";
          },
        }),
      );
      return agent;
    },
  };
}

async function runWith(
  ctx: Ctx,
  sessionId: string,
  runtime: OpenGeniRuntime,
  attemptId: string = crypto.randomUUID(),
) {
  const activities = createActivityTestHarness({
    settings: settingsFor("priced"),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime,
  });
  return await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
}

for (const leave of ["fenced", "overdue"] as const) {
  test(`re-review N1: a ${leave} single-call marker found mid-turn parks the turn as recovering (not failed), keeps history and goal, and continues without replay once resolved`, async () => {
    resetSessionUsageReceiptCustodyForTests();
    const ctx = await fixture();
    const session = await startSession(ctx, { goal: "Finish the task" });
    await setLimit(ctx, session.id, 1_000_000);
    const sourceId = `model_call:custody-${leave}-${crypto.randomUUID()}`;
    const scripted = new ScriptedModel([
      paidToolCall(`custody-${session.id}`),
      { inputTokens: 100, output: [assistantMessage("done")] },
      { inputTokens: 100, output: [assistantMessage("must never be requested")] },
    ]);
    const runtime = custodyMarkerRuntime(scripted, ctx, session.id, sourceId, leave);
    const first = await runWith(ctx, session.id, runtime);
    expect(first.status).toBe("recovering");
    expect((first as { continueDelayMs?: number }).continueDelayMs).toBeGreaterThan(0);
    expect(scripted.calls).toBe(1);
    expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
      status: "recovering",
    });
    const parked = await events(ctx, session.id);
    expect(parked.some((event) => event.type === "turn.failed")).toBe(false);
    expect(parked.find((event) => event.type === "turn.recovery.requested")?.payload).toMatchObject(
      { reason: "session_usage_custody_pending" },
    );
    expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
      status: "active",
    });
    const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
    expect(JSON.stringify(history)).toContain("local result");
    // While the marker is still owed, the replacement attempt re-checks
    // admission at claim (database reads only), sends no request and parks
    // the same turn again with the bounded delay; it is never failed.
    const waiting = await runWith(ctx, session.id, runtime);
    expect(waiting).toMatchObject({ status: "recovering", continueDelayMs: 30_000 });
    expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
      status: "recovering",
    });
    expect(scripted.calls).toBe(1);
    if (leave === "fenced") {
      // The owner fills its receipt.
      await opengeniDb.settleSessionUsageReceipt(app.db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: session.id,
        sourceId,
        turnId: null,
        amountMicros: 50,
        pricingSource: "configured_list_price",
        model: "scripted-model",
      });
    } else {
      // Maintenance discloses the dead owner's call as unpriced.
      await shared.admin`update opengeni_private.session_usage_limit_receipts
        set recorded_at = now() - interval '31 minutes' where source_id = ${sourceId}`;
      const maintained = await maintainSessionUsageLimits(app.db, { limit: 50, budget: 50 });
      expect(maintained.resolvedLost).toBeGreaterThanOrEqual(1);
    }
    const resumed = await runWith(ctx, session.id, runtime);
    expect(resumed.status).toBe("idle");
    // Exactly the one request that was blocked: nothing replayed.
    expect(scripted.calls).toBe(2);
    expect(await usage(ctx, session.id)).toMatchObject(
      leave === "fenced"
        ? { usedMicros: 250, pricedCalls: 3, unpricedCalls: 0 }
        : { usedMicros: 200, pricedCalls: 2, unpricedCalls: 1, coverage: "partial" },
    );
    const timeline = (await events(ctx, session.id)).map((event) => event.type);
    expect(timeline).not.toContain("turn.failed");
    expect(timeline).toContain("turn.completed");
  });
}
