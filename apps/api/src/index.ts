import { dbSearchPath, getSettings, resolveNatsCalloutConfig, resolveNatsControlPlaneAuth, retryStartupDependency, startupRetryOptions } from "@opengeni/config";
import type { ScheduledTask, ScheduledTaskOverlapPolicy, ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import { createDb } from "@opengeni/db";
import { createNatsEventBus, type ResponderConnection } from "@opengeni/events";
import { createObservability, logStartupDependencyRetry } from "@opengeni/observability";
import { Connection, Client as TemporalClient, ScheduleNotFoundError, ScheduleOverlapPolicy, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { ScheduleOptions, ScheduleSpec, ScheduleUpdateOptions } from "@temporalio/client";
import { createApp, type DocumentIndexClient, type SessionWorkflowClient } from "./app";
import { observabilityEventLogger } from "./observability";
import { startAuthCalloutResponder } from "./sandbox/auth-callout";
import { startHelloIngestion, startMetricsIngestion } from "./sandbox/metrics-ingestion";

/**
 * A REJECT_DUPLICATE start collides on the deterministic workflowId when the
 * same manual trigger token fires twice. Temporal surfaces that as
 * WorkflowExecutionAlreadyStartedError; the caller treats it as an idempotent
 * no-op rather than a failure.
 */
function isWorkflowAlreadyStarted(error: unknown): boolean {
  return error instanceof WorkflowExecutionAlreadyStartedError;
}

const TEMPORAL_MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
] as const;

export async function createTemporalWorkflowClient(settings: ReturnType<typeof getSettings>): Promise<{
  client: SessionWorkflowClient;
  documentIndexer: DocumentIndexClient;
  close: () => Promise<void>;
}> {
  const connection = await Connection.connect({ address: settings.temporalHost });
  const temporal = new TemporalClient({
    connection,
    namespace: settings.temporalNamespace,
  });
  const client: SessionWorkflowClient = {
    signalUserMessage: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("userMessage", eventId);
    },
    wakeSessionWorkflow: async ({ accountId, workspaceId, sessionId, workflowId }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ accountId, workspaceId, sessionId }],
        signal: "queueChanged",
      });
    },
    signalApprovalDecision: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("approvalDecision", eventId);
    },
    signalInterrupt: async ({ accountId, workspaceId, sessionId, eventId, workflowId }) => {
      // Start-or-signal: an interrupt POSTed while the session is idle has no
      // running workflow execution to signal, and getHandle().signal() would
      // throw WorkflowNotFoundError -> a 500 (the operator-can't-stop bug). Like
      // wakeSessionWorkflow, signalWithStart delivers the signal to a live run
      // when one exists and otherwise starts a fresh sessionWorkflow that picks
      // the buffered `interrupt` up immediately. ALLOW_DUPLICATE matches the
      // wake path so a running execution is reused rather than rejected.
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ accountId, workspaceId, sessionId }],
        signal: "interrupt",
        signalArgs: [eventId],
      });
    },
    syncScheduledTask: async ({ task }) => {
      const schedule = temporal.schedule.getHandle(task.temporalScheduleId);
      const options = temporalScheduleOptions(task, settings.temporalTaskQueue);
      try {
        await schedule.update(() => temporalScheduleUpdateOptions(options));
      } catch (error) {
        if (!shouldCreateScheduleAfterUpdateError(error)) {
          throw error;
        }
        await temporal.schedule.create(options);
      }
    },
    deleteScheduledTaskSchedule: async ({ temporalScheduleId }) => {
      await temporal.schedule.getHandle(temporalScheduleId).delete().catch(() => undefined);
    },
    triggerScheduledTask: async ({ task, agentRunUsageIdempotencyKey, triggerWorkflowId }) => {
	      // Deterministic workflowId (derived from the trigger token by the
	      // caller) + REJECT_DUPLICATE makes a retried manual trigger idempotent:
	      // the second start collides on the id and is rejected instead of
	      // spawning a second run. The shared idempotency key dedupes the charge.
	      const workflowId = triggerWorkflowId ?? `scheduled-task-${task.id}-manual-${crypto.randomUUID()}`;
	      try {
	        await temporal.workflow.start("scheduledTaskFireWorkflow", {
	          taskQueue: settings.temporalTaskQueue,
	          workflowId,
	          workflowIdReusePolicy: "REJECT_DUPLICATE",
	          args: [{
	            accountId: task.accountId,
	            workspaceId: task.workspaceId,
	            taskId: task.id,
	            triggerType: "manual",
	            agentRunUsageIdempotencyKey,
	          }],
	        });
	      } catch (error) {
	        // A duplicate trigger token started this run already; treat the retry
	        // as a no-op so the (idempotent) usage charge stays the only effect.
	        if (isWorkflowAlreadyStarted(error)) {
	          return;
	        }
        throw error;
      }
    },
    startRigVerification: async ({ workspaceId, changeId, versionId, workflowId }) => {
      const targetId = changeId ?? versionId;
      if (!targetId) {
        throw new Error("rig verification requires changeId or versionId");
      }
      await temporal.workflow.start("rigVerificationWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId: workflowId ?? `rig-verification-${targetId}-${crypto.randomUUID()}`,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{
          workspaceId,
          ...(changeId ? { changeId } : {}),
          ...(versionId ? { versionId } : {}),
        }],
      });
    },
    check: async () => {
      await connection.workflowService.getSystemInfo({});
    },
  };
  const documentIndexer: DocumentIndexClient = {
    indexDocument: async ({ accountId, workspaceId, documentId }) => {
      const workflowId = `document-index-${documentId}-${crypto.randomUUID()}`;
      await temporal.workflow.start("documentIndexWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        args: [{ accountId, workspaceId, documentId }],
      });
    },
  };
  return {
    client,
    documentIndexer,
    close: async () => {
      await connection.close();
    },
  };
}

