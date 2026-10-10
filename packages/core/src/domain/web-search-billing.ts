import type { Settings } from "@opengeni/config";
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
import { workspaceCreditsDisabled } from "./workspace-credits";

/** Credit ledger type and usage source for deployment-funded web search calls. */
export const WEB_SEARCH_DEBIT_TYPE = "web_search_debit";
export const WEB_SEARCH_SOURCE_TYPE = "web_search";
const WEB_SEARCH_BILLING_INITIATOR = "worker:web-search";

/** Same rule as other deployment-funded resources: Stripe or managed limits. */
export function webSearchCreditBillingActive(
  settings: Pick<Settings, "billingMode" | "usageLimitsMode">,
): boolean {
  return settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
}

/** Exact attempt that called the tool. Every charge is attributed to its turn. */
export type WebSearchCallScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
};

export type WebSearchCallCost = {
  /** Model tool-call or Codemode operation identity, unique within the attempt. */
  operationId: string;
  operation: "search" | "fetch";
  provider: string;
  providerMicros: number;
  creditMicros: number;
  marginBps: number;
  basis: "provider_reported" | "configured_price" | "list_price";
};

export class WebSearchBillingRefusedError extends Error {
  constructor(
    readonly code: "insufficient_credits" | "allowance_exhausted" | "credits_disabled",
    message: string,
  ) {
    super(message);
    this.name = "WebSearchBillingRefusedError";
  }
}

/** Model-facing refusal when the workspace turned Opengeni credits off. */
export const WEB_SEARCH_CREDITS_DISABLED_MESSAGE =
  "Web search uses Opengeni credits, which are turned off in this workspace.";

/**
 * Admission and post-use settlement for paid web search, matching paid
 * Knowledge queries and voice input: admission reads the workspace credit
 * switch, general credits and the workspace/member allowance (a read, not a
 * reservation); settlement records a durable usage receipt and the idempotent
 * debit in one transaction. Calls that cost nothing (free providers, or
 * billing inactive) are never refused. A workspace that turned Opengeni
 * credits off is never debited, even when the switch flips mid-turn.
 */
export function createWebSearchBilling(deps: { db: Database; settings: Settings }) {
  const active = webSearchCreditBillingActive(deps.settings);
  const attributionByTurn = new Map<string, Promise<CreditDebitAttribution>>();
  const attributionFor = (scope: WebSearchCallScope) => {
    let attribution = attributionByTurn.get(scope.turnId);
    if (!attribution) {
      attribution = creditDebitAttributionForTurn(deps.db, scope);
      attributionByTurn.set(scope.turnId, attribution);
      attribution.catch(() => attributionByTurn.delete(scope.turnId));
    }
    return attribution;
  };
  return {
    active,
    async admit(scope: WebSearchCallScope, expectedProviderMicros: number): Promise<void> {
      if (!active || expectedProviderMicros <= 0) return;
      if (await workspaceCreditsDisabled(deps.db, scope.workspaceId)) {
        throw new WebSearchBillingRefusedError(
          "credits_disabled",
          WEB_SEARCH_CREDITS_DISABLED_MESSAGE,
        );
      }
      const attribution = await attributionFor(scope);
      // Non-model resources spend general credits only.
      const balance = await getSpendableCreditBalance(deps.db, scope.accountId);
      if (balance.balanceMicros <= 0) {
        throw new WebSearchBillingRefusedError(
          "insufficient_credits",
          "Web search needs Opengeni credits, and this account has none left.",
        );
      }
      const refusal = await checkWorkspaceAllowance(deps.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        subjectId: attribution.kind === "turn" ? attribution.initiatingHumanSubjectId : null,
      });
      if (refusal) throw new WebSearchBillingRefusedError("allowance_exhausted", refusal.message);
    },
    async settle(scope: WebSearchCallScope, cost: WebSearchCallCost): Promise<void> {
      const shared = {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        turnAttemptId: scope.attemptId,
        sourceResourceType: WEB_SEARCH_SOURCE_TYPE,
        sourceResourceId: `${scope.attemptId}:${cost.operationId}`,
      };
      // Request counts are recorded for every deployment, billed or not, so
      // operators see provider volume.
      await recordUsageEvent(deps.db, {
        ...shared,
        eventType: `web_search.${cost.operation}_requests`,
        quantity: 1,
        unit: "request",
        idempotencyKey: `usage:web_search.${cost.operation}_requests:${shared.sourceResourceId}`,
      });
      if (!active || cost.creditMicros <= 0) return;
      // Admission refused paid calls already; this covers a switch turned off
      // during the provider call and provider-reported cost on a call admitted
      // as free. The workspace spends no credits; the request count stays.
      if (await workspaceCreditsDisabled(deps.db, scope.workspaceId)) return;
      const attribution = await attributionFor(scope);
      await withRlsContext(
        deps.db,
        { accountId: scope.accountId, workspaceId: scope.workspaceId },
        async (tx) => {
          await recordUsageEvent(tx, {
            ...shared,
            eventType: "web_search.cost",
            quantity: cost.creditMicros,
            unit: "usd_micros",
            idempotencyKey: `usage:web_search.cost:${shared.sourceResourceId}`,
            initiator: { kind: "service", subjectId: WEB_SEARCH_BILLING_INITIATOR },
            initiatorContext: { creditDebitAttribution: attribution },
          });
          await applyCreditDebitAfterUse(tx, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            type: WEB_SEARCH_DEBIT_TYPE,
            amountMicros: cost.creditMicros,
            sourceType: WEB_SEARCH_SOURCE_TYPE,
            sourceId: shared.sourceResourceId,
            idempotencyKey: `credit:${WEB_SEARCH_DEBIT_TYPE}:${shared.sourceResourceId}`,
            metadata: {
              // turnId lets the allowance trigger resolve the causal human
              // from the immutable turn receipt.
              ...creditDebitAttributionMetadata(attribution),
              provider: cost.provider,
              operation: cost.operation,
              providerCostMicros: cost.providerMicros,
              marginBps: cost.marginBps,
              basis: cost.basis,
            },
          });
        },
      );
    },
  };
}

export type WebSearchBilling = ReturnType<typeof createWebSearchBilling>;
