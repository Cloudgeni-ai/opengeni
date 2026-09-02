import {
  applyCreditDebitUpToBalance,
  recordUsageEvent,
  recordModelCallFact,
  type AppendEventInput,
  type CanonicalTurnStartupMilestoneReceipt,
} from "@opengeni/db";
import {
  modelResponseServiceTierFromSdkEvent,
  modelTerminalResponseFromSdkEvent,
  normalizeModelCallUsage,
  type ModelResponseUsage,
  type ModelCallUsageInput,
  type ModelCallUsageNormalization,
} from "@opengeni/runtime";
import {
  calculateGatewayReportedCostBreakdown,
  calculateGatewayReportedProviderCostMicros,
  calculateModelUsageCostBreakdown,
  configuredModelPricingSchedules,
  resolveModelProvider,
  responseSatisfiesLatencyMode,
  OPENGENI_GATEWAY_PROVIDER_ID,
  WORKSPACE_GATEWAY_PROVIDER_ID,
  type ModelUsageInput,
  type ModelProviderApi,
  type Settings,
} from "@opengeni/config";
import { CODEX_PROVIDER_ID } from "@opengeni/codex";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  modelCallAccountContext,
  recordCreditMicros,
  recordModelCacheTokens,
  recordModelInputTokens,
} from "../../observability-metrics";
import {
  type LatencyMode,
  type ModelContextContributionSummary,
  type SessionEvent,
} from "@opengeni/contracts";
import { safeErrorDiagnostic } from "./errors";

export function modelUsageSourceKey(input: {
  responseId?: string | null | undefined;
  dispatchId: string | null;
  positionalKey: string;
}): string {
  if (input.responseId) {
    return input.responseId;
  }
  return input.dispatchId ? `${input.dispatchId}:${input.positionalKey}` : input.positionalKey;
}

export function providerContextTokens(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): number | null {
  const total = normalizeModelCallUsage(usage).totalTokens;
  return total !== null && total > 0 ? total : null;
}

/**
 * A provider call has already consumed tokens by the time its usage frame is
 * available. Losing the Codex credential lease at the renewal checkpoint must
 * stop the result from becoming authoritative, but it must not erase accounting
 * truth for the call that already happened. Meter first, then surface the lost
 * lease, then write attempt-owned token/context signals. A replaced attempt can
 * reject those signals without erasing the provider usage already incurred.
 */
export async function recordCompletedModelCallBeforeOwnershipFences(input: {
  renewLease: () => Promise<void>;
  recordUsage: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  recordAttemptSignals?: () => Promise<void>;
}): Promise<void> {
  await input.renewLease();
  await input.recordUsage();
  if (input.leaseLost()) {
    throw new Error(input.leaseLostMessage);
  }
  await input.recordAttemptSignals?.();
}

export type TurnEventPublisher = (
  events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>,
  immediate?: boolean,
) => Promise<{
  events: SessionEvent[];
  accepted: boolean;
  canonicalStartupMilestones: CanonicalTurnStartupMilestoneReceipt[];
}>;

export type ModelResponseEventState = {
  responseCount: number;
  contextSignal: { revision: number; totalTokens: number } | null;
  claimedSourceKeys: Set<string>;
};

export type CompactionModelUsageEventState = {
  usageCount: number;
  claimedSourceKeys: Set<string>;
};

export function createModelResponseEventState(
  claimedSourceKeys: Set<string> = new Set<string>(),
): ModelResponseEventState {
  return {
    responseCount: 0,
    contextSignal: null,
    claimedSourceKeys,
  };
}

export function createCompactionModelUsageEventState(
  claimedSourceKeys: Set<string> = new Set<string>(),
): CompactionModelUsageEventState {
  return { usageCount: 0, claimedSourceKeys };
}

export const createSessionTitleModelUsageEventState = createCompactionModelUsageEventState;

export function modelResponseContextSignal(
  state: ModelResponseEventState,
): { revision: number; totalTokens: number } | null {
  return state.contextSignal;
}

