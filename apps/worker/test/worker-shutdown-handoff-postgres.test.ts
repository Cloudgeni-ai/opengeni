import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Model, ModelResponse, StreamEvent } from "@openai/agents";
import { asyncLocalStorage, CancelledFailure, Context } from "@temporalio/activity";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";
import { WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS } from "../src/worker-shutdown";

// A rolling deploy cancels the turns still running on a draining worker with
// WORKER_SHUTDOWN, a few seconds before the worker is force-stopped. A turn
// parked in a wait that never observes that cancellation (an unanswered
// Connected Machine, a provider call without a signal) must still be handed
// off inside that window: closed as recoverable with reason worker_shutdown
// and quiesced, so the next attempt starts at once instead of waiting for the
// heartbeat timeout and the old attempt's subscription lease. Real worker turn
// path and real PostgreSQL in the production RLS posture; offline model.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("worker-shutdown-handoff");
  if (!acquired) throw new Error("Native PostgreSQL required for worker shutdown handoff tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function startSession() {
  const subjectId = `user:worker-shutdown-handoff:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "worker-shutdown-handoff",
    accountExternalId: crypto.randomUUID(),
    accountName: "Worker shutdown handoff",
    workspaceExternalSource: "worker-shutdown-handoff",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Worker shutdown handoff",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Do the long task",
    resources: [],
    tools: [],
    metadata: {},
    model: "stuck-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return { ...ctx, sessionId: session.id };
}

/**
 * A runtime whose run never answers and never looks at its cancellation, like
 * a provider or machine call parked on a connection that is gone.
 */
function stuckRuntime(): { runtime: OpenGeniRuntime; entered: Promise<void> } {
  const entered = Promise.withResolvers<void>();
  const never = new Promise<never>(() => undefined);
  const model: Model = {
    getResponse: async (): Promise<ModelResponse> => await never,
    getStreamedResponse: (): AsyncIterable<StreamEvent> => ({
      [Symbol.asyncIterator]: () => ({ next: async () => await never }),
    }),
  };
  const production = createProductionAgentRuntime({ model });
  const runtime: OpenGeniRuntime = {
    ...production,
    configure: () => {},
    runStream: async () => {
      entered.resolve();
      return await never;
    },
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model,
      configured: {
        id: "stuck-model",
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
  };
  return { runtime, entered: entered.promise };
}

/** The Temporal activity context a turn worker gives runAgentTurn. */
function activityContext(signal: AbortSignal): Context {
  const cancelled = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  cancelled.catch(() => undefined);
  const info = {
    activityId: "1",
    activityType: "runAgentTurn",
    attempt: 1,
    heartbeatTimeoutMs: 120_000,
    isLocal: false,
    taskQueue: "turns",
  } as unknown as Context["info"];
  const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} };
  return new Context(
    info,
    cancelled,
    signal,
    () => undefined,
    undefined,
    log as unknown as Context["log"],
    undefined as unknown as Context["metricMeter"],
    {} as never,
  );
}

test("a turn stuck in a wait that ignores cancellation is still handed off at worker shutdown", async () => {
  const ctx = await startSession();
  const stuck = stuckRuntime();
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "stuck-model",
      sandboxBackend: "none",
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: stuck.runtime,
  });
  const attemptId = crypto.randomUUID();
  const shutdown = new AbortController();
  const running = asyncLocalStorage.run(activityContext(shutdown.signal), () =>
    activities.runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      workflowId: `session-${ctx.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    }),
  );
  running.catch(() => undefined);
  await stuck.entered;

  // The worker drains: Temporal cancels the still-running turn with
  // WORKER_SHUTDOWN and force-stops the worker this long afterwards at the
  // earliest. The turn must be handed off inside that window.
  shutdown.abort(new CancelledFailure("WORKER_SHUTDOWN"));
  const forceStopped = Symbol("force-stopped");
  const settled = await Promise.race([
    running,
    Bun.sleep(WORKER_SHUTDOWN_MIN_CHECKPOINT_WINDOW_MS).then(() => forceStopped),
  ]);
  expect(settled).not.toBe(forceStopped);
  expect(settled).toMatchObject({ status: "recovering", attemptId });

  const recoveries = (
    await listSessionEvents(app.db, ctx.workspaceId, ctx.sessionId, { after: 0, limit: 500 })
  ).filter((event) => event.type === "turn.recovery.requested");
  expect(recoveries.map((event) => event.payload)).toEqual([
    expect.objectContaining({ reason: "worker_shutdown" }),
  ]);
  // Closed as a graceful handoff and quiesced: the next attempt is admitted
  // at once, and no subscription lease of this attempt holds the turn.
  const [closed] = await shared.admin<
    Array<{ state: string; outcome: string | null; quiesced: boolean }>
  >`select state, outcome, quiesced_at is not null as quiesced
      from session_turn_attempts where id = ${attemptId}::uuid`;
  expect(closed).toEqual({ state: "closed", outcome: "interrupted_recoverable", quiesced: true });
});
