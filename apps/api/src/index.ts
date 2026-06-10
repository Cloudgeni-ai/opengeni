import { getSettings, retryStartupDependency, startupRetryOptions } from "@opengeni/config";
import type { ScheduledTask, ScheduledTaskOverlapPolicy, ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import { createDb } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability, logStartupDependencyRetry } from "@opengeni/observability";
import { Connection, Client as TemporalClient, ScheduleNotFoundError, ScheduleOverlapPolicy } from "@temporalio/client";
import type { ScheduleOptions, ScheduleSpec, ScheduleUpdateOptions } from "@temporalio/client";
import { createApp, type DocumentIndexClient, type SessionWorkflowClient } from "./app";

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
    signalInterrupt: async ({ eventId, workflowId }) => {
      await temporal.workflow.getHandle(workflowId).signal("interrupt", eventId);
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
	    triggerScheduledTask: async ({ task, agentRunUsageIdempotencyKey }) => {
	      await temporal.workflow.start("scheduledTaskFireWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId: `scheduled-task-${task.id}-manual-${crypto.randomUUID()}`,
        args: [{
          accountId: task.accountId,
	          workspaceId: task.workspaceId,
	          taskId: task.id,
	          triggerType: "manual",
	          agentRunUsageIdempotencyKey,
	        }],
	      });
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
  const dbClient = createDb(settings.databaseUrl);
  let bus: Awaited<ReturnType<typeof createNatsEventBus>> | undefined;
  let workflowClient: Awaited<ReturnType<typeof createTemporalWorkflowClient>> | undefined;
  const retryOptions = startupRetryOptions(settings);
  const onRetry = (event: Parameters<typeof logStartupDependencyRetry>[1]) => logStartupDependencyRetry(observability, event);
  try {
    bus = await retryStartupDependency("NATS", () => createNatsEventBus(settings.natsUrl), {
      ...retryOptions,
      onRetry,
    });
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
  observability.info("OpenGeni API listening", {
    host: settings.apiHost,
    port: settings.apiPort,
  });
  return {
    server,
    close: async () => {
      server.stop(true);
      await Promise.allSettled([
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