export function assertModelResponseLatencyMode(input: {
  event: Parameters<typeof modelResponseServiceTierFromSdkEvent>[0];
  requested: LatencyMode;
  model: string;
  /** When set to Codex ChatGPT auth, response `service_tier` is not an honor signal. */
  providerId?: string;
}): void {
  if (input.requested === "standard") {
    return;
  }
  // ChatGPT-auth Codex (subscription): Fast maps to request `service_tier=priority`
  // (see openai/codex ServiceTier::Fast.request_value). The backend may still return
  // `response.service_tier=default`; OpenAI maintainers document that this does not
  // mean Fast was ignored. Native CLI also does not fail closed on that field.
  if (input.providerId === CODEX_PROVIDER_ID) {
    return;
  }
  const serviceTierEvent = modelResponseServiceTierFromSdkEvent(input.event);
  if (
    !serviceTierEvent ||
    (serviceTierEvent.source === "normalized" && serviceTierEvent.serviceTier === null)
  ) {
    return;
  }
  if (!responseSatisfiesLatencyMode(input.requested, serviceTierEvent.serviceTier)) {
    throw new Error(
      `Provider did not honor ${input.requested} latency mode for ${input.model}: response service_tier=${serviceTierEvent.serviceTier ?? "missing"}`,
    );
  }
}

/**
 * Process one SDK terminal-response event through the production authority path.
 *
 * The pinned Responses SDK mirrors one provider terminal response as both a
 * normalized `response_done` and a raw `model/response.completed` event. Claim
 * the stable response/source key before lease renewal or any side effect, and
 * use that one positional ordinal for both response identity and same-run
 * context binding. A response without usage still clears attempt-owned token
 * state. When usage exists, the durable `agent.model.usage` source-key fence
 * remains the cross-restart authority: a replay may retry the idempotent billing
 * write, but it cannot advance metrics, context, or attempt-owned signals.
 */
