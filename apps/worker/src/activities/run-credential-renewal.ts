import type { NormalizedRunCredentialMaterial } from "@opengeni/runtime";

export const RUN_CREDENTIAL_DEFAULT_REFRESH_MS = 30 * 60_000;
export const RUN_CREDENTIAL_EXPIRY_LEAD_MS = 5 * 60_000;
export const RUN_CREDENTIAL_MIN_REFRESH_MS = 5_000;
export const RUN_CREDENTIAL_MAX_RETRY_MS = 5 * 60_000;

type RenewalTimer = unknown;

export type RunCredentialRenewalController = {
  refreshNow(): Promise<void>;
  stop(): Promise<void>;
};

export type RunCredentialRenewalOptions = {
  initialExpiresAt: Date | null;
  resolve: () => Promise<NormalizedRunCredentialMaterial | null>;
  write: (material: NormalizedRunCredentialMaterial | null) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => RenewalTimer;
  clearSchedule?: (timer: RenewalTimer) => void;
  onSuccess?: (result: { nextDelayMs: number; authNeeded: boolean }) => void;
  onFailure?: (failure: { retryDelayMs: number; errorClass: string }) => void;
};

export function nextRunCredentialRenewalDelay(expiresAt: Date | null, nowMs = Date.now()): number {
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
    return RUN_CREDENTIAL_DEFAULT_REFRESH_MS;
  }
  return Math.min(
    RUN_CREDENTIAL_DEFAULT_REFRESH_MS,
    Math.max(
      RUN_CREDENTIAL_MIN_REFRESH_MS,
      expiresAt.getTime() - nowMs - RUN_CREDENTIAL_EXPIRY_LEAD_MS,
    ),
  );
}

/** Single-flight renewal; late resolves cannot mutate a stopped attempt. */
export function startRunCredentialRenewalLoop(
  options: RunCredentialRenewalOptions,
): RunCredentialRenewalController {
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
  let retryDelayMs = RUN_CREDENTIAL_MIN_REFRESH_MS;

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
      retryDelayMs = RUN_CREDENTIAL_MIN_REFRESH_MS;
      const nextDelayMs = nextRunCredentialRenewalDelay(material?.expiresAt ?? null, now());
      try {
        options.onSuccess?.({
          nextDelayMs,
          authNeeded: (material?.authNeeded.length ?? 0) > 0,
        });
      } catch {
        // Observability never owns credential liveness.
      }
      scheduleRefresh(nextDelayMs);
    } catch (error) {
      if (stopped) return;
      const scheduledRetryMs = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, RUN_CREDENTIAL_MAX_RETRY_MS);
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

  scheduleRefresh(nextRunCredentialRenewalDelay(options.initialExpiresAt, now()));
  return {
    refreshNow,
    stop: async () => {
      stopped = true;
      clearTimer();
      // A remote host resolve can hang, but a sandbox write must drain before
      // cleanup/capture so no late generation can resurrect credentials.
      await writeInFlight?.catch(() => undefined);
    },
  };
}
