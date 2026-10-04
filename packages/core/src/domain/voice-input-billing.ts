import {
  calculateVoiceInputCost,
  configuredStaticUsageLimits,
  voiceInputCreditBillingActive,
  voiceInputPricingHasTokenRates,
  type Settings,
  type VoiceInputPricing,
  type VoiceInputUsage,
} from "@opengeni/config";
import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  creditDebitAttributionMetadata,
  getSpendableCreditBalance,
  recordUsageEvent,
  sumUsageQuantity,
  withRlsContext,
  type CreditDebitAttribution,
  type Database,
} from "@opengeni/db";
import {
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  type TranscriptionBilling,
  type TranscriptionBillingContext,
} from "../transcription";

/** Credit debit type and usage source for deployment-funded voice input. */
export const VOICE_INPUT_DEBIT_TYPE = "voice_transcription_debit";
export const VOICE_INPUT_SOURCE_TYPE = "voice_transcription";

/** How the billed quantity was measured; recorded on the ledger entry. */
export type VoiceInputBillingBasis = "provider_tokens" | "provider_duration" | "server_duration";

/**
 * Pick the billed measurement. Provider-reported usage always wins. Without
 * it, only a duration the server measured from bytes it produced is trusted;
 * otherwise settlement refuses to invent a charge. A client-reported duration is
 * never a billing input.
 */
export function voiceInputBillableUsage(input: {
  pricing: VoiceInputPricing;
  usage: VoiceInputUsage | null;
  trustedDurationSeconds?: number | undefined;
}): { usage: VoiceInputUsage; basis: VoiceInputBillingBasis } {
  if (input.usage?.kind === "tokens" && voiceInputPricingHasTokenRates(input.pricing)) {
    return { usage: input.usage, basis: "provider_tokens" };
  }
  if (input.usage?.kind === "duration") {
    return { usage: input.usage, basis: "provider_duration" };
  }
  if (
    input.trustedDurationSeconds !== undefined &&
    Number.isFinite(input.trustedDurationSeconds) &&
    input.trustedDurationSeconds >= 0
  ) {
    return {
      usage: { kind: "duration", seconds: input.trustedDurationSeconds },
      basis: "server_duration",
    };
  }
  throw new TranscriptionServiceError({
    code: "provider",
    message: "Transcription usage was not reported.",
  });
}

function initiatingHuman(attribution: CreditDebitAttribution): string | null {
  return attribution.kind === "human" || attribution.kind === "turn"
    ? attribution.initiatingHumanSubjectId
    : null;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Same admission shape as knowledge-search and session admission: general
 * (not model-promotional) credits must be positive, the workspace/member
 * allowance must not be exhausted, and a static monthly cost cap applies.
 * Admission is a read, not a reservation; settlement is post-use and may take
 * an account below zero by at most the concurrent in-flight calls.
 */
export function createVoiceInputBilling(deps: {
  db: Database;
  settings: Settings;
}): TranscriptionBilling {
  return {
    async admit({ accountId, workspaceId, attribution }) {
      if (!voiceInputCreditBillingActive(deps.settings)) return;
      if (attribution.kind === "unknown") {
        throw new TranscriptionServiceError({
          code: "permission_denied",
          message: "Voice input payer could not be verified.",
        });
      }
      const balance = await getSpendableCreditBalance(deps.db, accountId);
      if (balance.balanceMicros <= 0) {
        throw new TranscriptionBillingRefusedError({
          code: "insufficient_credits",
          message: "Voice input needs Opengeni credits. Add credits to continue.",
        });
      }
      const refusal = await checkWorkspaceAllowance(deps.db, {
        accountId,
        workspaceId,
        subjectId: initiatingHuman(attribution),
      });
      if (refusal) {
        throw new TranscriptionBillingRefusedError({
          code: refusal.code,
          message: refusal.message,
          details: {
            scope: refusal.scope,
            resetsAt: refusal.resetsAt,
            ...(refusal.subjectId ? { subjectId: refusal.subjectId } : {}),
          },
        });
      }
      if (
        deps.settings.usageLimitsMode === "static" ||
        deps.settings.usageLimitsMode === "managed"
      ) {
        const cap = configuredStaticUsageLimits(deps.settings).maxMonthlyCostMicrosPerAccount;
        if (cap) {
          const used = await sumUsageQuantity(deps.db, {
            accountId,
            eventType: "model.cost",
            since: startOfUtcMonth(),
          });
          if (used >= cap) {
            throw new TranscriptionBillingRefusedError({
              code: "monthly_model_cost_limit",
              message: "The monthly model cost limit has been reached.",
            });
          }
        }
      }
    },

    async settle(input, transaction) {
      if (!voiceInputCreditBillingActive(deps.settings)) return { creditCostMicros: 0 };
      const { usage, basis } = voiceInputBillableUsage({
        pricing: input.pricing,
        usage: input.usage,
        trustedDurationSeconds: input.billing.trustedDurationSeconds,
      });
      const cost = calculateVoiceInputCost(input.pricing, usage);
      return await settleVoiceInputUsage(transaction ?? deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        model: input.model,
        billing: input.billing,
        usage,
        basis,
        providerCostMicros: cost.providerCostMicros,
        creditCostMicros: cost.creditCostMicros,
      });
    },
  };
}

/**
 * One transaction: the `model.cost` usage receipt (Insights spend, monthly
 * cost cap) and the post-use credit debit. The usage row is the first-writer
 * authority for the amount, so a retried unit (resumable segment re-sent to
 * the provider) settles exactly once at the originally recorded price.
 */
export async function settleVoiceInputUsage(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerId: string;
    model: string;
    billing: TranscriptionBillingContext;
    usage: VoiceInputUsage;
    basis: VoiceInputBillingBasis;
    providerCostMicros: number;
    creditCostMicros: number;
  },
): Promise<{ creditCostMicros: number }> {
  const attribution = input.billing.attribution;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const receipt = await recordUsageEvent(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "model.cost",
        quantity: input.creditCostMicros,
        unit: "usd_micros",
        sourceResourceType: input.billing.sourceType,
        sourceResourceId: input.billing.sourceId,
        idempotencyKey: `voice.transcription_cost:${input.billing.sourceId}`,
        // The API is the writer; the payer is the trusted attribution snapshot.
        initiator: { kind: "service", subjectId: "api:voice-input" },
        initiatorContext: { creditDebitAttribution: attribution },
      });
      const amount = Number(receipt.quantity);
      if (amount > 0) {
        await applyCreditDebitAfterUse(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          type: VOICE_INPUT_DEBIT_TYPE,
          amountMicros: amount,
          sourceType: input.billing.sourceType,
          sourceId: input.billing.sourceId,
          idempotencyKey: `credit:${VOICE_INPUT_DEBIT_TYPE}:${input.billing.idempotencyKey}`,
          metadata: {
            providerId: input.providerId,
            model: input.model,
            basis: input.basis,
            providerCostMicros: input.providerCostMicros,
            ...(input.usage.kind === "tokens"
              ? {
                  inputTokens: input.usage.inputTokens,
                  audioInputTokens: input.usage.audioInputTokens,
                  textInputTokens: input.usage.textInputTokens,
                  outputTokens: input.usage.outputTokens,
                }
              : { audioMilliseconds: Math.ceil(input.usage.seconds * 1_000) }),
            ...(attribution.kind === "unknown" ? {} : creditDebitAttributionMetadata(attribution)),
          },
        });
      }
      return { creditCostMicros: amount };
    },
  );
}
