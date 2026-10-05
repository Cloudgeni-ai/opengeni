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
  listUnsettledVoiceTranscriptionCharges,
  recordUsageEvent,
  sumUsageQuantity,
  VOICE_TRANSCRIPTION_DEBIT_TYPE,
  VOICE_TRANSCRIPTION_SOURCE_TYPE,
  voiceTranscriptionSettlementKeys,
  type CreditDebitAttribution,
  type Database,
} from "@opengeni/db";
import {
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  type TranscriptionBilling,
  type TranscriptionBillingContext,
} from "../transcription";
import { voiceCreditStanding, voiceInsufficientCreditsMessage } from "./realtime-voice-billing";

/** Credit debit type and usage source for deployment-funded voice input. */
export const VOICE_INPUT_DEBIT_TYPE = VOICE_TRANSCRIPTION_DEBIT_TYPE;
export const VOICE_INPUT_SOURCE_TYPE = VOICE_TRANSCRIPTION_SOURCE_TYPE;

/** How the billed quantity was measured; recorded on the ledger entry. */
export type VoiceInputBillingBasis =
  | "provider_tokens"
  | "provider_duration"
  | "server_duration"
  | "reconciled_receipt";

/**
 * Pick the billed measurement. Provider usage wins when this deployment can
 * price it (token usage with token rates, or a reported duration). Otherwise
 * the duration the server measured from WAV bytes it produced bills. Every
 * deployment-funded call carries that server duration, so an unpriced usage
 * shape never leaves a call unbillable. A client-reported duration is never a
 * billing input.
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
  /** Reconciliation is best-effort at admission; failures are reported here. */
  onReconcileError?: (error: unknown, scope: { accountId: string; workspaceId: string }) => void;
  /** Minimum spacing of admission-time reconciliation per workspace (default 5 min). */
  reconcileIntervalMilliseconds?: number;
}): TranscriptionBilling {
  const reconcileInterval = deps.reconcileIntervalMilliseconds ?? 5 * 60_000;
  const lastReconciled = new Map<string, number>();
  const reconcileDue = (key: string) => {
    const now = Date.now();
    const last = lastReconciled.get(key);
    if (last !== undefined && now - last < reconcileInterval) return false;
    if (lastReconciled.size >= 10_000) lastReconciled.clear();
    lastReconciled.set(key, now);
    return true;
  };
  return {
    async admit({ accountId, workspaceId, attribution }) {
      if (!voiceInputCreditBillingActive(deps.settings)) return;
      if (attribution.kind === "unknown") {
        // Not a microphone problem: the caller's credential has no payer the
        // ledger can attribute, so the deployment refuses by policy.
        throw new TranscriptionServiceError({
          code: "policy_blocked",
          status: 403,
          message: "Voice input payer could not be verified.",
        });
      }
      // Debits whose receipt committed but whose ledger write failed are
      // applied before the balance read, so unsettled use counts against it.
      // Throttled per workspace: failed debits are rare, the scan is not free.
      if (reconcileDue(`${accountId}:${workspaceId}`)) {
        await reconcileUnsettledVoiceInputCharges(deps.db, { accountId, workspaceId }).catch(
          (error: unknown) => {
            deps.onReconcileError?.(error, { accountId, workspaceId });
          },
        );
      }
      const balance = await getSpendableCreditBalance(deps.db, accountId);
      if (balance.balanceMicros <= 0) {
        throw new TranscriptionBillingRefusedError({
          code: "insufficient_credits",
          message: voiceInsufficientCreditsMessage("Voice input", voiceCreditStanding(balance)),
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

    async settle(input) {
      if (!voiceInputCreditBillingActive(deps.settings)) return { creditCostMicros: 0 };
      const { usage, basis } = voiceInputBillableUsage({
        pricing: input.pricing,
        usage: input.usage,
        trustedDurationSeconds: input.billing.trustedDurationSeconds,
      });
      const cost = calculateVoiceInputCost(input.pricing, usage);
      return await settleVoiceInputUsage(deps.db, {
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
 * Two commits, in order: the `model.cost` usage receipt (Insights spend,
 * monthly cost cap, member-allowance attribution), then the post-use credit
 * debit. The receipt is the first-writer authority for the amount and the
 * durable record of the charge: if the debit commit fails, the receipt stays
 * and {@link reconcileUnsettledVoiceInputCharges} applies the same debit (same
 * idempotency key) on the workspace's next admission. A retried unit settles
 * exactly once at the originally recorded price.
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
  const keys = voiceTranscriptionSettlementKeys({
    workspaceId: input.workspaceId,
    sourceId: input.billing.sourceId,
  });
  const receipt = await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: input.creditCostMicros,
    unit: "usd_micros",
    sourceResourceType: VOICE_TRANSCRIPTION_SOURCE_TYPE,
    sourceResourceId: input.billing.sourceId,
    idempotencyKey: keys.usageIdempotencyKey,
    // The API is the writer; the payer is the trusted attribution snapshot.
    initiator: { kind: "service", subjectId: "api:voice-input" },
    initiatorContext: { creditDebitAttribution: attribution },
  });
  const amount = Number(receipt.quantity);
  if (amount > 0) {
    await applyCreditDebitAfterUse(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: VOICE_TRANSCRIPTION_DEBIT_TYPE,
      amountMicros: amount,
      sourceType: VOICE_TRANSCRIPTION_SOURCE_TYPE,
      sourceId: input.billing.sourceId,
      idempotencyKey: keys.debitIdempotencyKey,
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
}

/**
 * Apply the debit for every voice usage receipt in this workspace whose debit
 * never committed. Idempotent with the inline settlement (same key), bounded
 * per call, and safe to run concurrently.
 */
export async function reconcileUnsettledVoiceInputCharges(
  db: Database,
  input: { accountId: string; workspaceId: string; minAgeMilliseconds?: number },
): Promise<{ reconciled: number }> {
  const pending = await listUnsettledVoiceTranscriptionCharges(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(input.minAgeMilliseconds !== undefined
      ? { minAgeMilliseconds: input.minAgeMilliseconds }
      : {}),
  });
  for (const charge of pending) {
    await applyCreditDebitAfterUse(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: VOICE_TRANSCRIPTION_DEBIT_TYPE,
      amountMicros: charge.amountMicros,
      sourceType: VOICE_TRANSCRIPTION_SOURCE_TYPE,
      sourceId: charge.sourceId,
      idempotencyKey: voiceTranscriptionSettlementKeys({
        workspaceId: input.workspaceId,
        sourceId: charge.sourceId,
      }).debitIdempotencyKey,
      metadata: {
        basis: "reconciled_receipt" satisfies VoiceInputBillingBasis,
        ...(charge.attribution.kind === "unknown"
          ? {}
          : creditDebitAttributionMetadata(charge.attribution)),
      },
    });
  }
  return { reconciled: pending.length };
}
