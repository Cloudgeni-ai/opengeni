import { temporalConnectionOptions, type Settings } from "@opengeni/config";
import {
  SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL,
  SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
  SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
  SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_ID,
  SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE,
} from "@opengeni/core";
import {
  automaticSessionTitleFanoutDue,
  browserDeadlineCheckpointDue,
  knowledgeIndexDue,
  sandboxIdleCheckpointDue,
  sandboxLeaseReaperDue,
  sandboxMaintenanceDue,
  sessionWorkflowWakesDue,
  siteAuthMaintenanceDue,
  workspacePauseTimerDue,
  type Database,
} from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { Observability } from "@opengeni/observability";
import {
  Connection,
  ScheduleNotFoundError,
  Client as TemporalClient,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import {
  startMaintenanceCadences,
  type MaintenanceCadence,
  type MaintenanceCadences,
  type MaintenanceStartResult,
} from "./maintenance-cadence";
import {
  BROWSER_DEADLINE_CHECKPOINT_SWEEP_ID,
  browserDeadlineCheckpointTaskQueue,
} from "./browser-deadline-checkpoint-contract";
import {
  SANDBOX_IDLE_CHECKPOINT_SWEEP_WORKFLOW_ID,
  SANDBOX_REAPER_V2_WORKFLOW_ID,
  sandboxLifecycleTaskQueue,
} from "./sandbox-reaper-contract";
import { assertSandboxReaperActivityTimeout } from "./sandbox-reaper-timeout";
import type { TelemetryScheduler } from "./telemetry-scheduler";

export const KNOWLEDGE_INDEXING_SCHEDULE_ID = "opengeni-knowledge-indexing";
export const KNOWLEDGE_INDEXING_WORKFLOW_ID = "opengeni-knowledge-indexing";
export const KNOWLEDGE_INDEXING_PERIOD_MS = 15_000;
export const SITE_AUTH_MAINTENANCE_SCHEDULE_ID = "opengeni-site-auth-maintenance";
export const SITE_AUTH_MAINTENANCE_WORKFLOW_ID = "opengeni-site-auth-maintenance";
/** Matches the minimum public site-auth health policy interval. */
export const SITE_AUTH_MAINTENANCE_PERIOD_MS = 60 * 1_000;
/** The Schedule earlier releases used to drive the sandbox lease reaper. */
export const SANDBOX_REAPER_SCHEDULE_ID = "opengeni-sandbox-lease-reaper";

export const INTERNAL_MAINTENANCE_JOBS = [
  "session-workflow-wake-dispatcher",
  "knowledge-indexing",
  "site-auth-maintenance",
  "sandbox-lease-reaper",
  "sandbox-idle-checkpoint",
  "browser-deadline-checkpoint",
] as const;
export type InternalMaintenanceJob = (typeof INTERNAL_MAINTENANCE_JOBS)[number];

/** Schedules that earlier releases created for these jobs. A paused Schedule
 * still runs its scheduler workflow on every tick, so they are deleted. */
const LEGACY_SCHEDULE_IDS: Partial<Record<InternalMaintenanceJob, string>> = {
  "session-workflow-wake-dispatcher": SESSION_WORKFLOW_WAKE_DISPATCHER_SCHEDULE_ID,
  "knowledge-indexing": KNOWLEDGE_INDEXING_SCHEDULE_ID,
  "site-auth-maintenance": SITE_AUTH_MAINTENANCE_SCHEDULE_ID,
  // The old reaper Schedule fired a router workflow that started the drain
  // inventory, both checkpoint sweeps and the maintenance child on every tick.
  "sandbox-lease-reaper": SANDBOX_REAPER_SCHEDULE_ID,
};

type WorkflowStarter = Pick<TemporalClient["workflow"], "start" | "signalWithStart">;
type ScheduleDeleter = { getHandle(id: string): { delete(): Promise<void> } };

/** Start a fixed-id maintenance workflow unless one is already running; the
 * running sweep's own claims cover whatever this tick saw. */
export async function startMaintenanceWorkflowOnce(
  workflow: WorkflowStarter,
  input: { workflowType: string; workflowId: string; taskQueue: string },
): Promise<MaintenanceStartResult> {
  try {
    await workflow.start(input.workflowType, {
      taskQueue: input.taskQueue,
      workflowId: input.workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [],
    });
    return "started";
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) return "already_running";
    throw error;
  }
}

