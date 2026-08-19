import { OpenGeniApiError, type SuperGrokConnectPoll } from "@opengeni/sdk";

type WaitForDelay = (delayMs: number, signal: AbortSignal) => Promise<boolean>;

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isRetryablePollError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof OpenGeniApiError && error.retryable);
}

export async function pollSuperGrokDeviceLogin(options: {
  poll: () => Promise<SuperGrokConnectPoll>;
  initialIntervalSeconds: number;
  expiresAtMs: number;
  signal: AbortSignal;
  now?: () => number;
  wait?: WaitForDelay;
  maxRetryDelaySeconds?: number;
}): Promise<SuperGrokConnectPoll | null> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForDelay;
  const initialIntervalSeconds = Math.max(1, options.initialIntervalSeconds);
  const maxRetryDelaySeconds = Math.max(initialIntervalSeconds, options.maxRetryDelaySeconds ?? 30);
  let nextDelaySeconds = initialIntervalSeconds;

  while (!options.signal.aborted) {
    const remainingMs = options.expiresAtMs - now();
    if (remainingMs <= 0) return { status: "expired" };
    const elapsed = await wait(Math.min(nextDelaySeconds * 1_000, remainingMs), options.signal);
    if (!elapsed || options.signal.aborted) return null;
    if (now() >= options.expiresAtMs) return { status: "expired" };

    let result: SuperGrokConnectPoll;
    try {
      result = await options.poll();
    } catch (error) {
      if (!isRetryablePollError(error)) throw error;
      nextDelaySeconds = Math.min(
        maxRetryDelaySeconds,
        Math.max(initialIntervalSeconds, nextDelaySeconds * 2),
      );
      continue;
    }
    if (options.signal.aborted) return null;
    if (result.status !== "pending" && result.status !== "slow_down") return result;
    nextDelaySeconds = Math.max(1, result.intervalSeconds ?? nextDelaySeconds);
  }
  return null;
}
