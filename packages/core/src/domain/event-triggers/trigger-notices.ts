import {
  NOTIFICATION_SUBTITLE_MAX_CHARS,
  SessionNotificationPostedPayload,
} from "@opengeni/contracts";
import type { Database, EventTriggerNotice } from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { errorMessage } from "@opengeni/contracts/values";

/**
 * Tell an automation's owner, once per episode, that its trigger stopped
 * receiving events and why; withdraw the notice when events flow again. The
 * notice lives on the automation's chat, so it reaches the owner's inbox.
 */

export type TriggerNoticeDeps = {
  db: Database;
  bus: EventBus;
  observability?: Pick<Observability, "warn"> | undefined;
};

function triggerNoticeKey(taskId: string): string {
  return `automation-trigger-${taskId}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export async function postTriggerNotices(
  deps: TriggerNoticeDeps,
  workspaceId: string,
  notices: EventTriggerNotice[],
  change: { blocked: true; reason: string } | { blocked: false },
): Promise<void> {
  for (const notice of notices) {
    if (!notice.sessionId) continue;
    const key = triggerNoticeKey(notice.taskId);
    const event = change.blocked
      ? {
          type: "session.notification.posted",
          payload: SessionNotificationPostedPayload.parse({
            key,
            title: "Automation stopped receiving events",
            subtitle: clip(notice.taskName.trim() || "Automation", NOTIFICATION_SUBTITLE_MAX_CHARS),
            body: `${change.reason}. Opengeni keeps trying every 15 minutes and the automation picks up again once this is fixed.`,
            urgency: "normal",
            replaced: false,
          }),
        }
      : { type: "session.notification.withdrawn", payload: { key } };
    try {
      await appendAndPublishEvents(deps.db, deps.bus, workspaceId, notice.sessionId, [
        event,
      ] as Parameters<typeof appendAndPublishEvents>[4]);
    } catch (error) {
      // The automation page still shows the trigger's state and reason.
      deps.observability?.warn("Automation trigger notice was not posted", {
        taskId: notice.taskId,
        error: errorMessage(error),
      });
    }
  }
}
