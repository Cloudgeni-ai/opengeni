import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { StatusBadge } from "@/components/ui/status-badge";
import { scheduledRunErrorText } from "@/lib/scheduled-run-error";
import type { ScheduledTask } from "@/types";

/**
 * Why the schedule paused itself, or why its owner was told its runs keep
 * failing. The message already says what would unblock it.
 */
export function ScheduleBlockerNotice({
  blocker,
  onOpenChat,
}: {
  blocker: NonNullable<ScheduledTask["blocker"]>;
  onOpenChat?: (() => void) | undefined;
}) {
  return (
    <Notice
      tone={blocker.state === "paused" ? "failed" : "waiting"}
      title={blocker.state === "paused" ? "Paused itself" : "Needs attention"}
      className="mb-4"
      actionLayout="responsive"
      action={
        onOpenChat ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={onOpenChat}
          >
            Open chat
          </Button>
        ) : null
      }
    >
      {blocker.message}
    </Notice>
  );
}

export function PausedChatRunBadge() {
  return (
    <span title={scheduledRunErrorText("scheduled_session_paused")}>
      <StatusBadge variant="dot" status="paused">
        Chat paused
      </StatusBadge>
    </span>
  );
}

/** This describes the recorded run, never claims to know current chat control. */
export function SchedulePausedChatNotice({
  onOpenChat,
}: {
  onOpenChat?: (() => void) | undefined;
}) {
  return (
    <Notice
      tone="waiting"
      title="Last run skipped: chat paused"
      className="mb-4"
      actionLayout="responsive"
      action={
        onOpenChat ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={onOpenChat}
          >
            Open chat
          </Button>
        ) : null
      }
    >
      {scheduledRunErrorText("scheduled_session_paused")}
    </Notice>
  );
}
