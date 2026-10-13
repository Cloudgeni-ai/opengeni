import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { tool } from "@openai/agents";
import * as opengeniDb from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  ScriptedModel,
  functionCall,
  assistantMessage,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  getSession,
  getSessionGoal,
  initializeSessionStartAtomically,
  listSessionEvents,
  readSessionUsageLimit,
  setSessionUsageLimitInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { DrizzleQueryError } from "drizzle-orm";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";
import { POST_CLAIM_DATABASE_RECOVERY_FAILURE_TYPE } from "../src/activities/types";
import {
  heldSessionUsageReceiptCount,
  resetSessionUsageReceiptCustodyForTests,
} from "../src/activities/agent-turn/session-usage-custody";

// per-task usage limits through the real worker turn path, real
// PostgreSQL (non-bypass application role, FORCE RLS) and the real SDK call
// flow with an offline ScriptedModel. No provider, network or paid model.
setDefaultTimeout(120_000);
let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-usage-limit-worker");
  if (!acquired) throw new Error("Native PostgreSQL required for session usage limit tests");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
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
function scriptedRuntime(scripted: ScriptedModel): OpenGeniRuntime {
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
});

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
  // write fails); everything else keeps working.
  const settle = spyOn(opengeniDb, "settleSessionUsageReceipt").mockImplementation(
    async (db, input) => {
      if (input.sessionId === session.id) throw connectionClosed();
      return await original(db, input);
    },
  );
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
  }
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
