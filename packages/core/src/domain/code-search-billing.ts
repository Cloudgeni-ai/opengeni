import type { Settings } from "@opengeni/config";
import type { CodeSearchJudgeRoute } from "@opengeni/contracts/code-search";
import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  creditDebitAttributionForTurn,
  creditDebitAttributionMetadata,
  getSpendableCreditBalance,
  recordUsageEvent,
  withRlsContext,
  type CreditDebitAttribution,
  type Database,
} from "@opengeni/db";

/** Credit ledger type and usage source for `code_search` judge calls paid with OpenGeni credits. */
export const CODE_SEARCH_DEBIT_TYPE = "code_search_debit";
export const CODE_SEARCH_SOURCE_TYPE = "code_search";
const CODE_SEARCH_BILLING_INITIATOR = "worker:code-search";

/**
 * Credits are charged only when the operator chose `credits` and the
 * deployment bills credits at all (Stripe billing or managed usage limits),
 * the same rule as every other deployment-funded resource.
 */
export function codeSearchCreditBillingActive(
  settings: Pick<Settings, "billingMode" | "usageLimitsMode" | "codeSearchBillingMode">,
): boolean {
  return (
    settings.codeSearchBillingMode === "credits" &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  );
}

/**
 * The charge for one call: the judge's cost plus the margin, rounded up to a
 * whole micro. Zero cost charges nothing.
 */
export function codeSearchCreditMicros(providerMicros: number, marginBps: number): number {
  if (!Number.isFinite(providerMicros) || providerMicros <= 0) return 0;
  return Math.ceil((providerMicros * (10_000 + marginBps)) / 10_000);
}

/** The exact attempt that called the tool, and the model the turn is paid for. */
export type CodeSearchCallScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  /** Promotional grants that cover this model pay first, then general credits. */
  productModelId: string;
};

export type CodeSearchCallCost = {
  /** Model tool-call or Codemode operation identity, unique within the attempt. */
  operationId: string;
  route: CodeSearchJudgeRoute;
  /** The judge model that answered, when the provider named it. */
  model: string | null;
  providerMicros: number;
  basis: "provider_reported" | "list_price";
};

export class CodeSearchBillingRefusedError extends Error {
  constructor(
    readonly code: "insufficient_credits" | "allowance_exhausted",
    message: string,
  ) {
    super(message);
    this.name = "CodeSearchBillingRefusedError";
  }
}

/**
 * Admission and post-use settlement for `code_search` on turns paid with
 * OpenGeni credits, following paid web search, Knowledge queries and voice:
 * admission reads the credits that can pay for the turn's model and the
 * workspace/member allowances (a read, not a reservation); settlement records
 * the `code_search.cost` receipt and the idempotent debit in one transaction.
 * Routes paid by the deployment or by the customer's own connection are never
 * refused or charged here.
 */
export function createCodeSearchBilling(deps: { db: Database; settings: Settings }) {
  const active = codeSearchCreditBillingActive(deps.settings);
  const marginBps = deps.settings.codeSearchCreditMarginBps;
  const attributionByTurn = new Map<string, Promise<CreditDebitAttribution>>();
  const attributionFor = (scope: CodeSearchCallScope) => {
    let attribution = attributionByTurn.get(scope.turnId);
    if (!attribution) {
      attribution = creditDebitAttributionForTurn(deps.db, scope);
      attributionByTurn.set(scope.turnId, attribution);
      attribution.catch(() => attributionByTurn.delete(scope.turnId));
    }
    return attribution;
  };
  const charges = (route: CodeSearchJudgeRoute) => active && route.funding === "credits";
  return {
    active,
    marginBps,
    /** Throws CodeSearchBillingRefusedError when a charged call cannot be paid for. */
    async admit(scope: CodeSearchCallScope, route: CodeSearchJudgeRoute): Promise<void> {
      if (!charges(route)) return;
      const attribution = await attributionFor(scope);
      const balance = await getSpendableCreditBalance(
        deps.db,
        scope.accountId,
        scope.productModelId,
      );
      if (balance.balanceMicros <= 0) {
        throw new CodeSearchBillingRefusedError(
          "insufficient_credits",
          "Fast code search needs Opengeni credits, and this account has none left for this model.",
        );
      }
      const refusal = await checkWorkspaceAllowance(deps.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        subjectId: attribution.kind === "turn" ? attribution.initiatingHumanSubjectId : null,
      });
      if (refusal) throw new CodeSearchBillingRefusedError("allowance_exhausted", refusal.message);
    },
    /**
     * Records the receipt and debit for a completed call; returns the micros
     * charged (0 when this route or deployment is not charged). Idempotent per
     * attempt and operation, so a retried settlement never charges twice.
     */
    async settle(scope: CodeSearchCallScope, cost: CodeSearchCallCost): Promise<number> {
      if (!charges(cost.route)) return 0;
      const creditMicros = codeSearchCreditMicros(cost.providerMicros, marginBps);
      if (creditMicros <= 0) return 0;
      const attribution = await attributionFor(scope);
      const sourceId = `${scope.attemptId}:${cost.operationId}`;
      await withRlsContext(
        deps.db,
        { accountId: scope.accountId, workspaceId: scope.workspaceId },
        async (tx) => {
          await recordUsageEvent(tx, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            turnAttemptId: scope.attemptId,
            sourceResourceType: CODE_SEARCH_SOURCE_TYPE,
            sourceResourceId: sourceId,
            eventType: "code_search.cost",
            quantity: creditMicros,
            unit: "usd_micros",
            idempotencyKey: `usage:code_search.cost:${sourceId}`,
            initiator: { kind: "service", subjectId: CODE_SEARCH_BILLING_INITIATOR },
            initiatorContext: { creditDebitAttribution: attribution },
          });
          await applyCreditDebitAfterUse(tx, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            type: CODE_SEARCH_DEBIT_TYPE,
            amountMicros: creditMicros,
            sourceType: CODE_SEARCH_SOURCE_TYPE,
            sourceId,
            idempotencyKey: `credit:${CODE_SEARCH_DEBIT_TYPE}:${sourceId}`,
            usage: scope.productModelId,
            metadata: {
              // turnId lets the allowance trigger charge the turn's frozen
              // initiating human.
              ...creditDebitAttributionMetadata(attribution),
              provider: cost.route.provider,
              ...(cost.model ? { model: cost.model } : {}),
              productModelId: scope.productModelId,
              providerCostMicros: cost.providerMicros,
              marginBps,
              basis: cost.basis,
            },
          });
        },
      );
      return creditMicros;
    },
  };
}

export type CodeSearchBilling = ReturnType<typeof createCodeSearchBilling>;
