import { AlertTriangleIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import type { SessionFailureSummary } from "@/lib/events";
import { failedSessionCopy } from "@/lib/failed-session-copy";
import { freeModelDailyLimitReason } from "@/lib/free-model-limit-copy";
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
  freeModel = false,
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
  /** The failed turn ran on the deployment's free model (catalog `cost: "free"`). */
  freeModel?: boolean;
  actions?: ComponentProps<typeof FailedSessionActions>;
  sandboxRecovery?: Omit<
    SandboxRecoveryActionsProps,
    "structuralFailure" | "children" | "retryActions"
  >;
}) {
  const structuralFailure = Boolean(failure.structuralSandboxFailure);
  const billingFailure = creditExhausted && !structuralFailure;
  const chooseModel = canChooseModel && !structuralFailure;
  const { reason, unavailableModel, retryUnhelpful, detail, dailyLimit } = failedSessionCopy(
    failure,
    billingFailure,
    modelChanged,
    chooseModel,
  );
  // The free model's daily allowance is deployment-wide: name it and offer the
  // ways to keep going. Every other model keeps the generic daily-limit copy.
  const freeModelLimit = freeModel && dailyLimit && !structuralFailure;
  const offerCredits = Boolean(workspaceId && canBuyCredits);
  const offerConnect = Boolean(workspaceId && canConnectModel);
  const headline = freeModelLimit
    ? freeModelDailyLimitReason({
        modelChanged,
        canBuyCredits: offerCredits,
        canConnectModel: offerConnect,
        canChooseModel: chooseModel,
      })
    : reason;
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
        {/* The icon flows with the text so a wrapped headline never strands it. */}
        <span className="min-w-0 break-words">
          <AlertTriangleIcon
            aria-hidden="true"
            className="mr-2 inline-block size-3.5 align-[-0.125rem]"
          />
          {headline}
        </span>
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
        {freeModelLimit && !modelChanged && workspaceId ? (
          <>
            {offerCredits ? <BuyCreditsLink workspaceId={workspaceId} label="Add credits" /> : null}
            {offerConnect ? (
              <ConnectModelLink workspaceId={workspaceId} label="Connect a subscription" />
            ) : null}
          </>
        ) : null}
        {billingFailure ? (
          workspaceId && canBuyCredits ? (
            <BuyCreditsLink workspaceId={workspaceId} label="Buy credits" />
          ) : workspaceId && canConnectModel ? (
            <ConnectModelLink workspaceId={workspaceId} label="Connect a model" />
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

function BuyCreditsLink({ workspaceId, label }: { workspaceId: string; label: string }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "billing" }}
      >
        {label}
      </Link>
    </Button>
  );
}

function ConnectModelLink({ workspaceId, label }: { workspaceId: string; label: string }) {
  return (
    <Button asChild size="sm" variant="ghost">
      <Link
        to="/workspaces/$workspaceId/settings"
        params={{ workspaceId }}
        search={{ section: "models" }}
      >
        {label}
      </Link>
    </Button>
  );
}