/** Remove the per-tick Schedules this release replaces. Absent is success. */
export async function deleteLegacyMaintenanceSchedules(
  schedule: ScheduleDeleter,
  jobs: readonly InternalMaintenanceJob[],
  observability: Observability,
): Promise<void> {
  for (const job of jobs) {
    const scheduleId = LEGACY_SCHEDULE_IDS[job];
    if (!scheduleId) continue;
    try {
      await schedule.getHandle(scheduleId).delete();
      observability.info(
        "Deleted a per-tick maintenance Schedule replaced by a work-checked cadence",
        {
          job,
          scheduleId,
        },
      );
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw error;
    }
  }
}

/**
 * Build the work-checked cadences for the deployment-wide dispatchers. Each
 * tick runs one cheap read-only check and touches Temporal only when the check
 * may find work, so an idle deployment writes no workflow history at all.
 */
export async function internalMaintenanceCadences(input: {
  settings: Settings;
  observability: Observability;
  db: Database;
  workflow: WorkflowStarter;
  documentServices?: DocumentServices;
  jobs?: readonly InternalMaintenanceJob[];
}): Promise<MaintenanceCadence[]> {
  const { settings, observability, db, workflow } = input;
  const jobs = new Set(input.jobs ?? INTERNAL_MAINTENANCE_JOBS);
  const taskQueue = settings.temporalTaskQueue;
  const cadences: MaintenanceCadence[] = [];
  if (jobs.has("session-workflow-wake-dispatcher")) {
    const { repairMissedSessionWorkflowWakes } = await import("./activities/parent-wake");
    cadences.push({
      job: "session-workflow-wake-dispatcher",
      periodMs: SESSION_WORKFLOW_WAKE_DISPATCHER_PERIOD_MS,
      hasWork: async () => {
        // Registration is the dispatcher's own idempotent repair: it writes
        // only when a producer committed work but never recorded its wake.
        await repairMissedSessionWorkflowWakes({ db, observability });
        return (
          (await sessionWorkflowWakesDue(db)) ||
          (await workspacePauseTimerDue(db)) ||
          (await automaticSessionTitleFanoutDue(db))
        );
      },
      start: async () => {
        await workflow.signalWithStart(SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_TYPE, {
          taskQueue,
          workflowId: SESSION_WORKFLOW_WAKE_DISPATCHER_WORKFLOW_ID,
          workflowIdReusePolicy: "ALLOW_DUPLICATE",
          args: [],
          signal: SESSION_WORKFLOW_WAKE_DISPATCH_REQUESTED_SIGNAL,
        });
        return "started";
      },
    });
  }
  if (jobs.has("knowledge-indexing")) {
    let embedding: Promise<{ model: string; dimensions: number }> | undefined;
    const resolveEmbedding = async () => {
      const services =
        input.documentServices ??
        (await import("@opengeni/documents")).createDocumentServices(settings);
      return { model: services.embedder.model, dimensions: services.embedder.dimensions };
    };
    cadences.push({
      job: "knowledge-indexing",
      periodMs: KNOWLEDGE_INDEXING_PERIOD_MS,
      hasWork: async () => {
        embedding ??= resolveEmbedding().catch((error) => {
          embedding = undefined;
          throw error;
        });
        return await knowledgeIndexDue(db, await embedding);
      },
      start: async () =>
        await startMaintenanceWorkflowOnce(workflow, {
          workflowType: "knowledgeIndexingWorkflow",
          workflowId: KNOWLEDGE_INDEXING_WORKFLOW_ID,
          taskQueue,
        }),
    });
  }
  if (jobs.has("site-auth-maintenance")) {
    const { SITE_AUTH_MAINTENANCE_CLAIM_TIMEOUT_MS } =
      await import("./activities/site-auth-maintenance");
    cadences.push({
      job: "site-auth-maintenance",
      periodMs: SITE_AUTH_MAINTENANCE_PERIOD_MS,
      hasWork: async () =>
        await siteAuthMaintenanceDue(db, {
          claimTimeoutMs: SITE_AUTH_MAINTENANCE_CLAIM_TIMEOUT_MS,
        }),
      start: async () =>
        await startMaintenanceWorkflowOnce(workflow, {
          workflowType: "siteAuthMaintenanceWorkflow",
          workflowId: SITE_AUTH_MAINTENANCE_WORKFLOW_ID,
          taskQueue,
        }),
    });
  }
  const sandboxJobs = (
    ["sandbox-lease-reaper", "sandbox-idle-checkpoint", "browser-deadline-checkpoint"] as const
  ).filter((job) => jobs.has(job));
  if (sandboxJobs.length > 0) {
    // The same period the old reaper Schedule used, so the boot invariants
    // (reaper period below the viewer holder TTL, and with the idle grace
    // below the provider lifetime) hold for every sandbox cadence.
    assertSandboxReaperActivityTimeout(settings);
    const periodMs = settings.sandboxLeaseReaperPeriodMs;
    const lifecycleQueue = sandboxLifecycleTaskQueue(taskQueue);
    const sandbox = await import("./activities/sandbox-lease");
    if (jobs.has("sandbox-lease-reaper")) {
      const { SANDBOX_CHECKPOINT_GC_CLAIM_TTL_MS } = sandbox;
      cadences.push({
        job: "sandbox-lease-reaper",
        periodMs,
        // The drain inventory and its maintenance pass act only on warm or held
        // leases, due reconciliation rows, or (with Modal) boxes still running in
        // the provider app. With none of those, the tick only refreshes the
        // pass's read-only gauges in this process.
        hasWork: async () => {
          if (
            (await sandboxLeaseReaperDue(db)) ||
            (await sandboxMaintenanceDue(db, {
              checkpointArtifactClaimTtlMs: SANDBOX_CHECKPOINT_GC_CLAIM_TTL_MS,
            })) ||
            (await sandbox.modalOrphanSweepMayHaveWork({ settings, observability }))
          ) {
            return true;
          }
          await sandbox.refreshIdleSandboxReaperProjections({ db, settings, observability });
          return false;
        },
        start: async () =>
          await startMaintenanceWorkflowOnce(workflow, {
            workflowType: "sandboxReaperWorkflowV2",
            workflowId: SANDBOX_REAPER_V2_WORKFLOW_ID,
            taskQueue: lifecycleQueue,
          }),
      });
    }
    if (jobs.has("sandbox-idle-checkpoint")) {
      cadences.push({
        job: "sandbox-idle-checkpoint",
        periodMs,
        // The sweep's inventory is empty when ownership or snapshots are off.
        hasWork: async () =>
          settings.sandboxOwnershipEnabled &&
          settings.sandboxSnapshotIntervalMs > 0 &&
          (await sandboxIdleCheckpointDue(db, { intervalMs: settings.sandboxSnapshotIntervalMs })),
        start: async () =>
          await startMaintenanceWorkflowOnce(workflow, {
            workflowType: "sandboxIdleCheckpointSweepWorkflow",
            workflowId: SANDBOX_IDLE_CHECKPOINT_SWEEP_WORKFLOW_ID,
            taskQueue: lifecycleQueue,
          }),
      });
    }
    if (jobs.has("browser-deadline-checkpoint")) {
      cadences.push({
        job: "browser-deadline-checkpoint",
        periodMs,
        hasWork: async () => await browserDeadlineCheckpointDue(db),
        start: async () =>
          await startMaintenanceWorkflowOnce(workflow, {
            workflowType: "browserDeadlineCheckpointSweepWorkflow",
            workflowId: BROWSER_DEADLINE_CHECKPOINT_SWEEP_ID,
            taskQueue: browserDeadlineCheckpointTaskQueue(taskQueue),
          }),
      });
    }
  }
  return cadences;
}

