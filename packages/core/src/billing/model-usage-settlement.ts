import {
  calculateGatewayReportedCostBreakdown,
  calculateGatewayReportedProviderCostMicros,
  calculateModelListUsageCostSnapshot,
  calculateModelUsageCostBreakdown,
  canonicalizeConfiguredModelId,
  configuredModelListPricingSchedules,
  configuredModelPricingSchedules,
  resolveModelProvider,
  OPENGENI_GATEWAY_PROVIDER_ID,
  OPPER_PROVIDER_ID,
  ORGANIZATION_OPPER_PROVIDER_ID,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  WORKSPACE_OPPER_PROVIDER_ID,
  type Settings,
} from "@opengeni/config";
import type { LatencyMode } from "@opengeni/contracts";
import type { InsightsUsageClassMicros } from "@opengeni/contracts/insights-usage";
import { applyCreditDebitUpToBalance, recordUsageEvent, type Database } from "@opengeni/db";
import type { ModelCallUsageNormalization, ModelResponseUsage } from "@opengeni/runtime";
import type { ModelUsageInput } from "@opengeni/config";

/**
 * Price and settle one authoritative model response: the token-cap usage
 * event, the `model.cost` event, and (for Opengeni-credit models) the
 * idempotent credit debit. Agent turns and stateless single model calls both
 * settle here; `sourceId` is the durable identity every idempotency key
 * derives from, so a retried settlement never charges twice.
 */

export type ModelUsageBillingRecord = {
  billingPath: "opengeni_credits" | "external";
  /** Same quantity written to usage_events.model.cost when present; else 0. */
  pricedCostMicros: number;
  /** Hypothetical provider-rate USD micros; never an Opengeni charge. */
  estimatedProviderCostMicros: number | null;
  /** Hypothetical Opengeni credit price at the captured rate; never a debit. */
  equivalentCreditCostMicros: number | null;
  pricingSource: "configured_list_price" | "gateway_reported" | null;
  /** Forward-only provider list class snapshot; older facts/events stay unknown. */
  listByClassMicros?: InsightsUsageClassMicros | null;
  listByClassApprox?: boolean;
  normalizedUsage: ModelCallUsageNormalization;
  upstreamProvider?: string;
};

// Exported for unit testing the external-billing bypass; not part of the activity surface.

export type ModelUsageSettlementInput = {
  accountId: string;
  workspaceId: string;
  /** Product model id used for pricing and ledger attribution. */
  model: string;
  chargesOpenGeniCredits: boolean;
  countsTowardTokenCap: boolean;
  creditPolicyRevision?: number | undefined;
  gatewayBilling?: ModelResponseUsage["gatewayBilling"];
  normalizedUsage: ModelCallUsageNormalization;
  /** Durable source identity (for a turn, `${turnId}:${sourceKey}`). */
  sourceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  turnAttemptId?: string | null;
  latencyMode?: LatencyMode;
  /** Non-secret correlation fields added to the credit debit metadata. */
  debitMetadata?: Record<string, unknown>;
  /** Best-effort metrics hook after a committed debit. */
  onCreditsDebited?: (result: { debitedMicros: number; grantDebitedMicros: number }) => void;
};

