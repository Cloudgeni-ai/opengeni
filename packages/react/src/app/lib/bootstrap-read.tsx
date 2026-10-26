import { isTransientBootstrapError, type BootstrapErrorContext } from "./bootstrap-error";

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Pause between reconnect attempts once the quick retries are spent. */
export const BOOTSTRAP_RECONNECT_DELAYS_MS: readonly number[] = [3_000, 5_000, 8_000, 10_000];

export type BootstrapWaiting = {
  /**
   * Called before each reconnect wait once the quick retries are spent and
   * the failure is still transient (an update, the maintenance marker or a
   * dropped connection). `elapsedMs` counts from the first failure.
   */
  onWaiting: (error: unknown, elapsedMs: number) => void;
};

/**
 * Bootstrap GETs only: initial attempt + two quick retries, never a mutation
 * policy. With `waiting`, a transient failure is retried until the API answers
 * again (an update can park it for minutes), so startup recovers by itself.
 */
export async function readBootstrap<T>(input: {
  request: () => Promise<T>;
  context: BootstrapErrorContext;
  signal: AbortSignal;
  isCurrent?: () => boolean;
  waiting?: BootstrapWaiting | undefined;
}): Promise<T> {
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    if (input.isCurrent?.() === false) {
      throw new DOMException("Bootstrap identity changed", "AbortError");
    }
  };
  const delays = [500, 1_500];
  let firstFailureAt: number | null = null;
  for (let attempt = 0; ; attempt += 1) {
    assertCurrent();
    try {
      const result = await input.request();
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      if (!isTransientBootstrapError(error, input.context)) throw error;
      firstFailureAt ??= Date.now();
      let delay = delays[attempt];
      if (delay === undefined) {
        if (!input.waiting) throw error;
        const step = Math.min(attempt - delays.length, BOOTSTRAP_RECONNECT_DELAYS_MS.length - 1);
        delay = Math.round(
          (BOOTSTRAP_RECONNECT_DELAYS_MS[step] ?? 10_000) * (0.8 + Math.random() * 0.4),
        );
        input.waiting.onWaiting(error, Date.now() - firstFailureAt);
      }
      await waitForRetry(delay, input.signal);
    }
  }
}
