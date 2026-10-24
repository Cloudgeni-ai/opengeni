import {
  EVENT_DELIVERY_BODY_RETENTION_DAYS,
  EVENT_RETENTION_DAYS,
  NOTIFICATION_SUBTITLE_MAX_CHARS,
  SessionNotificationPostedPayload,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import {
  eventTriggersEnabled,
  pumpDueEventSourceFeeds,
  pumpDueMcpEventSubscriptions,
  type EventSourceFeedPumpDeps,
  type McpEventSubscriptionPumpDeps,
} from "@opengeni/core";
import {
  claimEventTriggerDispatch,
  listDueEventTriggerTasks,
  markEventOccurrenceStarted,
  pruneEventIntake,
  recordEventOccurrenceStartFailure,
  type Database,
  type EventOccurrenceToStart,
  type EventThrottleNotice,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";

/**
 * Turns queued events into runs. Each pass claims automations whose inbox is
 * due, folds their pending events into one occurrence (or holds them under the
 * storm guard), and starts one scheduled-task run per occurrence. A run start
 * that fails is retried with backoff; the occurrence id makes it idempotent.
 */

export type EventTriggerDispatchDependencies = {
  db: Database;
  settings: Pick<Settings, "eventTriggersEnabled">;
  bus: EventBus;
  /** Start the run of one occurrence; already-started is success. */
  startRun(occurrence: EventOccurrenceToStart): Promise<void>;
  observability?: Pick<Observability, "error" | "warn">;
};

export function eventThrottleNoticeKey(taskId: string): string {
  return `automation-throttle-${taskId}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function eventThrottleNoticePayload(
  notice: EventThrottleNotice,
): SessionNotificationPostedPayload {
  const resumes = notice.resumesAt.toISOString().slice(11, 16);
  return SessionNotificationPostedPayload.parse({
    key: eventThrottleNoticeKey(notice.taskId),
    title: "Automation is holding events back",
    subtitle: clip(notice.taskName.trim() || "Automation", NOTIFICATION_SUBTITLE_MAX_CHARS),
    body: `It already ran ${notice.maxRunsPerHour} times in the last hour, its limit. New events are collected and handled together in its next run, from about ${resumes} UTC. Raise the limit in the automation's settings if this volume is expected.`,
    urgency: "normal",
    replaced: false,
  });
}

async function postThrottleNotice(
  deps: EventTriggerDispatchDependencies,
  workspaceId: string,
  notice: EventThrottleNotice,
): Promise<void> {
  try {
    await appendAndPublishEvents(deps.db, deps.bus, workspaceId, notice.sessionId, [
      { type: "session.notification.posted", payload: eventThrottleNoticePayload(notice) },
    ] as Parameters<typeof appendAndPublishEvents>[4]);
  } catch (error) {
    // The automation page still shows that the guard is holding events.
    deps.observability?.warn("Automation throttle notice was not posted", {
      taskId: notice.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** One bounded pass over automations with due events. */
export async function dispatchDueEventTriggers(
  deps: EventTriggerDispatchDependencies,
): Promise<void> {
  for (const due of await listDueEventTriggerTasks(deps.db)) {
    try {
      const dispatch = await claimEventTriggerDispatch(deps.db, due.workspaceId, due.taskId);
      if (dispatch.throttleNotice) {
        await postThrottleNotice(deps, due.workspaceId, dispatch.throttleNotice);
      }
      for (const occurrence of dispatch.start) {
        try {
          await deps.startRun(occurrence);
          await markEventOccurrenceStarted(deps.db, occurrence.workspaceId, occurrence.id);
        } catch (error) {
          await recordEventOccurrenceStartFailure(
            deps.db,
            occurrence.workspaceId,
            occurrence.id,
            error instanceof Error ? error.message : String(error),
          );
          deps.observability?.warn("Automation event run did not start; it will retry", {
            taskId: occurrence.taskId,
            occurrenceId: occurrence.id,
            attempts: occurrence.startAttempts + 1,
          });
        }
      }
    } catch (error) {
      deps.observability?.error("Automation event dispatch will retry", {
        taskId: due.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function startLoop(
  run: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = run()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  queueMicrotask(tick);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

/**
 * Polls for due automations. Matching sets a short settle delay before an
 * inbox is due, so a burst of events lands in one run.
 */
export function startEventTriggerDispatchPump(
  deps: EventTriggerDispatchDependencies,
  intervalMs = 2_000,
): () => Promise<void> {
  return startLoop(
    async () => {
      if (eventTriggersEnabled(deps.settings)) await dispatchDueEventTriggers(deps);
    },
    intervalMs,
    (error) =>
      deps.observability?.error("Automation event dispatch failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  );
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Keeps event subscriptions alive: each due MCP subscription is polled, or its
 * webhook subscription created or refreshed, and each due source feed (Gmail)
 * is read. Steps hold a lease, so replicas share the work without stepping on
 * each other.
 */
export function startEventSubscriptionPump(
  deps: McpEventSubscriptionPumpDeps & EventSourceFeedPumpDeps,
  intervalMs = 5_000,
): () => Promise<void> {
  return startLoop(
    async () => {
      if (!eventTriggersEnabled(deps.settings)) return;
      // Keep going while full batches come back, so a backlog drains promptly.
      for (let pass = 0; pass < 10; pass += 1) {
        const stepped = await Promise.all([
          pumpDueMcpEventSubscriptions(deps),
          pumpDueEventSourceFeeds(deps),
        ]);
        if (stepped.every((count) => count < 32)) return;
      }
    },
    intervalMs,
    (error) =>
      deps.observability?.error("Event subscription pass failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  );
}

/**
 * Deletes raw delivery bodies after 7 days and events and deliveries after 30,
 * in bounded batches. Runs whether or not event triggers are on, so turning
 * them off never keeps people's messages longer.
 */
export function startEventIntakePrunePump(
  deps: { db: Database; observability?: Pick<Observability, "error"> },
  intervalMs = 10 * 60_000,
): () => Promise<void> {
  return startLoop(
    async () => {
      for (let pass = 0; pass < 20; pass += 1) {
        const changed = await pruneEventIntake(deps.db, {
          bodyRetentionSeconds: EVENT_DELIVERY_BODY_RETENTION_DAYS * DAY_SECONDS,
          eventRetentionSeconds: EVENT_RETENTION_DAYS * DAY_SECONDS,
        });
        if (changed === 0) return;
      }
    },
    intervalMs,
    (error) =>
      deps.observability?.error("Event intake retention pass failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  );
}