export async function settleModelUsage(
  settings: Settings,
  db: Database,
  input: ModelUsageSettlementInput,
): Promise<ModelUsageBillingRecord> {
  const normalizedUsage = input.normalizedUsage;
  const usageContext = {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.turnAttemptId ? { turnAttemptId: input.turnAttemptId } : {}),
  };
  const sanitizedUsage = sanitizedModelUsageInput(normalizedUsage);
  const inputTokens = sanitizedUsage.inputTokens ?? 0;
  const outputTokens = sanitizedUsage.outputTokens ?? 0;
  const totalTokens = sanitizedUsage.totalTokens ?? 0;
  const { chargesOpenGeniCredits, countsTowardTokenCap } = input;
  const resolvedGatewayModel = input.gatewayBilling
    ? resolveModelProvider(settings, input.model)
    : undefined;
  const gatewayProviderId = resolvedGatewayModel?.provider.id;
  // Opper reports the exact USD cost of every response (`usage.opper.cost`);
  // the Chat adapter surfaces it with `finalProvider: "opper"`.
  const opperReported =
    (gatewayProviderId === OPPER_PROVIDER_ID ||
      gatewayProviderId === WORKSPACE_OPPER_PROVIDER_ID ||
      gatewayProviderId === ORGANIZATION_OPPER_PROVIDER_ID) &&
    input.gatewayBilling?.finalProvider === "opper";
  const gatewayBilling =
    gatewayProviderId === OPENGENI_GATEWAY_PROVIDER_ID ||
    gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID ||
    opperReported
      ? input.gatewayBilling
      : undefined;
  const allowedProviders = resolvedGatewayModel?.model.requestPolicy?.gateway.only;
  // Scoped Opper rails settle externally; record the exact provider cost only.
  const unpinnedWorkspaceGatewayModel =
    (gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID && allowedProviders === undefined) ||
    (opperReported && gatewayProviderId !== OPPER_PROVIDER_ID);
  if (gatewayBilling && !opperReported) {
    if (
      !unpinnedWorkspaceGatewayModel &&
      (!allowedProviders ||
        !(allowedProviders as readonly string[]).includes(gatewayBilling.finalProvider))
    ) {
      throw new Error(
        `AI Gateway reported unapproved provider ${gatewayBilling.finalProvider} for ${input.model}`,
      );
    }
    if (unpinnedWorkspaceGatewayModel && chargesOpenGeniCredits) {
      throw new Error(
        `Workspace Gateway custom model ${input.model} cannot charge Opengeni credits without pinned pricing`,
      );
    }
  }
  const pricingSchedules = configuredModelPricingSchedules(settings);
  const configuredPricingModel = pricingSchedules[input.model]
    ? input.model
    : input.model.startsWith("codex/") && pricingSchedules[input.model.slice("codex/".length)]
      ? input.model.slice("codex/".length)
      : null;
  const pricingBreakdown = gatewayBilling
    ? unpinnedWorkspaceGatewayModel
      ? {
          providerCostMicros: calculateGatewayReportedProviderCostMicros(
            gatewayBilling.inferenceCostUsd,
          ),
          creditCostMicros: 0,
        }
      : calculateGatewayReportedCostBreakdown(
          settings,
          configuredPricingModel ?? input.model,
          gatewayBilling.inferenceCostUsd,
          { inputTokens },
        )
    : configuredPricingModel
      ? calculateModelUsageCostBreakdown(settings, configuredPricingModel, sanitizedUsage, {
          latencyMode: input.latencyMode ?? "standard",
        })
      : null;
  const hasCompleteCoreTokenTelemetry =
    normalizedUsage.telemetry.inputTokens !== null &&
    normalizedUsage.telemetry.outputTokens !== null;
  // Comparison rates are deliberately separate from debit authority. The
  // current usage frame does not establish geography/service-tier provenance,
  // so forward class splits stay unknown even when a total estimate is priced.
  const listPricingSchedules = configuredModelListPricingSchedules(settings);
  const configuredListPricingModel = listPricingSchedules[input.model]
    ? input.model
    : input.model.startsWith("codex/") && listPricingSchedules[input.model.slice("codex/".length)]
      ? input.model.slice("codex/".length)
      : null;
  const listSnapshot =
    !gatewayBilling && hasCompleteCoreTokenTelemetry && configuredListPricingModel
      ? calculateModelListUsageCostSnapshot(settings, configuredListPricingModel, sanitizedUsage, {
          latencyMode: input.latencyMode ?? "standard",
          priceContextKnown: false,
        })
      : null;
  const listClasses = {
    listByClassMicros: listSnapshot?.listByClassMicros ?? null,
    listByClassApprox: listSnapshot?.listByClassApprox ?? false,
  };
  const estimatedProviderCostMicros = gatewayBilling
    ? (pricingBreakdown?.providerCostMicros ?? null)
    : hasCompleteCoreTokenTelemetry
      ? (listSnapshot?.providerCostMicros ?? pricingBreakdown?.providerCostMicros ?? null)
      : null;
  const equivalentCreditCostMicros =
    pricingBreakdown && !unpinnedWorkspaceGatewayModel
      ? gatewayBilling || hasCompleteCoreTokenTelemetry
        ? pricingBreakdown.creditCostMicros
        : null
      : null;
  const pricingSource = gatewayBilling
    ? ("gateway_reported" as const)
    : estimatedProviderCostMicros !== null
      ? ("configured_list_price" as const)
      : null;
  // Provider settlement and workspace-facing cost are separate. Externally
  // metered subscription/workspace turns remain exempt from the Opengeni token
  // cap, while a deployment-funded free model still records model.tokens. Every
  // non-credit path records a zero-cost marker and never consults pricing for a
  // debit.
  if (countsTowardTokenCap && totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: input.sourceId,
      ...usageContext,
      idempotencyKey: `usage:model.tokens:${input.sourceId}`,
    });
  }
  if (!chargesOpenGeniCredits) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      quantity: 0,
      unit: "usd_micros",
      sourceResourceType: "model_response",
      sourceResourceId: input.sourceId,
      ...usageContext,
      idempotencyKey: `usage:model.cost:${input.sourceId}`,
    });
    return {
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros,
      equivalentCreditCostMicros,
      pricingSource,
      ...listClasses,
      normalizedUsage,
      ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
    };
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || (totalTokens === 0 && !gatewayBilling)) {
    return {
      billingPath: "opengeni_credits",
      pricedCostMicros: 0,
      estimatedProviderCostMicros,
      equivalentCreditCostMicros,
      pricingSource,
      ...listClasses,
      normalizedUsage,
      ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
    };
  }
  if (!pricingBreakdown) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = pricingBreakdown.creditCostMicros;
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: input.sourceId,
    ...usageContext,
    idempotencyKey: `usage:model.cost:${input.sourceId}`,
  });
  if (costMicros > 0) {
    const result = await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
      modelId: canonicalizeConfiguredModelId(settings, input.model),
      creditPolicyRevision: input.creditPolicyRevision,
      sourceType: "model_response",
      sourceId: input.sourceId,
      idempotencyKey: `credit:model_usage_debit:${input.sourceId}`,
      metadata: {
        model: input.model,
        ...input.debitMetadata,
        latencyMode: input.latencyMode ?? "standard",
        inputTokens,
        outputTokens,
        totalTokens,
        // Additive: the prompt-cache slice of this call's input tokens, so the
        // per-call debit record carries cache efficiency alongside the token
        // counts. 0 when the provider did not report cached tokens.
        cachedTokens: normalizedUsage.telemetry.cachedTokens ?? 0,
        ...(gatewayBilling ? { gatewayProvider: gatewayBilling.finalProvider } : {}),
      },
    });
    try {
      input.onCreditsDebited?.(result);
    } catch {
      // The debit is committed; metrics are best-effort only.
    }
  }
  return {
    billingPath: "opengeni_credits",
    pricedCostMicros: costMicros,
    estimatedProviderCostMicros,
    equivalentCreditCostMicros,
    pricingSource,
    ...listClasses,
    normalizedUsage,
    ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
  };
}

