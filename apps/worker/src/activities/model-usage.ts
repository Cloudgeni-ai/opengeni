import { applyCreditDebitUpToBalance, recordUsageEvent, type Database } from "@opengeni/db";
import {
  calculateModelUsageCostMicros,
  configuredModelPricing,
  type ModelUsageInput,
  type Settings,
} from "@opengeni/config";
import type { Observability } from "@opengeni/observability";
import { modelCallUsageTelemetry } from "@opengeni/runtime/usage-telemetry";
import { recordCreditMicros } from "../observability-metrics";

export type ModelUsagePersistenceInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  model: string;
  isCodexTurn: boolean;
  usage?: ModelUsageInput | null;
  sourceKey: string;
};

/**
 * Idempotently settle accounting for one provider response. Kept in a
 * persistence-only module so both the side-effectful turn activity and the
 * retryable control activity use exactly the same ledger keys without giving
 * the control lane a path to provider, tool, or runtime execution.
 */
export async function recordModelUsageAndDebitCredits(
  settings: Settings,
  db: Database,
  input: ModelUsagePersistenceInput & { observability?: Observability },
): Promise<void> {
  if (!input.usage) {
    return;
  }
  const inputTokens = positiveInt(input.usage.inputTokens);
  const outputTokens = positiveInt(input.usage.outputTokens);
  const totalTokens = positiveInt(input.usage.totalTokens) || inputTokens + outputTokens;
  // A codex-subscription turn is paid by the user's ChatGPT/Codex plan, so it
  // consumes ZERO OpenGeni credits and must never feed an OpenGeni cap.
  if (input.isCodexTurn) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.cost",
      quantity: 0,
      unit: "usd_micros",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
    });
    return;
  }
  if (totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
    });
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || totalTokens === 0) {
    return;
  }
  if (!configuredModelPricing(settings)[input.model]) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = calculateModelUsageCostMicros(settings, input.model, input.usage);
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
  });
  if (costMicros > 0) {
    const result = await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
      sourceType: "model_response",
      sourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `credit:model_usage_debit:${input.turnId}:${input.sourceKey}`,
      metadata: {
        model: input.model,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKey: input.sourceKey,
        inputTokens,
        outputTokens,
        totalTokens,
        cachedTokens: positiveInt(modelCallUsageTelemetry(input.usage).cachedTokens),
      },
    });
    recordCreditMicros(input.observability, "usage", result.debitedMicros);
  }
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
