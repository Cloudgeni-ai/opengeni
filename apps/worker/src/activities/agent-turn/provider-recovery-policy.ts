/** Closed policy facts shared with the workflow's content-free recovery wire. */
export const PROVIDER_OVERLOAD_RECOVERY_CODE = "provider_overloaded";
export const MAX_AUTOMATIC_PROVIDER_OVERLOAD_RECOVERIES = 15;
export const PROVIDER_OVERLOAD_RECOVERY_WINDOW_MS = 15 * 60_000;

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