/** Bounded, validated token counts for pricing; raw provider values never price. */
export function sanitizedModelUsageInput(normalized: ModelCallUsageNormalization): ModelUsageInput {
  return {
    ...(normalized.telemetry.inputTokens !== null
      ? { inputTokens: normalized.telemetry.inputTokens }
      : {}),
    ...(normalized.telemetry.outputTokens !== null
      ? { outputTokens: normalized.telemetry.outputTokens }
      : {}),
    ...(normalized.totalTokens !== null ? { totalTokens: normalized.totalTokens } : {}),
    ...(normalized.telemetry.cachedTokens !== null ||
    normalized.telemetry.cacheWriteTokens !== null ||
    normalized.cacheWriteTokensByTtl !== undefined
      ? {
          inputTokensDetails: {
            ...(normalized.telemetry.cachedTokens === null
              ? {}
              : { cached_tokens: normalized.telemetry.cachedTokens }),
            ...(normalized.telemetry.cacheWriteTokens === null
              ? {}
              : { cache_write_tokens: normalized.telemetry.cacheWriteTokens }),
            ...(normalized.cacheWriteTokensByTtl?.fiveMinute == null
              ? {}
              : { cache_write_tokens_5m: normalized.cacheWriteTokensByTtl.fiveMinute }),
            ...(normalized.cacheWriteTokensByTtl?.oneHour == null
              ? {}
              : { cache_write_tokens_1h: normalized.cacheWriteTokensByTtl.oneHour }),
          },
        }
      : {}),
    ...(normalized.requestUsageEntries
      ? { requestUsageEntries: normalized.requestUsageEntries }
      : {}),
  };
}
