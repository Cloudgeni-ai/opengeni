import { AlertTriangleIcon, CreditCardIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import type { SessionFailureSummary } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { FailedSessionActions } from "./failed-session-actions";

/**
 * Failure honesty: the reason the session failed, how many turns timed out and
 * were retried automatically before it, and the fact that the composer stays
 * usable — sending a message revives the session.
 *
 * Credit exhaustion gets its own copy: "send a message to revive" is a lie
 * when the workspace has no credits (the revive turn dies the same death), so
 * the banner points at the actual fix — the organization's Credits section.
 */
export function FailedSessionBanner({
  failure,
  creditExhausted,
  workspaceId,
  actions,
}: {
  failure: SessionFailureSummary;
  creditExhausted?: boolean;
  workspaceId?: string;
  actions?: ComponentProps<typeof FailedSessionActions>;
}) {
  if (creditExhausted) {
    return (
      <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
        <div
          data-testid="failed-session-banner"
          className="flex flex-col gap-3 rounded-lg border border-status-failed/30 bg-status-failed/10 p-3 text-status-failed sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 gap-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-failed" />
            <div className="min-w-0 text-sm">
              <span className="font-medium">
                This workspace is out of OpenGeni credits
                {failure.failedAt ? ` (since ${formatTimestamp(failure.failedAt)})` : ""}.
              </span>
              <div className="mt-1 text-xs text-fg-muted">
                The conversation history is preserved. Add credits to the organization, then keep
                working from right here.
              </div>
            </div>
          </div>
          {workspaceId ? (
            <Button asChild type="button" size="sm" variant="secondary" className="shrink-0">
              <Link to="/workspaces/$workspaceId/organization" params={{ workspaceId }}>
                <CreditCardIcon className="size-3.5" />
                Add credits
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
      <div
        data-testid="failed-session-banner"
        className="flex gap-2.5 rounded-lg border border-status-failed/30 bg-status-failed/10 p-3 text-status-failed"
      >
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-failed" />
        <div className="min-w-0 text-sm">
          <span className="font-medium">
            This session failed{failure.failedAt ? ` ${formatTimestamp(failure.failedAt)}` : ""}.
          </span>{" "}
          {failure.reason ? (
            <span className="text-status-failed/90">{failure.reason}</span>
          ) : (
            <span className="text-fg-muted">No failure detail was recorded.</span>
          )}
          <div className="mt-1 text-xs text-fg-muted">
            {failure.recoveryCount > 0 ? (
              <>
                {failure.recoveryCount} same-turn recovery attempt
                {failure.recoveryCount === 1 ? "" : "s"} occurred before this failure.{" "}
              </>
            ) : null}
            {failure.failedTurnCount > 1 ? (
              <>{failure.failedTurnCount} turns have failed in this session. </>
            ) : null}
            {failure.safetyRefusal
              ? "The conversation history is preserved. Automatic retries are stopped."
              : "The conversation history is preserved — send a message to revive the session and keep working."}
          </div>
          {actions ? <FailedSessionActions {...actions} /> : null}
        </div>
      </div>
    </div>
  );
}
