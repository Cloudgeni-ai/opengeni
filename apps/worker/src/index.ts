import {
  dbSearchPath,
  getSettings,
  resolveNatsControlPlaneAuth,
  retryStartupDependency,
  startupRetryOptions,
  type Settings,
} from "@opengeni/config";
import { createDb, markSessionWorkflowWakeDelivered, type Database } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import {
  createObservability,
  logStartupDependencyRetry,
  type Observability,
} from "@opengeni/observability";
import {
  Connection,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  Client as TemporalClient,
} from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { ensureModalRegistryImage } from "@opengeni/runtime";
import {
  createControlActivities,
  createTurnActivities,
  type ActivityDependencies,
} from "./activities";
import type { SignalCodexCapacityWorkflow, WakeSessionWorkflowSignal } from "./activities/types";
import { turnTaskQueue } from "./workflows/activities";
import { dbReadyCheck, natsReadyCheck, startWorkerHttpServer } from "./http";
import { observabilityEventLogger } from "./observability-metrics";
import {
  SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
  SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
  SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE,
} from "@opengeni/core";
import {
  CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
  CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
  TURN_WORKER_MAX_CONCURRENT_TURNS,
} from "./concurrency";

// The deterministic id of the ONE global reaper Schedule. A single id means
// create() is idempotent across every worker in the pool: the first worker to
// boot creates it, all others collide on this id (ScheduleAlreadyRunning) and
// no-op — so the Schedule is registered EXACTLY ONCE per deployment regardless
// of replica count.
const SANDBOX_REAPER_SCHEDULE_ID = "opengeni-sandbox-lease-reaper";
export const FILE_UPLOAD_REAPER_SCHEDULE_ID = "opengeni-file-upload-reaper";
export const FILE_UPLOAD_REAPER_PERIOD_MS = 15 * 60 * 1_000;
export type OpenGeniWorkerRole = "control" | "turn";

export type WorkerOptions = {
  role: OpenGeniWorkerRole;
  settings?: Settings;
  activities?: ReturnType<typeof createControlActivities> | ReturnType<typeof createTurnActivities>;
  activityDependencies?: ActivityDependencies;
  // Embedded hosts install @opengeni/worker-bundle under node_modules, where
  // Temporal's workflow webpack refuses to transpile TS. They relocate
  // src/workflows.ts to a host-owned path and point the worker at it here.
  // Unset (standalone) keeps today's in-package path byte-for-byte.
  workflowsPath?: string;
};

export async function createOpenGeniWorker(options: WorkerOptions): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const settings = options.settings ?? getSettings();
  const observability =
    options.activityDependencies?.observability ??
    createObservability(settings, { component: `worker-${options.role}` });
  // Pre-resolve a PRIVATE-registry sandbox image before any turn creates a box.
  // No-op unless OPENGENI_MODAL_IMAGE_REGISTRY_SECRET + OPENGENI_MODAL_IMAGE_REF are
  // both set (so non-modal / public-image deployments are byte-unchanged and never
  // load the modal SDK here). Memoized in the provider, so this runs once per process.
  if (options.role === "turn") {
    await retryStartupDependency(
      "Modal private-registry image",
      () => ensureModalRegistryImage(settings),
      {
        ...startupRetryOptions(settings),
        onRetry: (event) => logStartupDependencyRetry(observability, event),
      },
    );
  }
  const connection = await retryStartupDependency(
    "Temporal",
    () => NativeConnection.connect({ address: settings.temporalHost }),
    {
      ...startupRetryOptions(settings),
      onRetry: (event) => logStartupDependencyRetry(observability, event),
    },
  );
  const activities =
    options.activities ??
    (options.role === "control" ? createControlActivities : createTurnActivities)({
      ...options.activityDependencies,
      settings,
      observability,
    });
  const worker = await Worker.create({
    connection,
    namespace: settings.temporalNamespace,
    taskQueue:
      options.role === "control"
        ? settings.temporalTaskQueue
        : turnTaskQueue(settings.temporalTaskQueue),
    ...(options.role === "control"
      ? {
          workflowsPath:
            options.workflowsPath ?? new URL("../src/workflows.ts", import.meta.url).pathname,
          maxConcurrentWorkflowTaskExecutions: CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS,
        }
      : {}),
    activities,
    maxConcurrentActivityTaskExecutions:
      options.role === "turn"
        ? TURN_WORKER_MAX_CONCURRENT_TURNS
        : CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
    // Cancellation is delivered through an activity heartbeat. The SDK would
    // otherwise throttle a two-minute heartbeat timeout to its 60-second cap,
    // making Pause/Steer take roughly a minute even though runAgentTurn emits a
    // heartbeat every ten seconds. Keep delivery bounded independently of the
    // heartbeat timeout and local timer cadence.
    maxHeartbeatThrottleInterval: "5s",
    defaultHeartbeatThrottleInterval: "5s",
    // GRACEFUL DEPLOY SHUTDOWN (with the SIGTERM handler in startWorker):
    // after shutdown() stops polling, in-flight activities get this long to
    // finish naturally; the rest are then CANCELLED with WORKER_SHUTDOWN —
    // which triggers agent-turn's same-turn recovery checkpoint instead of a
    // heartbeat-timeout worker_death. Short on purpose: a long grace here
    // only delays the checkpoint window long turns actually need.
    shutdownGraceTime: "5s",
    // Hard ceiling INSIDE the pod's terminationGracePeriodSeconds (120s): a
    // wedged checkpoint force-stops here, on our terms, rather than riding
    // into the kubelet's SIGKILL mid-DB-write.
    shutdownForceTime: "100s",
  });
  return { worker, connection };
}