export async function startApi() {
  const settings = getSettings();
  const observability = createObservability(settings, { component: "api" });
  // Step I: standalone → dbSchema unset → searchPath undefined → today's plain
  // handle (public). Embedded → scoped to the dedicated schema + the host's RLS
  // strategy.
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;
  let workflowClient: Awaited<ReturnType<typeof createTemporalWorkflowClient>> | undefined;
  const retryOptions = startupRetryOptions(settings);
  const onRetry = (event: Parameters<typeof logStartupDependencyRetry>[1]) => logStartupDependencyRetry(observability, event);
  // The PRIVILEGED control-plane NATS login (M-AUTH): when the server runs with
  // auth_callout, api/worker authenticate as a static account user permitted to
  // request `agent.*.rpc`. Null in local dev (anonymous connect — the bus default).
  const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
  try {
    bus = await retryStartupDependency(
      "NATS",
      () =>
        createNatsEventBus(
          settings.natsUrl,
          controlPlaneAuth ? { user: controlPlaneAuth.user, pass: controlPlaneAuth.password } : undefined,
          { logger: observabilityEventLogger(observability) },
        ),
      {
        ...retryOptions,
        onRetry,
      },
    );
    workflowClient = await retryStartupDependency("Temporal", () => createTemporalWorkflowClient(settings), {
      ...retryOptions,
      onRetry,
    });
  } catch (error) {
    await Promise.allSettled([
      bus?.close(),
      workflowClient?.close(),
      dbClient.close(),
    ]);
    throw error;
  }
  if (!bus || !workflowClient) {
    await dbClient.close();
    throw new Error("OpenGeni API startup dependencies were not initialized");
  }
  const app = createApp({
    settings,
    db: dbClient.db,
    bus,
    workflowClient: workflowClient.client,
    documentIndexer: workflowClient.documentIndexer,
    observability,
  });
  const server = Bun.serve({
    hostname: settings.apiHost,
    port: settings.apiPort,
    idleTimeout: 255,
    fetch: app.fetch,
  });
  // M10 — start the metrics-ingestion consumer (agent heartbeats → DB last-sample
  // + downsampled series), gated on the selfhosted flag. A no-op when disabled.
  let stopMetricsIngestion: (() => void) | undefined;
  // Reconcile enrollments.has_display to the LIVE capability the agent reports in
  // its connect Hello (has_display was frozen at the enroll-time snapshot). Gated
  // on the same selfhosted flag.
  let stopHelloIngestion: (() => void) | undefined;
  // M-AUTH — start the NATS auth-callout responder (the tenancy boundary): it
  // validates an agent's enrollment bearer presented at NATS connect and mints a
  // workspace-scoped user JWT. Gated on the selfhosted flag + a resolvable callout
  // config; without the callout plane it never starts (selfhosted agents simply
  // cannot connect — graceful). It runs on its OWN connection (the callout auth
  // user), separate from the privileged control-plane bus.
  let authCalloutResponder: ResponderConnection | undefined;
  if (settings.sandboxSelfhostedEnabled) {
    stopMetricsIngestion = startMetricsIngestion({ db: dbClient.db, bus, observability });
    stopHelloIngestion = startHelloIngestion({ db: dbClient.db, bus, observability });
    observability.info("OpenGeni machine-metrics + hello ingestion consumers started", {});

    const callout = resolveNatsCalloutConfig(settings);
    if (callout) {
      try {
        authCalloutResponder = await startAuthCalloutResponder(
          { db: dbClient.db, settings, callout, observability },
          settings.natsUrl,
        );
      } catch (error) {
        // A responder start failure must not crash the API (other planes work); log
        // loudly — selfhosted agents will fail to connect until it is up.
        observability.error("OpenGeni NATS auth-callout responder failed to start", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      observability.warn(
        "OpenGeni selfhosted enabled but the NATS auth-callout plane is not configured; selfhosted agents cannot connect",
        {},
      );
    }
  }
  observability.info("OpenGeni API listening", {
    host: settings.apiHost,
    port: settings.apiPort,
  });
  return {
    server,
    close: async () => {
      server.stop(true);
      stopMetricsIngestion?.();
      stopHelloIngestion?.();
      await Promise.allSettled([
        authCalloutResponder?.close(),
        bus.close(),
        workflowClient.close(),
        dbClient.close(),
      ]);
    },
  };
}

if (import.meta.main) {
  await startApi();
}

export function temporalOverlapPolicy(policy: ScheduledTaskOverlapPolicy): ScheduleOverlapPolicy {
  if (policy === "skip") {
    return ScheduleOverlapPolicy.SKIP;
  }
  if (policy === "buffer_one") {
    return ScheduleOverlapPolicy.BUFFER_ONE;
  }
  return ScheduleOverlapPolicy.ALLOW_ALL;
}

export function shouldCreateScheduleAfterUpdateError(error: unknown): boolean {
  return error instanceof ScheduleNotFoundError;
}

export function temporalScheduleSpec(schedule: ScheduledTaskScheduleSpec): ScheduleSpec {
  if (schedule.type === "interval") {
    return {
      intervals: [{ every: `${schedule.everySeconds}s` }],
      ...(schedule.startAt ? { startAt: new Date(schedule.startAt) } : {}),
      ...(schedule.endAt ? { endAt: new Date(schedule.endAt) } : {}),
    };
  }
  if (schedule.type === "calendar") {
    return {
      calendars: [{
        hour: schedule.hour,
        minute: schedule.minute,
        second: 0,
        ...(schedule.daysOfWeek ? { dayOfWeek: schedule.daysOfWeek } : {}),
      }],
      timezone: schedule.timeZone,
    };
  }
  const runAt = new Date(schedule.runAt);
  return {
    calendars: [{
      year: runAt.getUTCFullYear(),
      month: temporalMonth(runAt.getUTCMonth()),
      dayOfMonth: runAt.getUTCDate(),
      hour: runAt.getUTCHours(),
      minute: runAt.getUTCMinutes(),
      second: runAt.getUTCSeconds(),
    }],
    timezone: "UTC",
  };
}

function temporalMonth(monthIndex: number) {
  return TEMPORAL_MONTHS[monthIndex]!;
}

function temporalScheduleOptions(task: ScheduledTask, taskQueue: string): ScheduleOptions {
  return {
    scheduleId: task.temporalScheduleId,
    spec: temporalScheduleSpec(task.schedule),
    action: {
      type: "startWorkflow",
      workflowType: "scheduledTaskFireWorkflow",
      taskQueue,
      args: [{
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }],
    },
    policies: {
      overlap: temporalOverlapPolicy(task.overlapPolicy),
      catchupWindow: "24h",
      pauseOnFailure: false,
    },
    state: {
      paused: task.status === "paused",
      ...(task.schedule.type === "once" ? { remainingActions: 1 } : {}),
    },
    memo: {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      scheduledTaskId: task.id,
      name: task.name,
    },
  };
}

function temporalScheduleUpdateOptions(options: ScheduleOptions): ScheduleUpdateOptions {
  return {
    spec: options.spec,
    action: options.action,
    ...(options.policies ? { policies: options.policies } : {}),
    state: options.state ?? {},
    ...(options.searchAttributes ? { searchAttributes: options.searchAttributes } : {}),
    ...(options.typedSearchAttributes ? { typedSearchAttributes: options.typedSearchAttributes } : {}),
  };
}
