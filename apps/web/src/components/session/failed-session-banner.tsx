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
  const { reason, unavailableModel, retryUnhelpful, detail } = failedSessionCopy(
    failure,
    billingFailure,
    modelChanged,
    canChooseModel && !structuralFailure,
  );
  // Retrying the same request on the same model cannot fix a missing model or
  // rejected credentials; a new model can. Billing, access and limit failures
  // keep Retry because their condition can clear.
  const retryActions =
    actions &&
    !failure.safetyRefusal &&
    (!(unavailableModel || retryUnhelpful) || modelChanged || actions.retryInput) ? (
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
        {detail ? (
          <details className="group min-w-0 max-w-full text-xs open:basis-full">
            <summary className="cursor-pointer select-none text-fg-subtle hover:text-fg-muted">
              Details
            </summary>
            <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-fg-muted">
              {detail}
            </p>
          </details>
        ) : null}
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
