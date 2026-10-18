/** Closed policy facts shared with the workflow's content-free recovery wire. */
export const PROVIDER_OVERLOAD_RECOVERY_CODE = "provider_overloaded";
export const MAX_AUTOMATIC_PROVIDER_OVERLOAD_RECOVERIES = 15;
export const PROVIDER_OVERLOAD_RECOVERY_WINDOW_MS = 15 * 60_000;

/**
 * A required MCP server that answers 503 is up but refusing work, which is
 * what a deployment or maintenance window looks like. Wait it out for a
 * bounded time instead of spending the short connectivity budget in two
 * minutes: paced retries for up to ten minutes from the first failure.
 */
export const MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE = "mcp_service_unavailable";
export const MAX_AUTOMATIC_MCP_SERVICE_UNAVAILABLE_RECOVERIES = 30;
export const MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS = 10 * 60_000;
export const MCP_SERVICE_UNAVAILABLE_BACKOFF_MS = [5_000, 10_000, 15_000, 30_000] as const;

/** Recovery codes bounded by elapsed time from the first failure, not only by count. */
export function windowedRecoveryPolicy(
  code: unknown,
): { maxRecoveries: number; windowMs: number } | null {
  if (code === PROVIDER_OVERLOAD_RECOVERY_CODE) {
    return {
      maxRecoveries: MAX_AUTOMATIC_PROVIDER_OVERLOAD_RECOVERIES,
      windowMs: PROVIDER_OVERLOAD_RECOVERY_WINDOW_MS,
    };
  }
  if (code === MCP_SERVICE_UNAVAILABLE_RECOVERY_CODE) {
    return {
      maxRecoveries: MAX_AUTOMATIC_MCP_SERVICE_UNAVAILABLE_RECOVERIES,
      windowMs: MCP_SERVICE_UNAVAILABLE_RECOVERY_WINDOW_MS,
    };
  }
  return null;
}

export function validProviderOverloadRecoveryDelay(code: unknown, delay: unknown): boolean {
  if (delay === undefined) return code !== PROVIDER_OVERLOAD_RECOVERY_CODE;
  return (
    code === PROVIDER_OVERLOAD_RECOVERY_CODE &&
    typeof delay === "number" &&
    Number.isSafeInteger(delay) &&
    delay > 0 &&
    delay < PROVIDER_OVERLOAD_RECOVERY_WINDOW_MS
  );
}

export function readProviderRecoveryStartedAt(
  metadata: Record<string, unknown>,
): number | undefined {
  const value =
    typeof metadata.providerRecoveryStartedAt === "string"
      ? Date.parse(metadata.providerRecoveryStartedAt)
      : NaN;
  return Number.isFinite(value) ? value : undefined;
}
