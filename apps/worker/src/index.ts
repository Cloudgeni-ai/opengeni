import {
  dbSearchPath,
  getSettings,
  resolveNatsControlPlaneAuth,
  retryStartupDependency,
  startupRetryOptions,
  type Settings,
} from "@opengeni/config";
import { createDb, markSessionWorkflowWakeDelivered, type Database } from "@opengeni/db";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
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
import { NativeConnection, Worker, type WorkflowBundleOption } from "@temporalio/worker";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureModalRegistryImage } from "@opengeni/runtime";
import {
  createControlActivities,
  createTurnActivities,
  type ActivityDependencies,
} from "./activities";
import type {
  SignalCodexCapacityWorkflow,
  SignalSessionAttemptQuiesced,
  WakeSessionWorkflowSignal,
} from "./activities/types";
import { turnTaskQueue } from "./workflows/activities";
import {
  dbReadyCheck,
  natsReadyCheck,
  startWorkerHttpServer,
  temporalReadyCheck,
  type WorkerLifecycleState,
} from "./http";
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
import {
  constructWithOwnedConnection,
  createWorkerServiceLifecycle,
  type WorkerServiceLifecycle,
} from "./worker-service-lifecycle";

export {
  createHostExportPump,
  type HostExportDrainResult,
  type HostExportPump,
  type HostExportPumpOptions,
  type HostEventExport,
  type HostEventExportBatch,
  type HostEventSink,
  type HostUsageExport,
  type HostUsageExportBatch,
  type HostUsageSink,
} from "./host-export";

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
  /** Override the release-coherent workflow artifact. Most hosts should omit this. */
  workflowBundle?: WorkflowBundleOption;
};

type WorkerWorkflowDefinition =
  | { workflowBundle: WorkflowBundleOption }
  | { workflowsPath: string };

/**
 * Resolve the deterministic workflow graph without asking installed hosts to
 * transpile or relocate package TypeScript. Monorepo source execution retains
 * the source path for the local development loop; published dist execution
 * fails closed unless the build-generated sibling artifact is present.
 */
export function resolveOpenGeniWorkflowDefinition(
  moduleUrl: string = import.meta.url,
): WorkerWorkflowDefinition {
  const modulePath = fileURLToPath(moduleUrl).replaceAll("\\", "/");
  if (modulePath.endsWith("/src/index.ts")) {
    return { workflowsPath: fileURLToPath(new URL("./workflows.ts", moduleUrl)) };
  }
  const codePath = fileURLToPath(new URL("./workflow-bundle.js", moduleUrl));
  if (!existsSync(codePath)) {
    throw new Error(
      `OpenGeni workflow bundle is missing at ${codePath}; rebuild or reinstall @opengeni/worker-bundle`,
    );
  }
  return { workflowBundle: { codePath } };
}

export async function createOpenGeniWorker(options: WorkerOptions): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const settings = options.settings ?? getSettings();
  const observability =
    options.activityDependencies?.observability ??
    createObservability(settings, { component: `worker-${options.role}` });
  if (options.role === "turn" && options.workflowBundle) {
    throw new Error("workflowBundle is valid only for the control worker role");
  }
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
  return constructWithOwnedConnection(
    () =>
      retryStartupDependency(
        "Temporal",
        () => NativeConnection.connect({ address: settings.temporalHost }),
        {
          ...startupRetryOptions(settings),
          onRetry: (event) => logStartupDependencyRetry(observability, event),
        },
      ),
    async (connection) => {
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
              ...(options.workflowBundle
                ? { workflowBundle: options.workflowBundle }
                : resolveOpenGeniWorkflowDefinition()),
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
    },
    (connection) => connection.close(),
  );
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
  signalSessionAttemptQuiesced: SignalSessionAttemptQuiesced;
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
    signalSessionAttemptQuiesced: async (proof) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId: proof.workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [
          {
            accountId: proof.accountId,
            workspaceId: proof.workspaceId,
            sessionId: proof.sessionId,
          },
        ],
        signal: "sessionAttemptQuiesced",
        signalArgs: [proof],
      });
      // No wake-outbox row exists yet: the direct receipt transaction failed.
      // The signalled workflow's DB-only control activity owns committing the
      // receipt and its exact wake revision atomically.
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