export async function processModelResponseTerminalEvent(input: {
  event: Parameters<typeof modelTerminalResponseFromSdkEvent>[0];
  state: ModelResponseEventState;
  dispatchId: string | null;
  settings: Settings;
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  latencyMode?: LatencyMode;
  metricProvider: string;
  externallyBilled: boolean;
  chargesOpenGeniCredits?: boolean;
  countsTowardTokenCap?: boolean;
  servingCredentialId: string | null;
  priorSessionCredentialId: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  setLastInputTokens: (tokens: number | null) => Promise<void>;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<
  | { status: "not_response" }
  | { status: "duplicate"; sourceKey: string }
  | {
      status: "processed";
      sourceKey: string;
      authoritative: boolean;
      usageReported: boolean;
    }
> {
  const terminal = modelTerminalResponseFromSdkEvent(input.event);
  if (!terminal) {
    return { status: "not_response" };
  }

  const responseOrdinal = input.state.responseCount + 1;
  const sourceKey = modelUsageSourceKey({
    responseId: terminal.responseId,
    dispatchId: input.dispatchId,
    positionalKey: `response-${responseOrdinal}`,
  });
  if (input.state.claimedSourceKeys.has(sourceKey)) {
    return { status: "duplicate", sourceKey };
  }
  input.state.claimedSourceKeys.add(sourceKey);
  input.state.responseCount = responseOrdinal;

  const responseUsage = terminal.usage;

  const normalizedUsage = normalizeModelCallUsage(responseUsage?.usage);
  const accountContext = modelCallAccountContext({
    servingCredentialId: input.servingCredentialId,
    priorSessionCredentialId: input.priorSessionCredentialId,
    isFirstCallOfTurn: responseOrdinal === 1,
  });
  // A terminal response without usage still authoritatively replaces the
  // attempt-owned context signal. There is simply no billing event to claim.
  let authoritative = responseUsage === null;
  await recordCompletedModelCallBeforeOwnershipFences({
    renewLease: input.renewLease,
    leaseLost: input.leaseLost,
    leaseLostMessage: input.leaseLostMessage,
    recordUsage: async () => {
      if (!responseUsage) return;
      const billing = await recordModelUsageAndDebitCredits(input.settings, input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnAttemptId: input.turnAttemptId,
        model: input.model,
        externallyBilled: input.externallyBilled,
        ...(input.chargesOpenGeniCredits !== undefined
          ? { chargesOpenGeniCredits: input.chargesOpenGeniCredits }
          : {}),
        ...(input.countsTowardTokenCap !== undefined
          ? { countsTowardTokenCap: input.countsTowardTokenCap }
          : {}),
        usage: responseUsage.usage,
        normalizedUsage,
        gatewayBilling: responseUsage.gatewayBilling,
        sourceKey,
        ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
        observability: input.observability,
      });
      authoritative = await emitModelCallUsage({
        observability: input.observability,
        publish: input.publish,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        sourceKey,
        usage: responseUsage,
        normalizedUsage,
        ...(billing ? { billingPath: billing.billingPath } : {}),
        ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
        servingAccountHash: accountContext.servingAccountHash,
        accountChangedFromPrevCall: accountContext.accountChangedFromPrevCall,
        emittedSourceKeys: input.emittedSourceKeys,
      });
      if (authoritative && billing) {
        await recordAuthoritativeModelCallFact({
          db: input.db,
          observability: input.observability,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          billing,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
        });
      }
      const observedInput = normalizedUsage.telemetry.inputTokens;
      if (authoritative && observedInput !== null && observedInput > 0) {
        recordModelInputTokens(input.observability, input.metricProvider, observedInput);
      }
    },
    recordAttemptSignals: async () => {
      if (!authoritative) return;
      const observedTotal = normalizedUsage.totalTokens;
      input.state.contextSignal =
        observedTotal !== null && observedTotal > 0
          ? { revision: responseOrdinal, totalTokens: observedTotal }
          : null;
      const observedInput = normalizedUsage.telemetry.inputTokens;
      await input.setLastInputTokens(
        observedInput !== null && observedInput > 0 ? observedInput : null,
      );
    },
  });
  return {
    status: "processed",
    sourceKey,
    authoritative,
    usageReported: responseUsage !== null,
  };
}

/**
 * Apply the same source-key authority ordering to the compaction summarizer's
 * usage callback. The summarizer can retry or mirror a terminal response just
 * like the main stream, so claim before lease renewal, billing, durable usage,
 * logging, or cache metrics. Durable source-key idempotency remains the
 * cross-process authority after a worker restart.
 */
export async function processCompactionModelUsageEvent(input: {
  usage: ModelResponseUsage;
  state: CompactionModelUsageEventState;
  sourceKind?: "compaction" | "session-title";
  dispatchId: string | null;
  settings: Settings;
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  externallyBilled: boolean;
  chargesOpenGeniCredits?: boolean;
  countsTowardTokenCap?: boolean;
  servingCredentialId: string | null;
  priorSessionCredentialId: string | null;
  emittedSourceKeys: Set<string>;
  renewLease: () => Promise<void>;
  leaseLost: () => boolean;
  leaseLostMessage: string;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<
  | { status: "duplicate"; sourceKey: string }
  | { status: "processed"; sourceKey: string; authoritative: boolean }
> {
  const usageOrdinal = input.state.usageCount + 1;
  const sourceKey = modelUsageSourceKey({
    responseId: input.usage.responseId,
    dispatchId: input.dispatchId,
    positionalKey: `${input.sourceKind ?? "compaction"}-${usageOrdinal}`,
  });
  if (input.state.claimedSourceKeys.has(sourceKey)) {
    return { status: "duplicate", sourceKey };
  }
  input.state.claimedSourceKeys.add(sourceKey);
  input.state.usageCount = usageOrdinal;

  const accountContext = modelCallAccountContext({
    servingCredentialId: input.servingCredentialId,
    priorSessionCredentialId: input.priorSessionCredentialId,
    isFirstCallOfTurn: usageOrdinal === 1,
  });
  const normalizedUsage = normalizeModelCallUsage(input.usage.usage);
  let authoritative = false;
  await recordCompletedModelCallBeforeOwnershipFences({
    renewLease: input.renewLease,
    leaseLost: input.leaseLost,
    leaseLostMessage: input.leaseLostMessage,
    recordUsage: async () => {
      const billing = await recordModelUsageAndDebitCredits(input.settings, input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnAttemptId: input.turnAttemptId,
        model: input.model,
        externallyBilled: input.externallyBilled,
        ...(input.chargesOpenGeniCredits !== undefined
          ? { chargesOpenGeniCredits: input.chargesOpenGeniCredits }
          : {}),
        ...(input.countsTowardTokenCap !== undefined
          ? { countsTowardTokenCap: input.countsTowardTokenCap }
          : {}),
        usage: input.usage.usage,
        normalizedUsage,
        gatewayBilling: input.usage.gatewayBilling,
        sourceKey,
        observability: input.observability,
      });
      authoritative = await emitModelCallUsage({
        observability: input.observability,
        publish: input.publish,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        sourceKey,
        usage: input.usage,
        normalizedUsage,
        ...(billing ? { billingPath: billing.billingPath } : {}),
        ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
        servingAccountHash: accountContext.servingAccountHash,
        accountChangedFromPrevCall: accountContext.accountChangedFromPrevCall,
        emittedSourceKeys: input.emittedSourceKeys,
      });
      if (authoritative && billing) {
        await recordAuthoritativeModelCallFact({
          db: input.db,
          observability: input.observability,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
          sourceKey,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          billing,
          ...(input.contextContributions !== undefined
            ? { contextContributions: input.contextContributions }
            : {}),
        });
      }
    },
  });
  return { status: "processed", sourceKey, authoritative };
}

export async function processSessionTitleModelUsageEvent(
  input: Omit<Parameters<typeof processCompactionModelUsageEvent>[0], "sourceKind">,
): ReturnType<typeof processCompactionModelUsageEvent> {
  return await processCompactionModelUsageEvent({
    ...input,
    sourceKind: "session-title",
  });
}

export async function emitModelCallUsage(input: {
  observability: ActivityServices["observability"];
  publish: TurnEventPublisher | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  sourceKey: string;
  usage: ModelResponseUsage | { usage?: unknown | null } | null;
  normalizedUsage?: ModelCallUsageNormalization;
  /** Accepted billing authority persisted for Insights repair after a soft fact-write failure. */
  billingPath?: ModelUsageBillingRecord["billingPath"];
  /** Validated Gateway endpoint provider persisted for exact Insights repair. */
  upstreamProvider?: string;
  // Prompt-cache research dimensions (log-only; NEVER on a metric label or a
  // durable event). The opaque serving-account tag and whether it changed since
  // the session's previous call — the account-switch hypothesis for cache misses.
  servingAccountHash?: string;
  accountChangedFromPrevCall?: boolean;
  emittedSourceKeys?: Set<string>;
}): Promise<boolean> {
  const usage =
    input.usage && typeof input.usage === "object" && "usage" in input.usage
      ? (input.usage as { usage?: unknown }).usage
      : null;
  if (!usage || typeof usage !== "object") {
    return false;
  }
  if (input.emittedSourceKeys?.has(input.sourceKey)) return false;
  const normalizedUsage =
    input.normalizedUsage ?? normalizeModelCallUsage(usage as ModelCallUsageInput);
  const telemetry = normalizedUsage.telemetry;
  const appended = await input.publish?.(
    [
      {
        type: "agent.model.usage",
        payload: {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          provider: input.provider,
          providerApi: input.providerApi,
          model: input.model,
          sourceKey: input.sourceKey,
          ...(input.billingPath ? { billingPath: input.billingPath } : {}),
          ...(input.upstreamProvider ? { upstreamProvider: input.upstreamProvider } : {}),
          ...telemetry,
        },
      },
    ],
    true,
  );
  input.emittedSourceKeys?.add(input.sourceKey);
  const authoritative = appended?.events.some(
    (event) =>
      event.type === "agent.model.usage" &&
      event.turnAssociation === "current" &&
      event.payload !== null &&
      typeof event.payload === "object" &&
      (event.payload as Record<string, unknown>).sourceKey === input.sourceKey,
  );
  if (!authoritative) return false;
  try {
    input.observability.info("model call usage", {
      provider: input.provider,
      providerApi: input.providerApi,
      model: input.model,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      cachedTokens: telemetry.cachedTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      reasoningTokens: telemetry.reasoningTokens,
      ...(input.servingAccountHash !== undefined
        ? { servingAccountHash: input.servingAccountHash }
        : {}),
      ...(input.accountChangedFromPrevCall !== undefined
        ? { accountChangedFromPrevCall: input.accountChangedFromPrevCall }
        : {}),
    });
    if (normalizedUsage.rejectedFields.length > 0) {
      input.observability.warn("model call usage fields rejected", {
        provider: input.provider,
        providerApi: input.providerApi,
        model: input.model,
        rejectedFields: normalizedUsage.rejectedFields.join(","),
      });
    }
  } catch {
    // Durable event + billing already committed; logging is best-effort only.
  }
  try {
    applyCodexCacheTelemetry(input.observability, input.provider, normalizedUsage);
  } catch {
    // Durable event + billing already committed; metrics are best-effort only.
  }
  return true;
}

/**
 * Apply one authoritative, normalized model-call usage frame to the shared
 * prompt-cache metrics. The durable source-key fence in `emitModelCallUsage`
 * owns idempotency; this helper must never receive raw provider values.
 */
export function applyCodexCacheTelemetry(
  observability: ActivityServices["observability"],
  provider: string,
  normalizedUsage: ModelCallUsageNormalization,
): void {
  recordModelCacheTokens(observability, provider, {
    cachedTokens: normalizedUsage.telemetry.cachedTokens,
    cacheWriteTokens: normalizedUsage.telemetry.cacheWriteTokens,
    promptTokens: normalizedUsage.telemetry.inputTokens,
  });
}

export type ModelUsageBillingRecord = {
  billingPath: "opengeni_credits" | "external";
  /** Same quantity written to usage_events.model.cost when present; else 0. */
  pricedCostMicros: number;
  /** Hypothetical provider-rate USD micros; never an OpenGeni charge. */
  estimatedProviderCostMicros: number | null;
  /** Hypothetical OpenGeni credit price at the captured rate; never a debit. */
  equivalentCreditCostMicros: number | null;
  pricingSource: "configured_list_price" | "gateway_reported" | null;
  normalizedUsage: ModelCallUsageNormalization;
  upstreamProvider?: string;
};

// Exported for unit testing the external-billing bypass; not part of the activity surface.
export async function recordModelUsageAndDebitCredits(
  settings: Settings,
  db: ActivityServices["db"],
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnAttemptId: string;
    model: string;
    externallyBilled: boolean;
    chargesOpenGeniCredits?: boolean;
    countsTowardTokenCap?: boolean;
    gatewayBilling?: ModelResponseUsage["gatewayBilling"];
    usage?: ModelUsageInput | ModelCallUsageInput | null;
    normalizedUsage?: ModelCallUsageNormalization;
    sourceKey: string;
    latencyMode?: LatencyMode;
    observability?: ActivityServices["observability"];
  },
): Promise<ModelUsageBillingRecord | null> {
  if (!input.usage) {
    return null;
  }
  const normalizedUsage = input.normalizedUsage ?? normalizeModelCallUsage(input.usage);
  const sanitizedUsage = sanitizedModelUsageInput(normalizedUsage);
  const inputTokens = sanitizedUsage.inputTokens ?? 0;
  const outputTokens = sanitizedUsage.outputTokens ?? 0;
  const totalTokens = sanitizedUsage.totalTokens ?? 0;
  const chargesOpenGeniCredits = input.chargesOpenGeniCredits ?? !input.externallyBilled;
  const countsTowardTokenCap = input.countsTowardTokenCap ?? !input.externallyBilled;
  const resolvedGatewayModel = input.gatewayBilling
    ? resolveModelProvider(settings, input.model)
    : undefined;
  const gatewayProviderId = resolvedGatewayModel?.provider.id;
  const gatewayBilling =
    gatewayProviderId === OPENGENI_GATEWAY_PROVIDER_ID ||
    gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID
      ? input.gatewayBilling
      : undefined;
  const allowedProviders = resolvedGatewayModel?.model.requestPolicy?.gateway.only;
  const unpinnedWorkspaceGatewayModel =
    gatewayProviderId === WORKSPACE_GATEWAY_PROVIDER_ID && allowedProviders === undefined;
  if (gatewayBilling) {
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
        `Workspace Gateway custom model ${input.model} cannot charge OpenGeni credits without pinned pricing`,
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
  const estimatedProviderCostMicros = gatewayBilling
    ? (pricingBreakdown?.providerCostMicros ?? null)
    : hasCompleteCoreTokenTelemetry
      ? (pricingBreakdown?.providerCostMicros ?? null)
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
  // metered subscription/workspace turns remain exempt from the OpenGeni token
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
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
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
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
    });
    return {
      billingPath: "external",
      pricedCostMicros: 0,
      estimatedProviderCostMicros,
      equivalentCreditCostMicros,
      pricingSource,
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
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
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
    recordCreditMicros(input.observability, "usage", result.debitedMicros);
  }
  return {
    billingPath: "opengeni_credits",
    pricedCostMicros: costMicros,
    estimatedProviderCostMicros,
    equivalentCreditCostMicros,
    pricingSource,
    normalizedUsage,
    ...(gatewayBilling ? { upstreamProvider: gatewayBilling.finalProvider } : {}),
  };
}

