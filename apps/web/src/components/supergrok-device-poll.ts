import { OpenGeniApiError, type SuperGrokConnectPoll } from "@opengeni/sdk";
import { pollDeviceAuthorization } from "@opengeni/connect";

/** A network failure or an API error marked retryable keeps a device login waiting. */
export function isRetryableDevicePollError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof OpenGeniApiError && error.retryable);
}

/** Native and embedded clients share provider pacing, cancellation and backoff. */
export function pollSuperGrokDeviceLogin(options: {
  poll: () => Promise<SuperGrokConnectPoll>;
  initialIntervalSeconds: number;
  expiresAtMs: number;
  signal: AbortSignal;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
  maxRetryDelaySeconds?: number;
}): Promise<SuperGrokConnectPoll | null> {
  return pollDeviceAuthorization({
    ...options,
    expired: { status: "expired" } as SuperGrokConnectPoll,
    retryable: isRetryableDevicePollError,
  });
}
