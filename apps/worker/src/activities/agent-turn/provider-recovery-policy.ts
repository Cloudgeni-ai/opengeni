import {
  effectiveProviderRecoveryStartedAt,
  FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE,
} from "@opengeni/db/provider-recovery-clock";
// Required first-party MCP setup has no dispatched tool to replay. Keep the
// accepted turn pending while our own API is unavailable; human controls and
// ordinary attempt/authority fences still decide whether it may run.
export { FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE } from "@opengeni/db/provider-recovery-clock";
export const FIRST_PARTY_MCP_SETUP_RETRY_MS = 30_000;

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

/**
 * The model provider could not be reached at all: its name did not resolve
 * for now, there was no route, or the connection was refused. That is what a
 * lost internet connection looks like, and five quick retries cannot outlast
 * it. Keep the turn parked and retry at a calm pace for up to six hours from
 * the first failure, so it continues by itself when the connection returns.
 * A new message from the person still ends the wait at once.
 */
export const PROVIDER_UNREACHABLE_RECOVERY_CODE = "provider_unreachable";
export const PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;
export const PROVIDER_UNREACHABLE_BACKOFF_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
export const MAX_AUTOMATIC_PROVIDER_UNREACHABLE_RECOVERIES = 90;

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
  if (code === PROVIDER_UNREACHABLE_RECOVERY_CODE) {
    return {
      maxRecoveries: MAX_AUTOMATIC_PROVIDER_UNREACHABLE_RECOVERIES,
      windowMs: PROVIDER_UNREACHABLE_RECOVERY_WINDOW_MS,
    };
  }
  return null;
}

export function validProviderOverloadRecoveryDelay(code: unknown, delay: unknown): boolean {
  if (code === FIRST_PARTY_MCP_SETUP_UNAVAILABLE_CODE) {
    return (
      typeof delay === "number" &&
      Number.isSafeInteger(delay) &&
      delay >= FIRST_PARTY_MCP_SETUP_RETRY_MS
    );
  }
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
  return effectiveProviderRecoveryStartedAt(metadata);
}