// A signalWithStart capability so a worker activity can wake a PARENT
// session's workflow when a spawned worker completes (the parent may have
// idled and let its run finish, so a plain signal would not start one).
// Separate from the worker's NativeConnection: the @temporalio/client
// Connection is what exposes workflow.signalWithStart.
export async function createWorkerWorkflowSignaler(
  settings: Settings,
  db: Database,
): Promise<{
  wakeSessionWorkflow: WakeSessionWorkflowSignal;
  signalCodexCapacityWorkflow: SignalCodexCapacityWorkflow;
  check: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  return {
    wakeSessionWorkflow: async ({
      accountId,
      workspaceId,
      sessionId,
      workflowId,
      wakeRevision,
      interruptionRequested,
    }) => {
      if (interruptionRequested) {
        await temporal.workflow.signalWithStart("sessionWorkflow", {
          taskQueue: settings.temporalTaskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [{ accountId, workspaceId, sessionId }],
          signal: "sessionControl",
          signalArgs: [],
        });
      } else {
        await temporal.workflow.signalWithStart("sessionWorkflow", {
          taskQueue: settings.temporalTaskQueue,
          workflowId,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [{ accountId, workspaceId, sessionId }],
          signal: "queueChanged",
        });
      }
      await markSessionWorkflowWakeDelivered(db, {
        accountId,
        workspaceId,
        sessionId,
        temporalWorkflowId: workflowId,
        wakeRevision,
      });
    },
    signalCodexCapacityWorkflow: async ({
      accountId,
      workspaceId,
      sessionId,
      workflowId,
      wakeRevision,
    }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ accountId, workspaceId, sessionId }],
        signal: "codexCapacityChanged",
        signalArgs: [wakeRevision],
      });
      // A typed capacity signal cannot acknowledge the generic outbox row:
      // another producer may have advanced it with a Pause/Steer that requires
      // sessionControl. The global dispatcher owns that acknowledgement.
    },
    check: async () => {
      await connection.workflowService.getSystemInfo({});
    },
    close: async () => {
      await connection.close();
    },
  };
}

