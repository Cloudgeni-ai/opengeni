import { Link } from "@tanstack/react-router";
import { CreditCardIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { analyticsAction } from "@/lib/analytics-actions";
import { modelListSummary } from "@/lib/credit-coverage";
import type { FreeCreditGap } from "@/lib/free-credit-gap";

/**
 * The API refused a Send or a new chat because no credit pays for its model.
 * Stays above the composer until the next accepted message, so the refusal is
 * not only a short line under a failed bubble: it names the model, the
 * server's reason, the models the remaining credit covers, and the next step.
 */
export function CreditRefusalNotice({
  gap,
  message,
  workspaceId,
  canBuyCredits,
  canConnectModel,
  onChooseModel,
  onDismiss,
}: {
  gap: FreeCreditGap;
  /** The API's refusal text. */
  message?: string | null | undefined;
  workspaceId: string;
  canBuyCredits: boolean;
  canConnectModel: boolean;
  /** Select a covered model in the composer. */
  onChooseModel?: ((id: string) => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const switchTo = !gap.selectionUsable && onChooseModel ? gap.covered[0] : undefined;
  const coverage = gap.selectionUsable
    ? "Send again to use the selected model."
    : gap.covered.length > 0
      ? `Your credits cover ${modelListSummary(gap.covered.map((model) => model.label))}.`
      : null;
  const connect = canConnectModel && gap.covered.length === 0 && !gap.selectionUsable;
  return (
    <Notice
      tone="failed"
      live="assertive"
      title={`Your credits don't cover ${gap.modelLabel}`}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <span data-testid="credit-refusal-notice">
        {message ? <span className="block">{message}</span> : null}
        {coverage ? <span className="block">{coverage}</span> : null}
      </span>
      {switchTo || canBuyCredits || connect ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {switchTo ? (
            <Button type="button" size="sm" onClick={() => onChooseModel!(switchTo.id)}>
              Use {switchTo.label}
            </Button>
          ) : null}
          {canBuyCredits ? (
            <Button asChild type="button" size="sm" variant={switchTo ? "outline" : "default"}>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "billing" }}
                {...analyticsAction("buy_credits")}
              >
                <CreditCardIcon className="size-3.5" />
                Buy credits
              </Link>
            </Button>
          ) : null}
          {connect ? (
            <Button asChild type="button" size="sm" variant="outline">
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "models", workspace: workspaceId }}
                {...analyticsAction("connect_model")}
              >
                Connect a model
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Notice>
  );
}
