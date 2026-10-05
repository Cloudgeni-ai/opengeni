import {
  AI_GATEWAY_REALTIME_MODELS,
  AZURE_LIVE_REALTIME_MODEL_ID,
  configuredStaticUsageLimits,
  parseRealtimeVoicePricingJson,
  parseRealtimeVoicePricingTableJson,
  realtimeVoiceMinuteCreditMicros,
  realtimeVoiceStartedMinutes,
  voiceInputCreditBillingActive,
  type RealtimeVoicePricing,
  type Settings,
} from "@opengeni/config";
import type { SessionRealtimeModel } from "@opengeni/contracts";
import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  creditDebitAttributionMetadata,
  existingUsageEventIdempotencyKeys,
  getSpendableCreditBalance,
  loadSessionRealtimeBillingFacts,
  recordUsageEvent,
  sumUsageQuantity,
  withRlsContext,
  type CreditDebitAttribution,
  type Database,
} from "@opengeni/db";
import { TranscriptionBillingRefusedError } from "../transcription";

/** Credit debit type and usage source for deployment-funded live voice. */
export const REALTIME_VOICE_DEBIT_TYPE = "voice_realtime_debit";
export const REALTIME_VOICE_SOURCE_TYPE = "voice_realtime";

export type DeploymentRealtimeVoice = {
  provider: "azure-live" | "ai-gateway";
  /** Credentials exist and this deployment offers the model. */
  configured: boolean;
  pricing: RealtimeVoicePricing | null;
};

/**
 * Live-voice models the deployment pays the provider for. Connected Codex,
 * SuperGrok, and a workspace's own Gateway key are paid by the workspace and
 * return null. (The catalog lists hosted GPT Live instead of the managed
 * Gateway choices when both are configured; both remain priced and gated.)
 */
const reportedPricingErrors = new Set<string>();

/**
 * Malformed pricing withholds the model (like voice input) instead of failing
 * API/worker boot; each distinct error is logged once.
 */
function tolerantPricing<T>(parse: () => T, fallback: T): T {
  try {
    return parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!reportedPricingErrors.has(message)) {
      reportedPricingErrors.add(message);
      console.error(`Live voice pricing ignored: ${message}`);
    }
    return fallback;
  }
}

export function deploymentRealtimeVoice(
  settings: Settings,
  model: SessionRealtimeModel | string,
): DeploymentRealtimeVoice | null {
  const azureConfigured = Boolean(settings.azureLiveEndpoint && settings.azureLiveApiKey?.trim());
  if (model === AZURE_LIVE_REALTIME_MODEL_ID) {
    return {
      provider: "azure-live",
      configured: azureConfigured,
      pricing: tolerantPricing(
        () =>
          parseRealtimeVoicePricingJson(
            settings.azureLivePricingJson,
            "OPENGENI_AZURE_LIVE_PRICING_JSON",
          ),
        null,
      ),
    };
  }
  for (const gateway of Object.values(AI_GATEWAY_REALTIME_MODELS)) {
    if (gateway.managedModelId !== model) continue;
    return {
      provider: "ai-gateway",
      configured: Boolean(settings.vercelAiGatewayApiKey),
      pricing:
        tolerantPricing(
          () =>
            parseRealtimeVoicePricingTableJson(
              settings.aiGatewayRealtimePricingJson,
              "OPENGENI_AI_GATEWAY_REALTIME_PRICING_JSON",
            ),
          {} as Record<string, RealtimeVoicePricing>,
        )[gateway.upstreamModelId] ?? null,
    };
  }
  return null;
}

export type RealtimeVoiceUnavailableCode = "not_configured" | "pricing_unconfigured";

/** The deployment cannot offer this live-voice model at all (not a credit refusal). */
export class RealtimeVoiceUnavailableError extends Error {
  readonly name = "RealtimeVoiceUnavailableError";
  constructor(
    readonly code: RealtimeVoiceUnavailableCode,
    message: string,
  ) {
    super(message);
  }
}

/** Static offer check: configured, and priced whenever credits are enforced. */
export function realtimeVoiceOfferProblem(
  settings: Settings,
  voice: DeploymentRealtimeVoice,
): RealtimeVoiceUnavailableError | null {
  if (!voice.configured) {
    return new RealtimeVoiceUnavailableError(
      "not_configured",
      "Opengeni live voice is not configured on this deployment.",
    );
  }
  if (voiceInputCreditBillingActive(settings) && !voice.pricing) {
    return new RealtimeVoiceUnavailableError(
      "pricing_unconfigured",
      "Opengeni live voice is not available on this deployment yet.",
    );
  }
  return null;
}

export const REALTIME_VOICE_INSUFFICIENT_CREDITS_MESSAGE =
  "Live voice needs Opengeni credits. Add credits to continue.";

