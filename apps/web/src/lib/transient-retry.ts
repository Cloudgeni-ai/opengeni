import { OpenGeniApiError } from "@opengeni/sdk";

/*
 * A deploy, failover or database restart makes the API answer 502/503/504 (or a
 * retryable 500) for a few seconds, or drops the connection outright. Reads
 * behind the new-chat composer retry those quietly before anything is shown;
 * the person keeps typing and never sees a raw "service unavailable" line.
 */

/** Backoff between attempts: about ten seconds in all before anything is shown. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000, 4_000];

/** After the quiet retries give up, try once at this pace until Opengeni answers. */
export const TRANSIENT_RECONNECT_INTERVAL_MS = 3_000;

/** The one line shown while Opengeni is briefly unreachable. */
export const OPENGENI_UPDATING_NOTICE = "Opengeni is updating. We'll reconnect automatically.";

const NETWORK_FAILURE =
  /failed to fetch|fetch failed|networkerror|load failed|network request failed/iu;

/**
 * True for a failure that says the service is briefly unreachable, not that
 * the request was wrong: a gateway or availability status, a 500 the API marks
 * retryable, or a request that never got a response.
 */
export function isTransientServiceFailure(error: unknown): boolean {
  if (isAbort(error)) return false;
  if (error instanceof OpenGeniApiError) {
    if (error.status === 502 || error.status === 503 || error.status === 504) return true;
    if (error.status === 500) return error.retryable;
    // The SDK reports a mutation whose response never arrived as status 0.
    return error.status === 0 && error.code === "network_error";
  }
  return error instanceof TypeError && NETWORK_FAILURE.test(error.message);
}

export type RetryTransientOptions = {
  /** Stop waiting (and rethrow the last failure) once this returns false. */
  shouldContinue?: () => boolean;
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Run a read, retrying only transient service failures with backoff. Never use
 * this for a request whose repeat could apply twice: it is for reads and for
 * writes that are idempotent by construction.
 */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryTransientOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (
        delay === undefined ||
        !isTransientServiceFailure(error) ||
        options.signal?.aborted ||
        options.shouldContinue?.() === false
      ) {
        throw error;
      }
      await sleep(delay, options.signal);
      if (options.signal?.aborted || options.shouldContinue?.() === false) throw error;
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