export type OpenGeniWorkerServiceOptions = Omit<WorkerOptions, "activityDependencies"> & {
  activityDependencies: ActivityDependencies & { db: Database; bus: EventBus };
  /**
   * `role-default` registers OpenGeni's internal maintenance schedules on a
   * control worker only. These are engine maintenance schedules, not a host's
   * product-level scheduled-agent jobs. Use `none` when another control worker
   * in the same deployment owns them.
   */
  internalSchedules?: "role-default" | "none";
  /** Set false only when the host exposes equivalent lifecycle endpoints itself. */
  http?: false | { readinessTimeoutMs?: number };
};

export type OpenGeniWorkerService = {
  readonly role: OpenGeniWorkerRole;
  readonly worker: Worker;
  readonly connection: NativeConnection;
  state(): WorkerLifecycleState;
  run(): Promise<void>;
  drain(reason?: string): void;
  close(): Promise<void>;
};

export function workerOwnsInternalSchedules(
  role: OpenGeniWorkerRole,
  policy: OpenGeniWorkerServiceOptions["internalSchedules"] = "role-default",
): boolean {
  return role === "control" && policy !== "none";
}

/**
 * Construct one role-specific worker process around the lower-level Temporal
 * worker factory. The service owns every Temporal client and HTTP listener it
 * creates. The embedding host retains ownership of its injected DB and EventBus
 * handles and closes those only after this service has drained.
 */
