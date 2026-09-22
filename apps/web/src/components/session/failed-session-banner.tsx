import { AlertTriangleIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import type { SessionFailureSummary } from "@/lib/events";
import { failedSessionCopy } from "@/lib/failed-session-copy";
import { FailedSessionActions } from "./failed-session-actions";
import {
  SandboxRecoveryActions,
  type SandboxRecoveryActionsProps,
} from "./sandbox-recovery-actions";

/** Presentation only: admission, billing and retry identity remain with their owners. */
export function FailedSessionBanner({
  failure,
  creditExhausted,
  workspaceId,
  canBuyCredits = false,
  canConnectModel = false,
  modelChanged = false,
  canChooseModel = false,
  actions,
  sandboxRecovery,
}: {
  failure: SessionFailureSummary;
  creditExhausted?: boolean;
  workspaceId?: string;
  canBuyCredits?: boolean;
  canConnectModel?: boolean;
  modelChanged?: boolean;
  canChooseModel?: boolean;
  actions?: ComponentProps<typeof FailedSessionActions>;
  sandboxRecovery?: Omit<
    SandboxRecoveryActionsProps,
    "structuralFailure" | "children" | "retryActions"
  >;
}) {
  const structuralFailure = Boolean(failure.structuralSandboxFailure);
  const billingFailure = creditExhausted && !structuralFailure;
  const { reason, unavailableModel } = failedSessionCopy(
    failure,
    billingFailure,
    modelChanged,
    canChooseModel && !structuralFailure,
  );
  const retryActions =
    actions &&
    !failure.safetyRefusal &&
    (!unavailableModel || modelChanged || actions.retryInput) ? (
      <FailedSessionActions {...actions} />
    ) : null;
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
      <div
        data-testid="failed-session-banner"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted"
      >
        <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{reason}</span>
        {billingFailure ? (
          workspaceId && canBuyCredits ? (
            <Button asChild size="sm" variant="ghost">
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "billing" }}
              >
                Buy credits
              </Link>
            </Button>
          ) : workspaceId && canConnectModel ? (
            <Button asChild size="sm" variant="ghost">
              <Link
                to="/workspaces/$workspaceId/settings"
                params={{ workspaceId }}
                search={{ section: "models" }}
              >
                Connect a model
              </Link>
            </Button>
          ) : null
        ) : sandboxRecovery ? (
          <SandboxRecoveryActions
            {...sandboxRecovery}
            structuralFailure={structuralFailure}
            retryActions={retryActions}
          >
            {!structuralFailure ? retryActions : null}
          </SandboxRecoveryActions>
        ) : !structuralFailure ? (
          retryActions
        ) : null}
      </div>
    </div>
  );
}
