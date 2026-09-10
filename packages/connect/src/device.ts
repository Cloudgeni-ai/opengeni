/** Shared device-code behavior for model-account domains. These accounts keep
 * their existing APIs and ownership semantics; they are not generic credentials.
 * Keep opaque provider state on the host backend when reload recovery is needed. */
export async function pollDeviceAuthorization<
  T extends { status: string; intervalSeconds?: number },
>(options: {
  poll: () => Promise<T>;
  expired: T;
  initialIntervalSeconds: number;
  expiresAtMs: number;
  signal: AbortSignal;
  retryable?: (error: unknown) => boolean;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
  maxRetryDelaySeconds?: number;
}): Promise<T | null> {
  const now = options.now ?? Date.now;
  if (
    !Number.isFinite(options.expiresAtMs) ||
    !Number.isFinite(options.initialIntervalSeconds) ||
    options.initialIntervalSeconds <= 0 ||
    (options.maxRetryDelaySeconds !== undefined &&
      (!Number.isFinite(options.maxRetryDelaySeconds) || options.maxRetryDelaySeconds <= 0))
  )
    throw new Error("Device authorization requires a finite expiry and polling interval");
  const wait = options.wait ?? waitForDeviceDelay;
  const initial = Math.max(1, options.initialIntervalSeconds);
  const maximum = Math.max(initial, options.maxRetryDelaySeconds ?? 30);
  let delay = initial;
  while (!options.signal.aborted) {
    const remaining = options.expiresAtMs - now();
    if (remaining <= 0) return options.expired;
    if (!(await wait(Math.min(delay * 1000, remaining), options.signal)) || options.signal.aborted)
      return null;
    if (now() >= options.expiresAtMs) return options.expired;
    let result: T;
    try {
      const observed = await observeDevicePoll(
        options.poll,
        options.expiresAtMs - now(),
        options.signal,
      );
      if (observed.kind === "aborted") return null;
      if (observed.kind === "expired") return options.expired;
      result = observed.result;
    } catch (error) {
      if (!options.retryable?.(error)) throw error;
      delay = Math.min(maximum, Math.max(initial, delay * 2));
      continue;
    }
    if (options.signal.aborted) return null;
    if (result.status !== "pending" && result.status !== "slow_down") return result;
    if (
      result.intervalSeconds !== undefined &&
      (!Number.isFinite(result.intervalSeconds) || result.intervalSeconds <= 0)
    )
      throw new Error("Provider returned an invalid device polling interval");
    delay = Math.max(
      1,
      result.intervalSeconds ?? (result.status === "slow_down" ? delay + 5 : delay),
    );
  }
  return null;
}

/** A transport may ignore cancellation. Bound observation without retrying an
 * in-flight request or treating the loss of observation as provider success. */
async function observeDevicePoll<T>(
  poll: () => Promise<T>,
  remainingMs: number,
  signal: AbortSignal,
): Promise<{ kind: "result"; result: T } | { kind: "aborted" } | { kind: "expired" }> {
  if (signal.aborted) return { kind: "aborted" };
  if (remainingMs <= 0) return { kind: "expired" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const stopped = new Promise<{ kind: "aborted" } | { kind: "expired" }>((resolve) => {
      abort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => resolve({ kind: "expired" }), remainingMs);
    });
    return await Promise.race([
      Promise.resolve()
        .then(poll)
        .then((result) => ({ kind: "result" as const, result })),
      stopped,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function waitForDeviceDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