/** Soft-fail Insights fact write — never throws into the billing/emit path. */
export async function recordAuthoritativeModelCallFact(input: {
  db: ActivityServices["db"];
  observability: ActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  sourceKey: string;
  provider: string;
  providerApi: ModelProviderApi;
  model: string;
  billing: ModelUsageBillingRecord;
  contextContributions?: readonly ModelContextContributionSummary[] | null;
}): Promise<void> {
  try {
    const telemetry = input.billing.normalizedUsage.telemetry;
    await recordModelCallFact(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      sourceKey: input.sourceKey,
      provider: input.billing.upstreamProvider ?? input.provider,
      providerApi: input.providerApi,
      model: input.model,
      billingPath: input.billing.billingPath,
      pricedCostMicros: input.billing.pricedCostMicros,
      estimatedProviderCostMicros: input.billing.estimatedProviderCostMicros,
      equivalentCreditCostMicros: input.billing.equivalentCreditCostMicros,
      pricingSource: input.billing.pricingSource,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      cachedTokens: telemetry.cachedTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      reasoningTokens: telemetry.reasoningTokens,
      totalTokens: input.billing.normalizedUsage.totalTokens,
      ...(input.contextContributions !== undefined
        ? { contextContributions: input.contextContributions }
        : {}),
    });
  } catch (error) {
    input.observability.warn("model call fact persist failed", {
      ...safeErrorDiagnostic(error),
    });
  }
}

export function sanitizedModelUsageInput(normalized: ModelCallUsageNormalization): ModelUsageInput {
  return {
    ...(normalized.telemetry.inputTokens !== null
      ? { inputTokens: normalized.telemetry.inputTokens }
      : {}),
    ...(normalized.telemetry.outputTokens !== null
      ? { outputTokens: normalized.telemetry.outputTokens }
      : {}),
    ...(normalized.totalTokens !== null ? { totalTokens: normalized.totalTokens } : {}),
    ...(normalized.telemetry.cachedTokens !== null || normalized.telemetry.cacheWriteTokens !== null
      ? {
          inputTokensDetails: {
            ...(normalized.telemetry.cachedTokens === null
              ? {}
              : { cached_tokens: normalized.telemetry.cachedTokens }),
            ...(normalized.telemetry.cacheWriteTokens === null
              ? {}
              : { cache_write_tokens: normalized.telemetry.cacheWriteTokens }),
          },
        }
      : {}),
    ...(normalized.requestUsageEntries
      ? { requestUsageEntries: normalized.requestUsageEntries }
      : {}),
  };
}

export function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
