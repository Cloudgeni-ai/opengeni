/** Small injectable clock edges for deterministic telemetry lifecycle tests. */
export type TelemetryScheduler = {
  timeout(callback: () => void, delayMs: number): () => void;
  interval(callback: () => void, intervalMs: number): () => void;
  defer(callback: () => void): void;
};

export const telemetryScheduler: TelemetryScheduler = {
  timeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  interval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
  defer: queueMicrotask,
};

export function telemetryInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Bad/regressing clocks are unknown, not a new timestamp or a zero age.
 * Retain the last valid high-water observation for diagnostic age reporting. */
export function createTelemetryClock(now: () => number) {
  let latest: number | null = null;
  return {
    read(): number | null {
      let observed: number;
      try {
        observed = now();
      } catch {
        return null;
      }
      if (
        !Number.isFinite(observed) ||
        observed < 0 ||
        observed > Number.MAX_SAFE_INTEGER ||
        (latest !== null && observed < latest)
      )
        return null;
      latest = observed;
      return observed;
    },
    latest: () => latest,
  };
}
