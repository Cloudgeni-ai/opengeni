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
 * Credit exhaustion keeps Add credits and the policy-constrained model picker
 * available. The automatic continuation shortcut stays hidden until the user
 * resolves that billing choice through the existing composer flow.
 */
export function FailedSessionBanner({
  failure,
  creditExhausted,
  workspaceId,
  canBuyCredits = false,
  canConnectModel = false,
  actions,
}: {
  failure: SessionFailureSummary;
  creditExhausted?: boolean;
  workspaceId?: string;
  canBuyCredits?: boolean;
  canConnectModel?: boolean;
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
                The conversation history is preserved. Buy organization credits or connect a model,
                then keep working here.
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {workspaceId && canBuyCredits ? (
              <Button asChild type="button" size="sm" className="shrink-0">
                <Link
                  to="/workspaces/$workspaceId/organization"
                  params={{ workspaceId }}
                  search={{ section: "billing" }}
                >
                  <CreditCardIcon className="size-3.5" />
                  Buy credits
                </Link>
              </Button>
            ) : null}
            {workspaceId && canConnectModel ? (
              <Button asChild type="button" size="sm" variant="secondary" className="shrink-0">
                <Link
                  to="/workspaces/$workspaceId/settings"
                  params={{ workspaceId }}
                  search={{ section: "models" }}
                >
                  Connect a model
                </Link>
              </Button>
            ) : null}
            {actions ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={actions.modelDisabled}
                onClick={actions.onChooseModel}
              >
                Choose another model
              </Button>
            ) : null}
            {!canBuyCredits && !canConnectModel ? (
              <span className="self-center text-xs text-fg-muted">
                Ask an organization owner or workspace admin for help.
              </span>
            ) : null}
          </div>
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
