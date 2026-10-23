import type { Settings } from "@opengeni/config";
import {
  ScheduledTaskEventsInput,
  type ParsedScheduledTaskEventsInput,
  type ScheduledTask,
  type ScheduledTaskAction,
  type ScheduledTaskRun,
  type ScheduledTaskScheduleSpec,
} from "@opengeni/contracts";
import {
  eventSourceVisibleTo,
  getEventSource,
  getScheduledTaskEvents,
  getScheduledTaskRunEventOccurrences,
  rearmScheduledTaskEvents,
  setScheduledTaskEvents,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { eventTriggersEnabled } from "./sources";

/**
 * Event triggers on an automation (a scheduled task). They are validated
 * with the rest of a create or update and written in the same transaction.
 */

/** Validate the requested triggers against the automation they will belong to. */
export async function validateScheduledTaskEvents(input: {
  settings: Pick<Settings, "eventTriggersEnabled">;
  db: Database;
  workspaceId: string;
  /** The automation's owner; a private source fires only that person's automations. */
  ownerSubjectId: string | null;
  schedule: ScheduledTaskScheduleSpec;
  action: ScheduledTaskAction;
  events: ParsedScheduledTaskEventsInput;
}): Promise<ParsedScheduledTaskEventsInput> {
  const events = ScheduledTaskEventsInput.parse(input.events);
  if (events.triggers.length === 0) return { triggers: [] };
  if (!eventTriggersEnabled(input.settings)) {
    throw new HTTPException(422, { message: "Event triggers are not enabled on this deployment" });
  }
  if (input.action.kind !== "agent_turn") {
    throw new HTTPException(422, { message: "Only agent automations can have event triggers" });
  }
  if (events.once && input.schedule.type !== "manual" && input.schedule.type !== "once") {
    throw new HTTPException(422, {
      message:
        "A run-once automation can't also repeat on a schedule. Use a one-time schedule or none.",
    });
  }
  const sources = new Map<string, Awaited<ReturnType<typeof getEventSource>>>();
  for (const [index, trigger] of events.triggers.entries()) {
    if (!sources.has(trigger.sourceId)) {
      sources.set(
        trigger.sourceId,
        await getEventSource(input.db, input.workspaceId, trigger.sourceId),
      );
    }
    const source = sources.get(trigger.sourceId);
    if (!source || !eventSourceVisibleTo(source, input.ownerSubjectId)) {
      throw new HTTPException(422, {
        message: `Trigger ${index + 1}: the event source is missing or private to someone else`,
      });
    }
    if (source.kind === "mcp") {
      const [type, ...rest] = trigger.eventTypes;
      if (rest.length > 0 || !type || type.includes("*")) {
        throw new HTTPException(422, {
          message: `Trigger ${index + 1}: an MCP trigger subscribes to exactly one event type`,
        });
      }
    } else if (trigger.arguments !== undefined) {
      throw new HTTPException(422, {
        message: `Trigger ${index + 1}: subscription arguments are only for MCP event sources`,
      });
    }
  }
  return events;
}

/**
 * The schedule of an automation that already has `once` event triggers may
 * only change to another schedule a run-once automation allows.
 */
export async function validateScheduleForExistingEvents(input: {
  db: Database;
  workspaceId: string;
  taskId: string;
  schedule: ScheduledTaskScheduleSpec;
}): Promise<void> {
  if (input.schedule.type === "manual" || input.schedule.type === "once") return;
  const events = (await getScheduledTaskEvents(input.db, input.workspaceId, [input.taskId])).get(
    input.taskId,
  );
  if (events?.once) {
    throw new HTTPException(422, {
      message: "A run-once automation can't also repeat on a schedule. Turn off run once first.",
    });
  }
}

/** Write validated triggers inside the create or update transaction. */
export async function writeScheduledTaskEvents(
  tx: Database,
  task: Pick<ScheduledTask, "accountId" | "workspaceId" | "id">,
  events: ParsedScheduledTaskEventsInput,
): Promise<void> {
  await setScheduledTaskEvents(tx, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    triggers: events.triggers,
    maxRunsPerHour: events.maxRunsPerHour,
    once: events.triggers.length === 0 ? undefined : events.once,
  });
}

/** A resumed automation starts over: a run-once automation can fire again. */
export async function rearmScheduledTaskEventsOnResume(
  tx: Database,
  task: Pick<ScheduledTask, "workspaceId" | "id">,
): Promise<void> {
  await rearmScheduledTaskEvents(tx, task.workspaceId, task.id);
}

/** Attach each automation's event triggers to a read. */
export async function withScheduledTaskEvents(
  db: Database,
  tasks: ScheduledTask[],
): Promise<ScheduledTask[]> {
  const workspaceId = tasks[0]?.workspaceId;
  if (!workspaceId) return tasks;
  const events = await getScheduledTaskEvents(
    db,
    workspaceId,
    tasks.map((task) => task.id),
  );
  if (events.size === 0) return tasks;
  return tasks.map((task) => {
    const found = events.get(task.id);
    return found ? { ...task, events: found } : task;
  });
}

/** Attach the events an event run carried. */
export async function withScheduledTaskRunEventOccurrences(
  db: Database,
  runs: ScheduledTaskRun[],
): Promise<ScheduledTaskRun[]> {
  const eventRuns = runs.filter((run) => run.triggerType === "event");
  const workspaceId = eventRuns[0]?.workspaceId;
  if (!workspaceId) return runs;
  const occurrences = await getScheduledTaskRunEventOccurrences(
    db,
    workspaceId,
    eventRuns.map((run) => run.id),
  );
  return runs.map((run) =>
    run.triggerType === "event"
      ? { ...run, eventOccurrence: occurrences.get(run.id) ?? null }
      : run,
  );
}
