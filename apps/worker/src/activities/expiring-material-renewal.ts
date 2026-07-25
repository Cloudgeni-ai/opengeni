export type ExpiringMaterialRenewalPolicy = {
  defaultRefreshMs: number;
  expiryLeadMs: number;
  minRefreshMs: number;
  maxRetryMs: number;
};

type RenewalTimer = unknown;

export type ExpiringMaterialRenewalController = {
  refreshNow(): Promise<void>;
  stop(): Promise<void>;
};

export type ExpiringMaterialRenewalOptions<T> = {
  initialExpiresAt: Date | null;
  resolve: () => Promise<T>;
  write: (material: T) => Promise<void>;
  expiresAt: (material: T) => Date | null;
  policy: ExpiringMaterialRenewalPolicy;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => RenewalTimer;
  clearSchedule?: (timer: RenewalTimer) => void;
  onSuccess?: (result: { material: T; nextDelayMs: number }) => void;
  onFailure?: (failure: { retryDelayMs: number; errorClass: string }) => void;
};

export function nextExpiringMaterialRenewalDelay(
  expiresAt: Date | null,
  policy: ExpiringMaterialRenewalPolicy,
  nowMs = Date.now(),
): number {
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
    return policy.defaultRefreshMs;
  }
  return Math.min(
    policy.defaultRefreshMs,
    Math.max(policy.minRefreshMs, expiresAt.getTime() - nowMs - policy.expiryLeadMs),
  );
}

/**
 * Attempt-owned single-flight renewal for expiring sandbox material.
 *
 * A late resolver cannot write after stop. A physical sandbox write that already
 * started is drained so turn settlement cannot race a stale mutation.
 */
export function startExpiringMaterialRenewalLoop<T>(
  options: ExpiringMaterialRenewalOptions<T>,
): ExpiringMaterialRenewalController {
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
  const clearSchedule =
    options.clearSchedule ??
    ((timer: RenewalTimer): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: RenewalTimer | null = null;
  let inFlight: Promise<void> | null = null;
  let writeInFlight: Promise<void> | null = null;
  let retryDelayMs = options.policy.minRefreshMs;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearSchedule(timer);
    timer = null;
  };
  const scheduleRefresh = (delayMs: number): void => {
    if (stopped) return;
    clearTimer();
    timer = schedule(() => {
      timer = null;
      void refreshNow();
    }, delayMs);
  };
  const performRefresh = async (): Promise<void> => {
    try {
      const material = await options.resolve();
      if (stopped) return;
      const write = options.write(material);
      writeInFlight = write;
      try {
        await write;
      } finally {
        if (writeInFlight === write) writeInFlight = null;
      }
      if (stopped) return;
      retryDelayMs = options.policy.minRefreshMs;
      const nextDelayMs = nextExpiringMaterialRenewalDelay(
        options.expiresAt(material),
        options.policy,
        now(),
      );
      try {
        options.onSuccess?.({ material, nextDelayMs });
      } catch {
        // Observability never owns credential liveness.
      }
      scheduleRefresh(nextDelayMs);
    } catch (error) {
      if (stopped) return;
      const scheduledRetryMs = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, options.policy.maxRetryMs);
      try {
        options.onFailure?.({
          retryDelayMs: scheduledRetryMs,
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      } catch {
        // Observability never owns credential liveness.
      }
      scheduleRefresh(scheduledRetryMs);
    }
  };
  const refreshNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimer();
    const operation = performRefresh();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  scheduleRefresh(
    nextExpiringMaterialRenewalDelay(options.initialExpiresAt, options.policy, now()),
  );
  return {
    refreshNow,
    stop: async () => {
      stopped = true;
      clearTimer();
      await writeInFlight?.catch(() => undefined);
    },
  };
}
