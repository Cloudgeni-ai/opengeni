import { getSettings, retryStartupDependency, startupRetryOptions, type Settings } from "@opengeni/config";
import { createObservability, logStartupDependencyRetry, type Observability } from "@opengeni/observability";
import { Connection, ScheduleAlreadyRunning, ScheduleOverlapPolicy, Client as TemporalClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { createActivities, type ActivityDependencies } from "./activities";
import type { WakeSessionWorkflowSignal } from "./activities/types";

// The deterministic id of the ONE global reaper Schedule. A single id means
// create() is idempotent across every worker in the pool: the first worker to
// boot creates it, all others collide on this id (ScheduleAlreadyRunning) and
// no-op — so the Schedule is registered EXACTLY ONCE per deployment regardless
// of replica count.
const SANDBOX_REAPER_SCHEDULE_ID = "opengeni-sandbox-lease-reaper";

export type WorkerOptions = {
  settings?: Settings;
  activities?: ReturnType<typeof createActivities>;
  activityDependencies?: ActivityDependencies;
  // Embedded hosts install @opengeni/worker-bundle under node_modules, where
  // Temporal's workflow webpack refuses to transpile TS. They relocate
  // src/workflows.ts to a host-owned path and point the worker at it here.
  // Unset (standalone) keeps today's in-package path byte-for-byte.
  workflowsPath?: string;
};

export async function createOpenGeniWorker(options: WorkerOptions = {}): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const settings = options.settings ?? getSettings();
  const observability = options.activityDependencies?.observability ?? createObservability(settings, { component: "worker" });
  const connection = await retryStartupDependency(
    "Temporal",
    () => NativeConnection.connect({ address: settings.temporalHost }),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  const activities = options.activities ?? createActivities({
    ...options.activityDependencies,
    settings,
    observability,
  });
  const worker = await Worker.create({
    connection,
    namespace: settings.temporalNamespace,
    taskQueue: settings.temporalTaskQueue,
    workflowsPath: options.workflowsPath ?? new URL("../src/workflows.ts", import.meta.url).pathname,
    activities,
  });
  return { worker, connection };
}

// A signalWithStart capability so a worker activity can wake a PARENT
// session's workflow when a spawned worker completes (the parent may have
// idled and let its run finish, so a plain signal would not start one).
// Separate from the worker's NativeConnection: the @temporalio/client
// Connection is what exposes workflow.signalWithStart.
export async function createWorkerWorkflowSignaler(settings: Settings): Promise<{ wakeSessionWorkflow: WakeSessionWorkflowSignal; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  return {
    wakeSessionWorkflow: async ({ accountId, workspaceId, sessionId, workflowId }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ accountId, workspaceId, sessionId }],
        signal: "queueChanged",
      });
    },
    close: async () => {
      await connection.close();
    },
  };
}

/**
 * Register the ONE global reaper Temporal Schedule (the sole liveness/GC/cost-stop
 * driver — P1.3 / OD-3). Gated on sandboxOwnershipEnabled: with the flag off the
 * Schedule is never created, so the lease feature is fully dark (no sweeps, no
 * terminates).
 *
 * The Schedule fires sandboxReaperWorkflow on the worker's global task queue
 * every settings.sandboxLeaseReaperPeriodMs (the SAME cadence the boot invariant
 * `reaperPeriod < viewerHolderTTL` and `reaperPeriod + idleGrace < providerLifetime`
 * validates in packages/config — wiring the schedule period to it). SKIP overlap means a slow
 * sweep never overlaps itself. Idempotent: a duplicate scheduleId across the
 * worker pool collides on ScheduleAlreadyRunning and no-ops, so the Schedule is
 * registered exactly once per deployment.
 *
 * Returns a `close()` for the dedicated client connection (separate from the
 * worker's NativeConnection — the Schedule client is a @temporalio/client).
 */
export async function registerSandboxReaperSchedule(
  settings: Settings,
  observability: Observability,
): Promise<{ registered: boolean; close: () => Promise<void> }> {
  if (!settings.sandboxOwnershipEnabled) {
    return { registered: false, close: async () => {} };
  }
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  try {
    await temporal.schedule.create({
      scheduleId: SANDBOX_REAPER_SCHEDULE_ID,
      spec: {
        // @every-style interval: fire once per reaper period. The boot invariant
        // (config) guarantees reaperPeriod < viewerHolderTTL and
        // reaperPeriod + idleGrace < providerLifetime.
        intervals: [{ every: settings.sandboxLeaseReaperPeriodMs }],
      },
      action: {
        type: "startWorkflow",
        workflowType: "sandboxReaperWorkflow",
        taskQueue: settings.temporalTaskQueue,
        args: [],
      },
      policies: {
        // A slow sweep must never overlap itself; the next fire is skipped.
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: "1m",
        pauseOnFailure: false,
      },
    });
    observability.info("Registered the global sandbox-lease reaper Schedule", {
      scheduleId: SANDBOX_REAPER_SCHEDULE_ID,
      reaperPeriodMs: settings.sandboxLeaseReaperPeriodMs,
    });
    return { registered: true, close: async () => { await connection.close(); } };
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      // Another worker in the pool already created it. The Schedule exists
      // exactly once — this is the expected no-op on every replica after the
      // first. (We do NOT update the spec here: a redeploy with a changed cadence
      // is an operational concern handled by deleting+recreating the Schedule.)
      observability.info("Global sandbox-lease reaper Schedule already registered", {
        scheduleId: SANDBOX_REAPER_SCHEDULE_ID,
      });
      return { registered: false, close: async () => { await connection.close(); } };
    }
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export async function startWorker() {
  const settings = getSettings();
  const observability = createObservability(settings, { component: "worker" });
  const signaler = await retryStartupDependency(
    "Temporal client",
    () => createWorkerWorkflowSignaler(settings),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  const { worker, connection } = await createOpenGeniWorker({
    settings,
    activityDependencies: { observability, wakeSessionWorkflow: signaler.wakeSessionWorkflow },
  });
  // Register the ONE global reaper Schedule (no-op when sandboxOwnershipEnabled
  // is false). Idempotent across the pool: only the first worker creates it. The
  // static global-queue Worker.create above is UNCHANGED — there is no
  // per-session worker factory.
  const reaperSchedule = await retryStartupDependency(
    "Temporal schedule (sandbox reaper)",
    () => registerSandboxReaperSchedule(settings, observability),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  observability.info("OpenGeni worker listening", {
    temporalTaskQueue: settings.temporalTaskQueue,
  });
  try {
    await worker.run();
  } finally {
    await connection.close();
    await signaler.close();
    await reaperSchedule.close();
  }
}

if (import.meta.main) {
  await startWorker();
}
