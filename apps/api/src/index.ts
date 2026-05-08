import { getSettings } from "@infra-agents/config";
import type { ScheduledTask, ScheduledTaskOverlapPolicy, ScheduledTaskScheduleSpec } from "@infra-agents/contracts";
import { createDb } from "@infra-agents/db";
import { createNatsEventBus } from "@infra-agents/events";
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
    wakeSessionWorkflow: async ({ sessionId, workflowId }) => {
      await temporal.workflow.signalWithStart("sessionWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ sessionId }],
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
    triggerScheduledTask: async ({ taskId }) => {
      await temporal.workflow.start("scheduledTaskFireWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId: `scheduled-task-${taskId}-manual-${crypto.randomUUID()}`,
        args: [{
          taskId,
          triggerType: "manual",
        }],
      });
    },
  };
  const documentIndexer: DocumentIndexClient = {
    indexDocument: async ({ documentId }) => {
      const workflowId = `document-index-${documentId}-${crypto.randomUUID()}`;
      await temporal.workflow.start("documentIndexWorkflow", {
        taskQueue: settings.temporalTaskQueue,
        workflowId,
        args: [{ documentId }],
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
  const dbClient = createDb(settings.databaseUrl);
  const bus = await createNatsEventBus(settings.natsUrl);
  const workflowClient = await createTemporalWorkflowClient(settings);
  const app = createApp({
    settings,
    db: dbClient.db,
    bus,
    workflowClient: workflowClient.client,
    documentIndexer: workflowClient.documentIndexer,
  });
  const server = Bun.serve({
    hostname: settings.apiHost,
    port: settings.apiPort,
    idleTimeout: 255,
    fetch: app.fetch,
  });
  console.log(`Infra Agents API listening on http://${settings.apiHost}:${settings.apiPort}`);
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