/** Spendable general credits, only model-scoped free credits, or neither. */
export type VoiceCreditStanding = "spendable" | "promotional_only" | "none";

export function voiceCreditStanding(balance: {
  balanceMicros: number;
  promotionalCredits?: readonly { remainingMicros: number }[] | undefined;
}): VoiceCreditStanding {
  if (balance.balanceMicros > 0) return "spendable";
  return (balance.promotionalCredits ?? []).some((grant) => grant.remainingMicros > 0)
    ? "promotional_only"
    : "none";
}

/**
 * Insufficient-credit copy for voice. Free credits are scoped to chat models,
 * so an account holding only those must not be told it has nothing.
 */
export function voiceInsufficientCreditsMessage(
  feature: "Live voice" | "Voice input",
  standing: VoiceCreditStanding,
): string {
  return standing === "promotional_only"
    ? `Free credits don't cover ${feature.toLowerCase()}. Add credits to use it.`
    : `${feature} needs Opengeni credits. Add credits to continue.`;
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function initiatingHuman(attribution: CreditDebitAttribution): string | null {
  return attribution.kind === "human" || attribution.kind === "turn"
    ? attribution.initiatingHumanSubjectId
    : null;
}

export type RealtimeVoiceSettlement = {
  /** Credits debited by this settlement call (0 on replay). */
  debitedMicros: number;
  /** Why the live call must stop now, when it must. */
  stop: TranscriptionBillingRefusedError | RealtimeVoiceUnavailableError | null;
};

/**
 * Credit admission and time metering for deployment-funded live voice.
 *
 * Admission mirrors voice-input admission (same refusal codes and HTTP
 * shape): spendable general credits must be positive, the workspace/member
 * allowance must not be exhausted, and the static monthly cost cap applies.
 * Metering bills every started minute of each issued provider connection,
 * measured only from server-observed facts (connection claim time, owner
 * heartbeats, owner-proven end). Each (connection, minute) is one idempotent
 * usage receipt plus one post-use debit.
 */
export function createRealtimeVoiceBilling(deps: { db: Database; settings: Settings }) {
  const billingActive = () => voiceInputCreditBillingActive(deps.settings);

  async function refusal(input: {
    accountId: string;
    workspaceId: string;
    attribution: CreditDebitAttribution;
    now: Date;
  }): Promise<TranscriptionBillingRefusedError | null> {
    const balance = await getSpendableCreditBalance(deps.db, input.accountId);
    if (balance.balanceMicros <= 0) {
      return new TranscriptionBillingRefusedError({
        code: "insufficient_credits",
        message: voiceInsufficientCreditsMessage("Live voice", voiceCreditStanding(balance)),
      });
    }
    const allowance = await checkWorkspaceAllowance(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: initiatingHuman(input.attribution),
    });
    if (allowance) {
      return new TranscriptionBillingRefusedError({
        code: allowance.code,
        message: allowance.message,
        details: {
          scope: allowance.scope,
          resetsAt: allowance.resetsAt,
          ...(allowance.subjectId ? { subjectId: allowance.subjectId } : {}),
        },
      });
    }
    if (deps.settings.usageLimitsMode === "static" || deps.settings.usageLimitsMode === "managed") {
      const cap = configuredStaticUsageLimits(deps.settings).maxMonthlyCostMicrosPerAccount;
      if (cap) {
        const used = await sumUsageQuantity(deps.db, {
          accountId: input.accountId,
          eventType: "model.cost",
          since: startOfUtcMonth(input.now),
        });
        if (used >= cap) {
          return new TranscriptionBillingRefusedError({
            code: "monthly_model_cost_limit",
            message: "The monthly model cost limit has been reached.",
          });
        }
      }
    }
    return null;
  }

  return {
    /**
     * Throws RealtimeVoiceUnavailableError when the deployment cannot offer
     * the model and TranscriptionBillingRefusedError for a credit refusal.
     * Workspace-funded models are always admitted here.
     */
    async admit(input: {
      accountId: string;
      workspaceId: string;
      model: SessionRealtimeModel;
      attribution: CreditDebitAttribution;
      now?: Date;
    }): Promise<void> {
      const voice = deploymentRealtimeVoice(deps.settings, input.model);
      if (!voice) return;
      const problem = realtimeVoiceOfferProblem(deps.settings, voice);
      if (problem) throw problem;
      if (!billingActive()) return;
      const refused = await refusal({ ...input, now: input.now ?? new Date() });
      if (refused) throw refused;
    },

    /** Spendable credits are positive (always true when credits are not enforced). */
    async hasSpendableCredits(accountId: string): Promise<boolean> {
      return (await this.creditStanding(accountId)) === "spendable";
    },

    /** Credit standing for live voice ("spendable" when credits are not enforced). */
    async creditStanding(accountId: string): Promise<VoiceCreditStanding> {
      if (!billingActive()) return "spendable";
      return voiceCreditStanding(await getSpendableCreditBalance(deps.db, accountId));
    },

    /**
     * Settle every started minute observed so far for one live-voice mode and
     * report whether the call must stop. Safe to call repeatedly and
     * concurrently: receipts and debits are idempotent per (connection, minute).
     */
    async settle(input: {
      workspaceId: string;
      sessionId: string;
      realtimeId: string;
      /** Authenticated caller; its attribution applies only when it owns the call. */
      callerSubjectId: string;
      attribution: CreditDebitAttribution;
      now?: Date;
    }): Promise<RealtimeVoiceSettlement> {
      const now = input.now ?? new Date();
      if (!billingActive()) return { debitedMicros: 0, stop: null };
      const facts = await loadSessionRealtimeBillingFacts(deps.db, { ...input, now });
      if (!facts) return { debitedMicros: 0, stop: null };
      const voice = deploymentRealtimeVoice(deps.settings, facts.model);
      if (!voice) return { debitedMicros: 0, stop: null };
      if (!voice.pricing) {
        // Pricing was removed after admission: nothing to bill against, so the
        // call must end rather than continue unpriced.
        return {
          debitedMicros: 0,
          stop: new RealtimeVoiceUnavailableError(
            "pricing_unconfigured",
            "Opengeni live voice is no longer available on this deployment.",
          ),
        };
      }
      const attribution: CreditDebitAttribution =
        input.callerSubjectId === facts.ownerSubjectId ? input.attribution : { kind: "unknown" };
      const cost = realtimeVoiceMinuteCreditMicros(voice.pricing);
      const minutes = facts.connections.flatMap((connection) =>
        Array.from(
          { length: realtimeVoiceStartedMinutes(connection.startedAt, connection.observedUntil) },
          (_, index) => ({
            connectionId: connection.id,
            minute: index + 1,
            startsAt: new Date(connection.startedAt.getTime() + index * 60_000),
            key: `voice.realtime_cost:${connection.id}:${index + 1}`,
          }),
        ),
      );
      const recorded = await existingUsageEventIdempotencyKeys(deps.db, {
        accountId: facts.accountId,
        workspaceId: facts.workspaceId,
        keys: minutes.map((minute) => minute.key),
      });
      let debitedMicros = 0;
      for (const minute of minutes) {
        if (recorded.has(minute.key)) continue;
        debitedMicros += await withRlsContext(
          deps.db,
          { accountId: facts.accountId, workspaceId: facts.workspaceId },
          async (tx) => {
            const sourceId = `${minute.connectionId}:${minute.minute}`;
            const receipt = await recordUsageEvent(tx, {
              accountId: facts.accountId,
              workspaceId: facts.workspaceId,
              sessionId: facts.sessionId,
              eventType: "model.cost",
              quantity: cost.creditCostMicros,
              unit: "usd_micros",
              sourceResourceType: REALTIME_VOICE_SOURCE_TYPE,
              sourceResourceId: sourceId,
              idempotencyKey: minute.key,
              occurredAt: minute.startsAt,
              initiator: { kind: "service", subjectId: "api:voice-realtime" },
              initiatorContext: { creditDebitAttribution: attribution },
            });
            const amount = Number(receipt.quantity);
            if (amount <= 0) return 0;
            const debit = await applyCreditDebitAfterUse(tx, {
              accountId: facts.accountId,
              workspaceId: facts.workspaceId,
              type: REALTIME_VOICE_DEBIT_TYPE,
              amountMicros: amount,
              sourceType: REALTIME_VOICE_SOURCE_TYPE,
              sourceId,
              idempotencyKey: `credit:${REALTIME_VOICE_DEBIT_TYPE}:${sourceId}`,
              occurredAt: minute.startsAt,
              metadata: {
                provider: voice.provider,
                model: facts.model,
                realtimeId: facts.realtimeId,
                connectionId: minute.connectionId,
                minute: minute.minute,
                basis: "server_observed_started_minute",
                providerCostMicros: cost.providerCostMicros,
                ...(attribution.kind === "unknown"
                  ? {}
                  : creditDebitAttributionMetadata(attribution)),
              },
            });
            return debit.debitedMicros;
          },
        );
      }
      const stop =
        facts.state === "active"
          ? await refusal({
              accountId: facts.accountId,
              workspaceId: facts.workspaceId,
              attribution,
              now,
            })
          : null;
      return { debitedMicros, stop };
    },
  };
}

export type RealtimeVoiceBilling = ReturnType<typeof createRealtimeVoiceBilling>;
