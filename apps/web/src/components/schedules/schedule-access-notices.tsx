import { ShieldCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import {
  scheduledTaskAccessFailuresText,
  scheduledTaskAwaitingHumanText,
  scheduledTaskDriftIsDismissible,
  scheduledTaskPolicyDriftLines,
  scheduledTaskUnavailableAccountsText,
} from "@/lib/scheduled-tasks";
import type { ScheduledTask, ScheduledTaskAccessAttention } from "@/types";

/** Everything the attention list says about one schedule, in one line of text. */
export function scheduledTaskAttentionText(
  attention: ScheduledTaskAccessAttention | null,
): string | null {
  const parts = [
    scheduledTaskUnavailableAccountsText(attention?.unavailableAccounts),
    scheduledTaskAccessFailuresText(attention?.failures),
    scheduledTaskAwaitingHumanText(attention?.awaitingHuman),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * What the task's owner needs to know about its frozen access: new runs cannot
 * start because a chosen account is gone, the latest run could not use a
 * connector, and what an access refresh would change. The refresh is offered
 * only to a signed-in person who can manage schedules. Defaults the owner does
 * not want can be hidden for this task head.
 */
export function ScheduledTaskAccessNotices(props: {
  policyDrift: ScheduledTask["policyDrift"];
  attention: ScheduledTaskAccessAttention | null;
  ownsTask: boolean;
  busy: boolean;
  onRefreshAccess: () => void;
  onDismissDrift?: () => void;
  className?: string;
}) {
  const blockedText = scheduledTaskUnavailableAccountsText(props.attention?.unavailableAccounts);
  const failuresText = scheduledTaskAccessFailuresText(props.attention?.failures);
  const awaitingHumanText = scheduledTaskAwaitingHumanText(props.attention?.awaitingHuman);
  // The blocked-account sentence is said once, in the louder notice.
  const driftLines = scheduledTaskPolicyDriftLines(props.policyDrift, {
    omitUnavailableAccounts: Boolean(blockedText),
  });
  const canRefreshAccess = Boolean(props.policyDrift?.canRefresh) && props.ownsTask;
  const dismissible =
    Boolean(props.onDismissDrift) && scheduledTaskDriftIsDismissible(props.policyDrift);
  if (!blockedText && !failuresText && !awaitingHumanText && driftLines.length === 0) return null;
  const refreshButton = canRefreshAccess ? (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      disabled={props.busy}
      onClick={props.onRefreshAccess}
      title="Save this schedule again with your current connectors, accounts and tools"
    >
      <ShieldCheckIcon className="size-3" />
      Refresh access
    </Button>
  ) : null;
  const refreshInDrift = driftLines.length > 0;
  const hint = canRefreshAccess
    ? refreshInDrift
      ? "Refreshing access below may fix it."
      : "Refreshing access uses the accounts you can use now."
    : blockedText && !failuresText
      ? "Reconnect the account in Capabilities, or edit the schedule to choose another one."
      : "Check the connection in Capabilities, then run the schedule again.";
  return (
    <div className={cn("grid gap-2", props.className)} data-scheduled-task-access>
      {awaitingHumanText ? (
        <Notice tone="waiting" title="The latest run is waiting for a person">
          {awaitingHumanText} Open the run's session to decide.
        </Notice>
      ) : null}
      {blockedText || failuresText ? (
        <Notice
          tone="failed"
          title={
            blockedText
              ? "New runs of this schedule cannot start"
              : "The last run could not use a connector"
          }
          action={refreshInDrift ? null : refreshButton}
        >
          {[blockedText, failuresText && blockedText ? `Last run: ${failuresText}` : failuresText]
            .filter(Boolean)
            .join(" ")}{" "}
          {hint}
        </Notice>
      ) : null}
      {driftLines.length > 0 ? (
        <Notice
          tone="waiting"
          title="This schedule's access is out of date"
          action={
            refreshButton || dismissible ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {dismissible ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={props.busy}
                    onClick={props.onDismissDrift}
                    title="Stop showing these defaults for this schedule in this browser. A refresh leaves them out."
                  >
                    Keep without these
                  </Button>
                ) : null}
                {refreshButton}
              </div>
            ) : null
          }
        >
          <ul className="grid gap-0.5">
            {driftLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {canRefreshAccess ? null : (
            <p className="mt-1 text-fg-subtle">
              Refreshing needs a signed-in person who can manage schedules.
            </p>
          )}
        </Notice>
      ) : null}
    </div>
  );
}
