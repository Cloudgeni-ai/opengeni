import { z } from "zod";

/**
 * Credit pricing for deployment-funded live (speech-to-speech) voice.
 *
 * Live voice is metered by server-observed connection time, billed per started
 * minute. Prices are deployment configuration, never code defaults: when credit
 * billing is active, a deployment-funded voice model without a configured price
 * is not offered and cannot be started.
 */
export type RealtimeVoicePricing = {
  /** Upstream cost of one minute of live voice, in USD micros. */
  microsPerMinute: number;
  /** Opengeni margin in basis points added on top of the upstream cost. */
  marginBps?: number | undefined;
};

const RealtimeVoicePricingSchema = z
  .object({
    microsPerMinute: z.number().int().positive().max(100_000_000),
    marginBps: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

/** Model id of the deployment-hosted Azure GPT Live voice. */
export const AZURE_LIVE_REALTIME_MODEL_ID = "opengeni-azure/gpt-live-1" as const;

function parseJson(raw: string, env: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${env} must be valid JSON`);
  }
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** One live-voice price, e.g. `{"microsPerMinute":50000,"marginBps":500}`. */
export function parseRealtimeVoicePricingJson(
  raw: string | undefined,
  env = "live voice pricing JSON",
): RealtimeVoicePricing | null {
  if (raw === undefined || raw.trim() === "") return null;
  const result = RealtimeVoicePricingSchema.safeParse(parseJson(raw, env));
  if (!result.success) throw new Error(`${env} is invalid: ${issues(result.error)}`);
  return result.data;
}

/**
 * Prices keyed by upstream AI Gateway realtime model id, e.g.
 * `{"openai/gpt-realtime-2.1":{"microsPerMinute":120000,"marginBps":500}}`.
 */
export function parseRealtimeVoicePricingTableJson(
  raw: string | undefined,
  env = "live voice pricing table JSON",
): Record<string, RealtimeVoicePricing> {
  if (raw === undefined || raw.trim() === "") return {};
  const result = z
    .record(z.string().min(1).max(256), RealtimeVoicePricingSchema)
    .safeParse(parseJson(raw, env));
  if (!result.success) throw new Error(`${env} is invalid: ${issues(result.error)}`);
  return result.data;
}

/** Credit price of one started minute, after margin, rounded up to whole micros. */
export function realtimeVoiceMinuteCreditMicros(pricing: RealtimeVoicePricing): {
  providerCostMicros: number;
  creditCostMicros: number;
} {
  const provider = BigInt(pricing.microsPerMinute);
  const credit = (provider * BigInt(10_000 + (pricing.marginBps ?? 0)) + 9_999n) / 10_000n;
  return { providerCostMicros: Number(provider), creditCostMicros: Number(credit) };
}

/** Billed minutes for a server-observed interval: every started minute, at least one. */
export function realtimeVoiceStartedMinutes(startedAt: Date, observedUntil: Date): number {
  const elapsed = Math.max(0, observedUntil.getTime() - startedAt.getTime());
  return Math.max(1, Math.ceil(elapsed / 60_000));
}