/**
 * Run the deployment-wide maintenance dispatchers from this control worker.
 * Several control replicas may each run the cadence: an idle tick is only a
 * read, and a busy one converges on the same fixed workflow id.
 */
export async function startInternalMaintenanceCadences(input: {
  settings: Settings;
  observability: Observability;
  db: Database;
  documentServices?: DocumentServices;
  jobs?: readonly InternalMaintenanceJob[];
  scheduler?: TelemetryScheduler;
}): Promise<{ cadences: MaintenanceCadences; close: () => Promise<void> }> {
  const connection = await Connection.connect(temporalConnectionOptions(input.settings));
  try {
    const temporal = new TemporalClient({
      connection,
      namespace: input.settings.temporalNamespace,
    });
    const jobs = input.jobs ?? INTERNAL_MAINTENANCE_JOBS;
    await deleteLegacyMaintenanceSchedules(temporal.schedule, jobs, input.observability);
    const cadences = startMaintenanceCadences({
      cadences: await internalMaintenanceCadences({ ...input, jobs, workflow: temporal.workflow }),
      observability: input.observability,
      ...(input.scheduler ? { scheduler: input.scheduler } : {}),
    });
    input.observability.info("Started work-checked maintenance cadences", {
      jobs: jobs.join(","),
    });
    return {
      cadences,
      close: async () => {
        await cadences.close();
        await connection.close();
      },
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
