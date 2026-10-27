import { Link } from "../../lib/navigation";
import { CreditCardIcon } from "lucide-react";

import { Button } from "../../../ui/button";
import { Notice } from "../../../ui/notice";
import { analyticsAction } from "../../../ui/analytics-actions";
import { apiErrorFacts } from "../../../ui/api-error";
import { modelListSummary } from "../../lib/credit-coverage";
import type { FreeCreditGap } from "../../lib/free-credit-gap";
import { useAppContext } from "../../app-context";
import { useCreditBalance } from "./use-credit-balance";

/**
 * The API refused a Send or a new chat because no credit pays for its model.
 * Stays above the composer until the next accepted message, so the refusal is
 * not only a short line under a failed bubble: it names the model, the
 * server's reason, the models the remaining credit covers, and the next step.
 * When no credit covers any model, it says that plainly instead, in the same
 * words as the notice shown before the first Send: with no credit at all, that
 * there is none; with credit this model can't use (for example promotional
 * credit for other models), that this model can't use it.
 */
export function CreditRefusalNotice({
  gap,
  message,
  workspaceId,
  accountId,
  canBuyCredits,
  canReadBilling = false,
  canConnectModel,
  continuing = false,
  onChooseModel,
  onAddCredits,
  onDismiss,
}: {
  gap: FreeCreditGap;
  /** The API's refusal text. */
  message?: string | null | undefined;
  workspaceId: string;
  /** The organization whose balance tells "no credit" from "credit this model can't use". */
  accountId?: string | null | undefined;
  canBuyCredits: boolean;
  canReadBilling?: boolean | undefined;
  canConnectModel: boolean;
  /** The chat already has messages, so "keep chatting" reads true. */
  continuing?: boolean | undefined;
  /** Select a covered model in the composer. */
  onChooseModel?: ((id: string) => void) | undefined;
  /** Opens the add-credits prompt on this page; without it, Add credits opens billing. */
  onAddCredits?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const switchTo = !gap.selectionUsable && onChooseModel ? gap.covered[0] : undefined;
  const coverage = gap.selectionUsable
    ? "Send again to use the selected model."
    : gap.covered.length > 0
      ? `Your credits cover ${modelListSummary(gap.covered.map((model) => model.label))}.`
      : null;
  const connect = canConnectModel && gap.covered.length === 0 && !gap.selectionUsable;
  // Nothing left to switch to, so the server's advice to pick a model covered
  // by promotional credit doesn't apply. The balance says why: no credit at
  // all, or credit this model can't use.
  const uncovered = gap.covered.length === 0 && !gap.selectionUsable;
  const client = useAppContext().client;
  const { balance, settled } = useCreditBalance(
    client,
    uncovered ? accountId : null,
    canReadBilling,
  );
  // Wait for the balance rather than show words it would contradict.
  if (uncovered && !settled) return null;
  const credit = !uncovered ? null : !balance ? "unknown" : balance.someCredit ? "some" : "none";
  // The server's sentence, without the SDK's "API 402:" prefix or the reference.
  const reason =
    credit === "none"
      ? canBuyCredits
        ? "Chats here are paid with Opengeni credits, and you don't have any right now."
        : "Chats here are paid with Opengeni credits, and there are none left. Ask an organization owner to add some."
      : credit === "some"
        ? canBuyCredits
          ? "This model can't use the Opengeni credits you have right now. Add credits, or choose another model."
          : "This model can't use your organization's Opengeni credits right now. Choose another model, or ask an organization owner to add credits."
        : credit === "unknown"
          ? canBuyCredits
            ? "This model needs Opengeni credits. Add credits, or choose another model."
            : "This model needs Opengeni credits. Choose another model, or ask an organization owner to add credits."
          : message
            ? apiErrorFacts(message).serverMessage
            : undefined;
  const title =
    credit === "none"
      ? canBuyCredits
        ? continuing
          ? "Add credits to keep chatting"
          : "Add credits to start chatting"
        : "No credits left"
      : credit
        ? canBuyCredits
          ? "Add credits to use this model"
          : "Credits needed for this model"
        : `Your credits don't cover ${gap.modelLabel}`;
  return (
    <Notice
      tone={credit ? "waiting" : "failed"}
      live="assertive"
      title={title}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <span data-testid="credit-refusal-notice">
        {reason ? <span className="block">{reason}</span> : null}
        {coverage ? <span className="block">{coverage}</span> : null}
      </span>
      {switchTo || canBuyCredits || connect ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {switchTo ? (
            <Button type="button" size="sm" onClick={() => onChooseModel!(switchTo.id)}>
              Use {switchTo.label}
            </Button>
          ) : null}
          {canBuyCredits && onAddCredits ? (
            <Button
              type="button"
              size="sm"
              variant={switchTo ? "outline" : "default"}
              onClick={onAddCredits}
              {...analyticsAction("buy_credits")}
            >
              <CreditCardIcon className="size-3.5" />
              Add credits
            </Button>
          ) : canBuyCredits ? (
            <Button asChild type="button" size="sm" variant={switchTo ? "outline" : "default"}>
              <Link
                to="/workspaces/$workspaceId/organization"
                params={{ workspaceId }}
                search={{ section: "billing" }}
                {...analyticsAction("buy_credits")}
              >
                <CreditCardIcon className="size-3.5" />
                Add credits
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
                Use your own provider account
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Notice>
  );
}