/**
 * Register the ONE global reaper Temporal Schedule (the sole liveness/GC/cost-stop
 * driver — P1.3 / OD-3) and durable system-update outbox repair cadence. With
 * sandbox ownership off the activity performs only bounded DB outbox repair;
 * it never reads/terminates sandbox leases.
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
    return {
      registered: true,
      close: async () => {
        await connection.close();
      },
    };
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      // Another worker in the pool already created it. The Schedule exists
      // exactly once — this is the expected no-op on every replica after the
      // first. (We do NOT update the spec here: a redeploy with a changed cadence
      // is an operational concern handled by deleting+recreating the Schedule.)
      observability.info("Global sandbox-lease reaper Schedule already registered", {
        scheduleId: SANDBOX_REAPER_SCHEDULE_ID,
      });
      return {
        registered: false,
        close: async () => {
          await connection.close();
        },
      };
    }
    await connection.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Register the one provider-neutral expired direct-upload cleanup Schedule.
 * Unlike sandbox GC this is always registered: file uploads can be enabled in
 * deployments where sandbox ownership is disabled. The activity is a cheap
 * no-op when object storage is not configured.
 */
export async function registerFileUploadReaperSchedule(
  settings: Settings,
  observability: Observability,
): Promise<{ registered: boolean; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  try {
    await temporal.schedule.create({
      scheduleId: FILE_UPLOAD_REAPER_SCHEDULE_ID,
      spec: { intervals: [{ every: FILE_UPLOAD_REAPER_PERIOD_MS }] },
      action: {
        type: "startWorkflow",
        workflowType: "fileUploadReaperWorkflow",
        taskQueue: settings.temporalTaskQueue,
        args: [],
      },
      policies: {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: "1m",
        pauseOnFailure: false,
      },
    });
    observability.info("Registered the global file-upload reaper Schedule", {
      scheduleId: FILE_UPLOAD_REAPER_SCHEDULE_ID,
      reaperPeriodMs: FILE_UPLOAD_REAPER_PERIOD_MS,
    });
    return { registered: true, close: async () => connection.close() };
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      observability.info("Global file-upload reaper Schedule already registered", {
        scheduleId: FILE_UPLOAD_REAPER_SCHEDULE_ID,
      });
      return { registered: false, close: async () => connection.close() };
    }
    await connection.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Register the one repair cadence for committed workflow-wake revisions. The
 * activity only reads the transactional outbox and sends revision-scoped
 * signals; it is independent of sandbox ownership and child-agent features.
 */
export async function registerSessionWorkflowWakeDispatcherSchedule(
  settings: Settings,
  observability: Observability,
): Promise<{ registered: boolean; close: () => Promise<void> }> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({ connection, namespace: settings.temporalNamespace });
  try {
    await temporal.schedule.create({
      scheduleId: SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
      spec: { intervals: [{ every: SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS }] },
      action: {
        type: "startWorkflow",
        workflowType: SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE,
        taskQueue: settings.temporalTaskQueue,
        args: [],
      },
      policies: {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: "1m",
        pauseOnFailure: false,
      },
    });
    observability.info("Registered the session-workflow wake dispatcher Schedule", {
      scheduleId: SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
      periodMs: SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
    });
    return { registered: true, close: async () => connection.close() };
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      observability.info("Session-workflow wake dispatcher Schedule already registered", {
        scheduleId: SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
      });
      return { registered: false, close: async () => connection.close() };
    }
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export async function startWorker() {
  const role = process.env.OPENGENI_WORKER_ROLE;
  if (role !== "control" && role !== "turn") {
    throw new Error("OPENGENI_WORKER_ROLE must be explicitly set to 'control' or 'turn'");
  }
  const settings = getSettings();
  const observability = createObservability(settings, { component: `worker-${role}` });
  const retryOptions = startupRetryOptions(settings);
  const onRetry = (event: Parameters<typeof logStartupDependencyRetry>[1]) =>
    logStartupDependencyRetry(observability, event);
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
  let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;
  let signaler: Awaited<ReturnType<typeof createWorkerWorkflowSignaler>> | undefined;
  let workerBundle: Awaited<ReturnType<typeof createOpenGeniWorker>> | undefined;
  let reaperSchedule: Awaited<ReturnType<typeof registerSandboxReaperSchedule>> | undefined;
  let fileUploadReaperSchedule:
    | Awaited<ReturnType<typeof registerFileUploadReaperSchedule>>
    | undefined;
  let workflowWakeDispatcherSchedule:
    | Awaited<ReturnType<typeof registerSessionWorkflowWakeDispatcherSchedule>>
    | undefined;
  let httpServer: ReturnType<typeof startWorkerHttpServer> | undefined;
  try {
    bus = await retryStartupDependency(
      "NATS",
      () =>
        createNatsEventBus(
          settings.natsUrl,
          controlPlaneAuth
            ? { user: controlPlaneAuth.user, pass: controlPlaneAuth.password }
            : undefined,
          { logger: observabilityEventLogger(observability) },
        ),
      { ...retryOptions, onRetry },
    );
    signaler = await retryStartupDependency(
      "Temporal client",
      () => createWorkerWorkflowSignaler(settings, dbClient.db),
      { ...retryOptions, onRetry },
    );
    workerBundle = await createOpenGeniWorker({
      role,
      settings,
      activityDependencies: {
        observability,
        wakeSessionWorkflow: signaler.wakeSessionWorkflow,
        signalCodexCapacityWorkflow: signaler.signalCodexCapacityWorkflow,
        db: dbClient.db,
        bus,
      },
    });
    httpServer = startWorkerHttpServer({
      settings,
      observability,
      checks: {
        db: dbReadyCheck(dbClient.db),
        nats: natsReadyCheck(bus),
        temporal: signaler.check,
      },
    });
    // Control workers alone own global schedules. Turn workers poll only the
    // bounded inference activity queue and can never duplicate schedule setup.
    if (role === "control") {
      reaperSchedule = await retryStartupDependency(
        "Temporal schedule (sandbox reaper)",
        () => registerSandboxReaperSchedule(settings, observability),
        { ...retryOptions, onRetry },
      );
      fileUploadReaperSchedule = await retryStartupDependency(
        "Temporal schedule (file upload reaper)",
        () => registerFileUploadReaperSchedule(settings, observability),
        { ...retryOptions, onRetry },
      );
      workflowWakeDispatcherSchedule = await retryStartupDependency(
        "Temporal schedule (session-workflow wake dispatcher)",
        () => registerSessionWorkflowWakeDispatcherSchedule(settings, observability),
        { ...retryOptions, onRetry },
      );
    }
    observability.info("OpenGeni worker listening", {
      role,
      temporalTaskQueue:
        role === "control" ? settings.temporalTaskQueue : turnTaskQueue(settings.temporalTaskQueue),
      maxConcurrentActivityTaskExecutions:
        role === "turn"
          ? TURN_WORKER_MAX_CONCURRENT_TURNS
          : CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
      maxConcurrentWorkflowTaskExecutions:
        role === "control" ? CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS : 0,
      httpPort: settings.workerHttpPort,
    });
    // GRACEFUL DEPLOY SHUTDOWN — the missing link that made every deploy a
    // worker_death. The worker is the container's MAIN process (PID 1), and a
    // PID-1 process with no explicit handler IGNORES SIGTERM: the pod sat
    // through the entire terminationGracePeriodSeconds doing nothing, then the
    // kubelet SIGKILLed it — so agent-turn's worker-shutdown checkpoint path
    // (same-turn recovery + run-state save) never once ran in production
    // (forensics 2026-07-06: every observed recovery was
    // reason=worker_death). This handler starts the drain the moment k8s asks:
    // shutdown() stops polling, then (per shutdownGraceTime/ForceTime above)
    // cancels in-flight activities with WORKER_SHUTDOWN so long turns
    // checkpoint INSIDE the grace window. run() resolves once
    // drained and the finally below closes connections cleanly.
    let shutdownRequested = false;
    const requestShutdown = (signal: string) => {
      if (shutdownRequested) {
        return;
      }
      shutdownRequested = true;
      observability.info("OpenGeni worker draining (graceful shutdown)", { signal });
      try {
        workerBundle!.worker.shutdown();
      } catch (error) {
        observability.warn("worker shutdown request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));
    process.on("SIGINT", () => requestShutdown("SIGINT"));
    await workerBundle.worker.run();
  } finally {
    httpServer?.stop(true);
    await Promise.allSettled([
      workerBundle?.connection.close(),
      signaler?.close(),
      reaperSchedule?.close(),
      fileUploadReaperSchedule?.close(),
      workflowWakeDispatcherSchedule?.close(),
      bus?.close(),
      dbClient.close(),
    ]);
  }
}

if (import.meta.main) {
  await startWorker();
}
