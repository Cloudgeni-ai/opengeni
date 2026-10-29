import {
  hostedWebSearchCharge,
  paidHostedToolsChargeCredits,
  webSearchCreditBillingActive,
  type Settings,
} from "@opengeni/config";
import { API_CREDITS_REQUIRED_MESSAGE } from "@opengeni/contracts";
import {
  applyCreditDebitAfterUse,
  chargeBillingOrigin,
  checkWorkspaceAllowance,
  creditDebitAttributionForTurn,
  creditDebitAttributionMetadata,
  getSpendableCreditBalance,
  recordUsageEvent,
  withRlsContext,
  type CreditDebitAttribution,
  type Database,
  type UsageEventProcessingResidency,
} from "@opengeni/db";
import { workspaceCreditsDisabled } from "./workspace-credits";

/** Credit ledger type and usage source for deployment-funded web search calls. */
export const WEB_SEARCH_DEBIT_TYPE = "web_search_debit";
export const WEB_SEARCH_SOURCE_TYPE = "web_search";
const WEB_SEARCH_BILLING_INITIATOR = "worker:web-search";

/** Same rule as other deployment-funded resources: Stripe or managed limits. */
export { webSearchCreditBillingActive } from "@opengeni/config";

/** Exact attempt that called the tool. Every charge is attributed to its turn. */
export type WebSearchCallScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  /**
   * The credit-billed turn's product model when its paid hosted tools bill
   * credits ({@link paidHostedToolsChargeCredits}): the monthly plan and
   * grants covering that model pay first, then general credit, exactly as
   * for the turn's Gateway images and chat. Omitted: general credit only.
   */
  creditUsageModelId?: string;
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
  /** Where the provider processed the call (its route's residency claim). */
  processingResidency?: UsageEventProcessingResidency;
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
  "Web search uses credits, which are turned off in this workspace.";

/**
 * Admission and post-use settlement for paid web search, matching paid
 * Knowledge queries and voice input: admission reads the workspace credit
 * switch, general credits and the workspace/member allowance (a read, not a
 * reservation); settlement records a durable usage receipt and the idempotent
 * debit in one transaction. Calls that cost nothing (free providers, or
 * billing inactive) are never refused. A workspace that turned Opengeni
 * credits off is refused paid calls, and settlement skips the debit (and the
 * cost receipt) for a call that was in flight when the switch turned off or
 * that was admitted as free but reported a provider cost.
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
      // General credit, plus the plan and grants covering the turn's model
      // when the turn's paid hosted tools bill credits; API work credits only.
      const origin = attribution.kind === "unknown" ? undefined : attribution.billingOrigin;
      const balance = await getSpendableCreditBalance(
        deps.db,
        scope.accountId,
        scope.creditUsageModelId,
        undefined,
        undefined,
        origin,
      );
      if (balance.balanceMicros <= 0) {
        throw new WebSearchBillingRefusedError(
          "insufficient_credits",
          chargeBillingOrigin(origin) === "api"
            ? `${API_CREDITS_REQUIRED_MESSAGE} Add credits to search the web.`
            : "Web search needs credits, and this account has none left.",
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
        ...(cost.processingResidency ? { processingResidency: cost.processingResidency } : {}),
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
            ...(scope.creditUsageModelId ? { usage: scope.creditUsageModelId } : {}),
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

/** Usage source prefix for hosted searches, distinct from provider tool calls. */
export const HOSTED_WEB_SEARCH_SOURCE_PREFIX = "hosted";

/**
 * Charge the searches a model provider ran with its own hosted search tool
 * on one credit-billed model response, at the hosted list price plus the
 * web-search margin. This is a separate debit from the response's model
 * debit, keyed by the same durable response identity (`sourceId`), so a
 * retried settlement never charges twice. Like the turn's Gateway images and
 * chat, it is never refused: the monthly plan and grants covering the
 * response's model pay first, then general credit. The caller passes only
 * credit-billed responses whose cost was not reported by a Gateway (a
 * reported cost already includes search); the single check point
 * {@link paidHostedToolsChargeCredits} decides whether the charge applies.
 */
export async function settleHostedWebSearchUsage(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnAttemptId?: string | null;
    /** The model response's durable source identity (`${turnId}:${sourceKey}`). */
    sourceId: string;
    /** Product model id of the response, recorded on the debit. */
    model: string;
    requests: number;
  },
): Promise<{ creditMicros: number }> {
  if (
    input.requests <= 0 ||
    !paidHostedToolsChargeCredits(settings, {
      accountId: input.accountId,
      chargesOpenGeniCredits: true,
    })
  ) {
    return { creditMicros: 0 };
  }
  const charge = hostedWebSearchCharge(settings, input.requests);
  const shared = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.turnAttemptId ? { turnAttemptId: input.turnAttemptId } : {}),
    sourceResourceType: WEB_SEARCH_SOURCE_TYPE,
    sourceResourceId: `${HOSTED_WEB_SEARCH_SOURCE_PREFIX}:${input.sourceId}`,
  };
  await recordUsageEvent(db, {
    ...shared,
    eventType: "web_search.search_requests",
    quantity: input.requests,
    unit: "request",
    idempotencyKey: `usage:web_search.search_requests:${shared.sourceResourceId}`,
  });
  if (charge.creditMicros <= 0) return { creditMicros: 0 };
  const attribution = await creditDebitAttributionForTurn(db, input);
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await recordUsageEvent(tx, {
        ...shared,
        eventType: "web_search.cost",
        quantity: charge.creditMicros,
        unit: "usd_micros",
        idempotencyKey: `usage:web_search.cost:${shared.sourceResourceId}`,
        initiator: { kind: "service", subjectId: WEB_SEARCH_BILLING_INITIATOR },
        initiatorContext: { creditDebitAttribution: attribution },
      });
      await applyCreditDebitAfterUse(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        type: WEB_SEARCH_DEBIT_TYPE,
        amountMicros: charge.creditMicros,
        sourceType: WEB_SEARCH_SOURCE_TYPE,
        sourceId: shared.sourceResourceId,
        idempotencyKey: `credit:${WEB_SEARCH_DEBIT_TYPE}:${shared.sourceResourceId}`,
        // The plan and grants covering the response's model pay first.
        usage: input.model,
        metadata: {
          ...creditDebitAttributionMetadata(attribution),
          provider: HOSTED_WEB_SEARCH_SOURCE_PREFIX,
          operation: "search",
          model: input.model,
          requests: input.requests,
          providerCostMicros: charge.providerMicros,
          marginBps: charge.marginBps,
          basis: "list_price",
        },
      });
    },
  );
  return { creditMicros: charge.creditMicros };
}
