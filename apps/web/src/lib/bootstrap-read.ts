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

/** Bootstrap GETs only: initial attempt + two retries, never a mutation policy. */
export async function readBootstrap<T>(input: {
  request: () => Promise<T>;
  context: BootstrapErrorContext;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<T> {
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    if (input.isCurrent?.() === false) {
      throw new DOMException("Bootstrap identity changed", "AbortError");
    }
  };
  const delays = [500, 1_500];
  for (let attempt = 0; ; attempt += 1) {
    assertCurrent();
    try {
      const result = await input.request();
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      const delay = delays[attempt];
      if (delay === undefined || !isTransientBootstrapError(error, input.context)) throw error;
      await waitForRetry(delay, input.signal);
    }
  }
}
