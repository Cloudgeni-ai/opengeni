/** Claim-time shared-core helpers. */

/** The stored shared-core lease-busy chain, ignoring anything malformed. */
export function readSubscriptionLeaseBusyChain(
  metadata: Record<string, unknown> | null | undefined,
): { startedAt: number; executionGeneration: number } | undefined {
  const value = metadata?.subscriptionLeaseBusy;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const startedAt =
    typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
  const generation = record.executionGeneration;
  return Number.isFinite(startedAt) &&
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? { startedAt, executionGeneration: generation }
    : undefined;
}
