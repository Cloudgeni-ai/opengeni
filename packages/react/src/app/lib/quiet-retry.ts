/**
 * Background reads (workspace load, focus refreshes) that fail because
 * Opengeni is briefly unreachable, during a deploy or a network drop, try
 * again by themselves instead of telling the person. The pause grows with
 * each failure and settles at a minute; a success starts over.
 */
export const QUIET_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 4_000, 8_000, 16_000, 30_000, 60_000,
];

export type QuietRetry = {
  /**
   * Run `retry` after the next pause, replacing any retry already waiting. A
   * different `key` (another workspace) starts over at the first pause.
   */
  schedule(retry: () => void, key?: string): void;
  /** Drop a waiting retry and keep the current pause. */
  cancel(): void;
  /** A read succeeded or the context changed: drop a waiting retry and start over. */
  reset(): void;
};

export function createQuietRetry(delays: readonly number[] = QUIET_RETRY_DELAYS_MS): QuietRetry {
  let attempt = 0;
  let lastKey: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopWaiting: (() => void) | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    stopWaiting?.();
    stopWaiting = null;
  };
  return {
    schedule(retry, key) {
      cancel();
      if (key !== lastKey) {
        attempt = 0;
        lastKey = key;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 60_000;
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        if (typeof document === "undefined" || document.visibilityState !== "hidden") {
          retry();
          return;
        }
        // A hidden page asks nothing; it tries again once it is back in view.
        const onVisible = () => {
          if (document.visibilityState === "hidden") return;
          stopWaiting?.();
          stopWaiting = null;
          retry();
        };
        document.addEventListener("visibilitychange", onVisible);
        stopWaiting = () => document.removeEventListener("visibilitychange", onVisible);
      }, delay);
    },
    cancel,
    reset() {
      cancel();
      attempt = 0;
    },
  };
}
