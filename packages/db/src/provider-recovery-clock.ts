/** Internal API setup waits pause elapsed provider recovery, never its retry count. */
export const FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE = "first_party_mcp_setup_unavailable";
export const PROVIDER_RECOVERY_SUSPENDED_AT = "internalMcpSetupWaitStartedAt";

export function effectiveProviderRecoveryStartedAt(
  metadata: Record<string, unknown>,
  now = Date.now(),
): number | undefined {
  const started =
    typeof metadata.providerRecoveryStartedAt === "string"
      ? Date.parse(metadata.providerRecoveryStartedAt)
      : NaN;
  if (!Number.isFinite(started)) return undefined;
  const suspended = metadata[PROVIDER_RECOVERY_SUSPENDED_AT];
  if (suspended === undefined) return started;
  const paused = typeof suspended === "string" ? Date.parse(suspended) : NaN;
  if (!Number.isFinite(paused) || !Number.isFinite(now) || paused > now || paused < started)
    return undefined;
  return started + (now - paused);
}

export function recoverProviderClockAfterDependencyWait(
  metadata: Record<string, unknown>,
  reason: string,
  now: Date,
): Record<string, unknown> {
  const next = { ...metadata };
  if (reason === FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE) {
    // Keep the first durable wait instant through every replacement attempt.
    next[PROVIDER_RECOVERY_SUSPENDED_AT] ??= now.toISOString();
  } else if (next[PROVIDER_RECOVERY_SUSPENDED_AT] !== undefined) {
    if (next.providerRecoveryStartedAt !== undefined) {
      const adjusted = effectiveProviderRecoveryStartedAt(next, now.getTime());
      next.providerRecoveryStartedAt =
        adjusted === undefined ? "invalid" : new Date(adjusted).toISOString();
    }
    delete next[PROVIDER_RECOVERY_SUSPENDED_AT];
  }
  return next;
}