export async function createOpenGeniWorkerService(
  options: OpenGeniWorkerServiceOptions,
): Promise<OpenGeniWorkerService> {
  const settings = options.settings ?? getSettings();
  const observability =
    options.activityDependencies.observability ??
    createObservability(settings, { component: `worker-${options.role}` });
  const retryOptions = startupRetryOptions(settings);
  const onRetry = (event: Parameters<typeof logStartupDependencyRetry>[1]) =>
    logStartupDependencyRetry(observability, event);
  let lifecycle: WorkerServiceLifecycle | undefined;
  let signaler: Awaited<ReturnType<typeof createWorkerWorkflowSignaler>> | undefined;
  let workerBundle: Awaited<ReturnType<typeof createOpenGeniWorker>> | undefined;
  const schedules: Array<{ close: () => Promise<void> }> = [];
  let httpServer: ReturnType<typeof startWorkerHttpServer> | undefined;

  try {
    const needsSignaler =
      !options.activityDependencies.wakeSessionWorkflow ||
      !options.activityDependencies.signalSessionAttemptQuiesced ||
      !options.activityDependencies.signalCodexCapacityWorkflow;
    if (needsSignaler) {
      signaler = await retryStartupDependency(
        "Temporal client",
        () => createWorkerWorkflowSignaler(settings, options.activityDependencies.db),
        { ...retryOptions, onRetry },
      );
    }
    const wakeSessionWorkflow =
      options.activityDependencies.wakeSessionWorkflow ?? signaler?.wakeSessionWorkflow;
    const signalSessionAttemptQuiesced =
      options.activityDependencies.signalSessionAttemptQuiesced ??
      signaler?.signalSessionAttemptQuiesced;
    const signalCodexCapacityWorkflow =
      options.activityDependencies.signalCodexCapacityWorkflow ??
      signaler?.signalCodexCapacityWorkflow;
    if (!wakeSessionWorkflow || !signalSessionAttemptQuiesced || !signalCodexCapacityWorkflow) {
      throw new Error("OpenGeni worker lifecycle could not resolve its workflow signalers");
    }
    workerBundle = await createOpenGeniWorker({
      role: options.role,
      settings,
      ...(options.activities ? { activities: options.activities } : {}),
      ...(options.workflowBundle ? { workflowBundle: options.workflowBundle } : {}),
      activityDependencies: {
        ...options.activityDependencies,
        settings,
        observability,
        wakeSessionWorkflow,
        signalSessionAttemptQuiesced,
        signalCodexCapacityWorkflow,
      },
    });

    if (workerOwnsInternalSchedules(options.role, options.internalSchedules)) {
      schedules.push(
        await retryStartupDependency(
          "Temporal schedule (sandbox reaper)",
          () => registerSandboxReaperSchedule(settings, observability),
          { ...retryOptions, onRetry },
        ),
      );
      schedules.push(
        await retryStartupDependency(
          "Temporal schedule (file upload reaper)",
          () => registerFileUploadReaperSchedule(settings, observability),
          { ...retryOptions, onRetry },
        ),
      );
      schedules.push(
        await retryStartupDependency(
          "Temporal schedule (session-workflow wake dispatcher)",
          () => registerSessionWorkflowWakeDispatcherSchedule(settings, observability),
          { ...retryOptions, onRetry },
        ),
      );
    }

    if (options.http !== false) {
      httpServer = startWorkerHttpServer({
        settings,
        observability,
        checks: {
          db: dbReadyCheck(options.activityDependencies.db),
          nats: natsReadyCheck(options.activityDependencies.bus),
          temporal: temporalReadyCheck(workerBundle.connection),
        },
        ...(options.http?.readinessTimeoutMs ? { timeoutMs: options.http.readinessTimeoutMs } : {}),
        lifecycle: { role: options.role, state: () => lifecycle?.state() ?? "starting" },
      });
    }
  } catch (error) {
    httpServer?.stop(true);
    await Promise.allSettled([
      workerBundle?.connection.close(),
      signaler?.close(),
      ...schedules.map((schedule) => schedule.close()),
    ]);
    throw error;
  }

  const activeWorkerBundle = workerBundle;
  const activeSignaler = signaler;
  if (!activeWorkerBundle) {
    throw new Error("OpenGeni worker service initialization did not complete");
  }

  lifecycle = createWorkerServiceLifecycle({
    role: options.role,
    worker: activeWorkerBundle.worker,
    observability,
    closeOwnedResources: async () => {
      httpServer?.stop(true);
      await Promise.allSettled([
        activeWorkerBundle.connection.close(),
        activeSignaler?.close(),
        ...schedules.map((schedule) => schedule.close()),
      ]);
    },
    onReady: () => {
      observability.info("OpenGeni worker listening", {
        role: options.role,
        temporalTaskQueue:
          options.role === "control"
            ? settings.temporalTaskQueue
            : turnTaskQueue(settings.temporalTaskQueue),
        maxConcurrentActivityTaskExecutions:
          options.role === "turn"
            ? TURN_WORKER_MAX_CONCURRENT_TURNS
            : CONTROL_WORKER_MAX_CONCURRENT_ACTIVITIES,
        maxConcurrentWorkflowTaskExecutions:
          options.role === "control" ? CONTROL_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS : 0,
        httpPort: options.http === false ? null : settings.workerHttpPort,
      });
    },
  });

  return {
    role: options.role,
    worker: activeWorkerBundle.worker,
    connection: activeWorkerBundle.connection,
    state: lifecycle.state,
    run: lifecycle.run,
    drain: lifecycle.drain,
    close: lifecycle.close,
  };
}

export type RunOpenGeniWorkerOptions = OpenGeniWorkerServiceOptions & {
  /** Defaults to SIGTERM and SIGINT. Pass false when the host owns process signals. */
  shutdownSignals?: false | ReadonlyArray<"SIGTERM" | "SIGINT">;
};

/** Start, drain, and close one embedded worker process. */
export async function runOpenGeniWorker(options: RunOpenGeniWorkerOptions): Promise<void> {
  const service = await createOpenGeniWorkerService(options);
  const signals =
    options.shutdownSignals === false ? [] : (options.shutdownSignals ?? ["SIGTERM", "SIGINT"]);
  const handlers = signals.map((signal) => {
    const handler = () => service.drain(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    await service.run();
  } finally {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
    await service.close();
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
    await runOpenGeniWorker({
      role,
      settings,
      activityDependencies: {
        observability,
        db: dbClient.db,
        bus,
      },
    });
  } finally {
    await Promise.allSettled([bus?.close(), dbClient.close()]);
  }
}

if (import.meta.main) {
  await startWorker();
}
