/**
 * Retry a load that treats `null` as "not visible yet".
 *
 * A resolved write is already durable. This helper is only for reads that
 * assume the object exists (a ready row, a client upload we are completing,
 * or a key we just persisted). Other errors fail immediately. Still missing
 * after the budget is a real miss.
 */

export const OBJECT_VISIBILITY_RETRY_DELAYS_MS = [50, 100, 200, 400, 400, 400, 400] as const;

export type RetryWhileMissingOptions = {
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
};

export async function retryWhileMissing<T>(
  load: () => Promise<T | null>,
  options: RetryWhileMissingOptions = {},
): Promise<T | null> {
  const delays = options.delaysMs ?? OBJECT_VISIBILITY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    const value = await load();
    if (value !== null) return value;
    if (attempt >= delays.length) return null;
    await sleep(delays[attempt]!);
    throwIfAborted(options.signal);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = signal.reason;
    throw error instanceof Error ? error : new Error("Object visibility wait was cancelled");
  }
}
