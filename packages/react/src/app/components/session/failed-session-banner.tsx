import { AlertTriangleIcon } from "lucide-react";
import { Link } from "../../lib/navigation";
import { useEffect, useRef, type ComponentProps } from "react";
import { Button } from "../../../ui/button";
import type { SessionFailureSummary } from "../../lib/events";
import { failedSessionCopy } from "../../lib/failed-session-copy";
import type { FreeCreditGap } from "../../lib/free-credit-gap";
import { analyticsAction } from "../../../ui/analytics-actions";
import {
  noteTurnFailureAction,
  turnFailureClass,
  turnFailureJourney,
} from "../../lib/turn-failure-analytics";
import type { ConnectableSubscriptions } from "../../lib/deployment-free-model";
import { freeModelConnectRemedy, freeModelDailyLimitReason } from "../../lib/free-model-limit-copy";
import { FailedSessionActions } from "./failed-session-actions";
import {
  SandboxRecoveryActions,
  type SandboxRecoveryActionsProps,
} from "./sandbox-recovery-actions";

const NO_SUBSCRIPTIONS: ConnectableSubscriptions = { codex: false, supergrok: false };

/** Presentation only: admission, billing and retry identity remain with their owners. */
export function FailedSessionBanner({
  failure,
  creditExhausted,
  freeCreditGap = null,
  onChooseModel,
  workspaceId,
  canBuyCredits = false,
  onAddCredits,
  canConnectModel = false,
  modelChanged = false,
  canChooseModel = false,
  freeModel = false,
  subscriptions = NO_SUBSCRIPTIONS,
  hasModelPicker,
  actions,
  sandboxRecovery,
  analyticsKey,
  shownInTimeline = false,
}: {
  failure: SessionFailureSummary;
  /** Stable identity of this failure for the consent-gated recovery journey. */
  analyticsKey?: string | undefined;
  creditExhausted?: boolean | undefined;
  /** Free credit remains for other models but not this one. */
  freeCreditGap?: FreeCreditGap | null | undefined;
  /** Select a model in the composer; offered for a covered model after a free-credit gap. */
  onChooseModel?: ((modelId: string) => void) | undefined;
  workspaceId?: string | undefined;
  canBuyCredits?: boolean | undefined;
  /** Opens the add-credits prompt in the chat; without it, Add credits opens billing. */
  onAddCredits?: (() => void) | undefined;
  canConnectModel?: boolean | undefined;
  modelChanged?: boolean | undefined;
  canChooseModel?: boolean | undefined;
  /** The failed turn ran on the deployment's free model (catalog `cost: "free"`). */
  freeModel?: boolean | undefined;
  /** Subscriptions this deployment offers, for the free model's connect remedy. */
  subscriptions?: ConnectableSubscriptions | undefined;
  /**
   * The composer shows a model picker, even while sending or a Retry briefly
   * locks it. Keeps the free model's remedies steady; defaults to `canChooseModel`.
   */
  hasModelPicker?: boolean | undefined;
  actions?: ComponentProps<typeof FailedSessionActions> | undefined;
  sandboxRecovery?:
    | Omit<SandboxRecoveryActionsProps, "structuralFailure" | "children" | "retryActions">
    | undefined;
  /**
   * The timeline above already shows this exact failure with its Details
   * (see `timelineShowsFailure`). A compaction failure then keeps only its
   * recovery actions here instead of a second headline and Details.
   */
  shownInTimeline?: boolean | undefined;
}) {
  useTurnFailureJourney(analyticsKey, turnFailureClass(failure, creditExhausted), modelChanged);
  const structuralFailure = Boolean(failure.structuralSandboxFailure);
  const billingFailure = creditExhausted && !structuralFailure;
  const chooseModel = canChooseModel && !structuralFailure;
  const creditGap = billingFailure ? freeCreditGap : null;
  const { reason, unavailableModel, retryUnhelpful, detail, dailyLimit, compaction } =
    failedSessionCopy(failure, billingFailure, modelChanged, chooseModel, creditGap);
  // Offer the switch until the composer selects a model that can run.
  const switchTo =
    creditGap && !creditGap.selectionUsable && chooseModel && onChooseModel
      ? creditGap.covered[0]
      : undefined;
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
        subscriptions,
        canChooseModel: hasModelPicker ?? canChooseModel,
      })
    : reason;
  // Retrying the same request on the same model cannot fix a missing model or
  // rejected credentials; a new model can. Billing, access and limit failures
  // keep Retry because their condition can clear.
  const trackedActions = actions && {
    ...actions,
    onRetry: () => {
      noteTurnFailureAction("retry");
      return actions.onRetry();
    },
  };
  const retryActions =
    trackedActions &&
    !failure.safetyRefusal &&
    failure.failureCode !== "knowledge_learning_scope_changed" &&
    (!(unavailableModel || retryUnhelpful) || modelChanged || actions.retryInput) ? (
      <FailedSessionActions {...trackedActions} />
    ) : null;
  if (shownInTimeline && compaction && !structuralFailure) {
    const recovery = sandboxRecovery ? (
      <SandboxRecoveryActions
        {...sandboxRecovery}
        structuralFailure={false}
        retryActions={retryActions}
      >
        {retryActions}
      </SandboxRecoveryActions>
    ) : (
      retryActions
    );
    return recovery ? (
      <div
        data-testid="failed-session-recovery"
        className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap justify-center gap-2 px-4 text-sm text-fg-muted sm:px-6"
      >
        {recovery}
      </div>
    ) : null;
  }
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
            {offerCredits ? (
              <BuyCreditsLink
                workspaceId={workspaceId}
                primary={!offerConnect}
                onAddCredits={onAddCredits}
              />
            ) : null}
            {offerConnect ? (
              <ConnectModelLink
                workspaceId={workspaceId}
                label={freeModelConnectRemedy(subscriptions).linkLabel}
              />
            ) : null}
          </>
        ) : null}
        {billingFailure ? (
          switchTo ? (
            <>
              <Button
                type="button"
                size="sm"
                // The composer's model change reports the switch_model step.
                onClick={() => onChooseModel!(switchTo.id)}
              >
                Use {switchTo.label}
              </Button>
              {workspaceId && canBuyCredits ? (
                <BuyCreditsLink
                  workspaceId={workspaceId}
                  primary={false}
                  onAddCredits={onAddCredits}
                />
              ) : null}
            </>
          ) : workspaceId && canBuyCredits ? (
            <BuyCreditsLink workspaceId={workspaceId} primary onAddCredits={onAddCredits} />
          ) : workspaceId && canConnectModel ? (
            <ConnectModelLink workspaceId={workspaceId} label="Use your own provider account" />
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

/** The banner's one unblocking action is the primary; next to Connect it is the outline. */
function BuyCreditsLink({
  workspaceId,
  primary,
  onAddCredits,
}: {
  workspaceId: string;
  primary: boolean;
  onAddCredits?: (() => void) | undefined;
}) {
  if (onAddCredits) {
    return (
      <Button
        type="button"
        size="sm"
        variant={primary ? "default" : "outline"}
        onClick={() => {
          noteTurnFailureAction("buy_credits");
          onAddCredits();
        }}
        {...analyticsAction("buy_credits")}
      >
        Add credits
      </Button>
    );
  }
  return (
    <Button asChild size="sm" variant={primary ? "default" : "outline"}>
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "billing" }}
        onClick={() => noteTurnFailureAction("buy_credits")}
        {...analyticsAction("buy_credits")}
      >
        Add credits
      </Link>
    </Button>
  );
}

function ConnectModelLink({ workspaceId, label }: { workspaceId: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "models", workspace: workspaceId }}
        onClick={() => noteTurnFailureAction("connect_model")}
        {...analyticsAction("connect_model")}
      >
        {label}
      </Link>
    </Button>
  );
}

/** Report the banner's failure once and the person's first next step. */
function useTurnFailureJourney(
  key: string | undefined,
  failureClass: ReturnType<typeof turnFailureClass>,
  modelChanged: boolean,
) {
  useEffect(() => {
    if (!key) return;
    const journey = turnFailureJourney();
    journey.viewed(key, failureClass);
    return () => journey.dismissed(key);
  }, [key, failureClass]);
  // Choosing another model in the composer is a recovery step of its own.
  const previousModelChanged = useRef(modelChanged);
  useEffect(() => {
    if (modelChanged && !previousModelChanged.current) noteTurnFailureAction("switch_model");
    previousModelChanged.current = modelChanged;
  }, [modelChanged]);
}
