import { OpenGeniApiError, type SuperGrokConnectPoll } from "@opengeni/sdk";
import { pollDeviceAuthorization } from "@opengeni/connect";

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
    retryable: (error) =>
      error instanceof TypeError || (error instanceof OpenGeniApiError && error.retryable),
  });
}
