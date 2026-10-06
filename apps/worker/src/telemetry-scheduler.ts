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
