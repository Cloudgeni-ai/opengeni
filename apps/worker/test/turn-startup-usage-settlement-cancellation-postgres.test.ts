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
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// Before an attempt's first model request, the worker finishes the ledger
// writes earlier attempts of the turn still owe. That read must run under the
// turn's cancellation: when it is slow or blocked in PostgreSQL, a cancelled
// or draining turn has to stop at once, and its statement must stop with it,
// never park the turn silently until the statement finally returns. Real
// worker turn path and real PostgreSQL in the production RLS posture; the
// usage ledger is held locked so only that read blocks.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("turn-usage-settlement-cancel");
  if (!acquired) throw new Error("Native PostgreSQL required for turn settlement cancellation");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function startSession() {
  const subjectId = `user:turn-usage-settlement-cancel:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "turn-usage-settlement-cancel",
    accountExternalId: crypto.randomUUID(),
    accountName: "Turn settlement cancellation",
    workspaceExternalSource: "turn-usage-settlement-cancel",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Turn settlement cancellation",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Do the task",
    resources: [],
    tools: [],
    metadata: {},
    model: "offline-model",
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

/** An offline runtime that records whether the model stream was entered. */
function offlineRuntime(): { runtime: OpenGeniRuntime; entered: () => boolean } {
  let entered = false;
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
      entered = true;
      return await never;
    },
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model,
      configured: {
        id: "offline-model",
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
  return { runtime, entered: () => entered };
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

/** Application statements of the owed-usage read now waiting on a lock. */
async function blockedSettlementReads(): Promise<number> {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and wait_event_type = 'Lock' and query like '%candidates as materialized%'`;
  return row?.count ?? 0;
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

test("a cancelled turn stops at once while the earlier-attempt usage settlement is blocked", async () => {
  const ctx = await startSession();
  const offline = offlineRuntime();
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "offline-model",
      sandboxBackend: "none",
    }),
    db: app.db,
    bus: new MemoryEventBus(),
    runtime: offline.runtime,
  });

  // Hold the usage ledger so the settlement read waits in PostgreSQL, the way
  // a slow ledger scan held real turns for many minutes.
  const locked = Promise.withResolvers<void>();
  const unlock = Promise.withResolvers<void>();
  const holder = shared.admin.begin(async (tx) => {
    await tx.unsafe(`lock table "${shared.schema}".usage_events in access exclusive mode`);
    locked.resolve();
    await unlock.promise;
  });
  holder.catch(() => undefined);
  await locked.promise;

  const cancel = new AbortController();
  try {
    const running = asyncLocalStorage.run(activityContext(cancel.signal), () =>
      activities.runAgentTurn({
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        workflowId: `session-${ctx.sessionId}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    );
    running.catch(() => undefined);
    await waitFor(async () => (await blockedSettlementReads()) > 0, "the settlement read to block");
    expect(offline.entered()).toBe(false);

    // The person cancels the turn while the read is still blocked.
    cancel.abort(new CancelledFailure("CANCELLED"));
    const outcome = await Promise.race([
      running.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
      Bun.sleep(10_000).then(() => "still-parked" as const),
    ]);
    expect(outcome).not.toBe("still-parked");
    // The activity ends as Temporal's ordinary cancellation.
    expect(outcome).toEqual({ error: expect.any(CancelledFailure) });
    expect(offline.entered()).toBe(false);
    // The blocked statement was cancelled in PostgreSQL too; nothing of the
    // cancelled turn is left waiting on the ledger.
    await waitFor(async () => (await blockedSettlementReads()) === 0, "the statement to stop");
  } finally {
    unlock.resolve();
    await holder.catch(() => undefined);
  }
});
