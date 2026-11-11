import { isMaintenanceError, OpenGeniApiError } from "./errors";

/**
 * Bounded retry for safe reads (`GET` and `HEAD`) that failed transiently:
 * the request never reached a healthy server (a transport error such as a
 * reset connection) or a gateway answered 502, 503 or 504. These are what an
 * API rolling deploy or a short network blip look like from the client.
 * Mutations are never retried here; they keep their outcome-unknown semantics.
 */
export type OpenGeniReadRetryOptions = {
  /** Total attempts including the first. Defaults to 4; `1` disables retries. */
  maxAttempts?: number | undefined;
  /** Backoff before the first retry, before jitter. Defaults to 250 ms. Doubles per retry. */
  initialDelayMs?: number | undefined;
  /** Upper bound for one backoff delay. Defaults to 2000 ms. */
  maxDelayMs?: number | undefined;
  /**
   * Total time budget measured from the first attempt. A retry, including one
   * whose `Retry-After` asks for a longer wait, is only made when its delay
   * still fits in the budget; otherwise the last error surfaces. Defaults to 5000 ms.
   */
  maxElapsedMs?: number | undefined;
};

export type ReadRetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxElapsedMs: number;
};

export const DEFAULT_READ_RETRY_POLICY: Readonly<ReadRetryPolicy> = Object.freeze({
  maxAttempts: 4,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  maxElapsedMs: 5_000,
});

const MAX_READ_RETRY_ATTEMPTS = 10;
const MAX_READ_RETRY_ELAPSED_MS = 60_000;

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Resolve client options to a policy, or `null` when retries are off. Invalid
 * values fall back to the defaults instead of failing client construction.
 */
export function resolveReadRetryPolicy(
  options: OpenGeniReadRetryOptions | false | undefined,
): ReadRetryPolicy | null {
  if (options === false) return null;
  const input = options && typeof options === "object" ? options : {};
  const maxAttempts = Math.floor(
    boundedNumber(
      input.maxAttempts,
      DEFAULT_READ_RETRY_POLICY.maxAttempts,
      1,
      MAX_READ_RETRY_ATTEMPTS,
    ),
  );
  if (maxAttempts <= 1) return null;
  const maxElapsedMs = boundedNumber(
    input.maxElapsedMs,
    DEFAULT_READ_RETRY_POLICY.maxElapsedMs,
    0,
    MAX_READ_RETRY_ELAPSED_MS,
  );
  const maxDelayMs = boundedNumber(
    input.maxDelayMs,
    DEFAULT_READ_RETRY_POLICY.maxDelayMs,
    0,
    MAX_READ_RETRY_ELAPSED_MS,
  );
  const initialDelayMs = boundedNumber(
    input.initialDelayMs,
    DEFAULT_READ_RETRY_POLICY.initialDelayMs,
    0,
    maxDelayMs,
  );
  return { maxAttempts, initialDelayMs, maxDelayMs, maxElapsedMs };
}

export function isSafeReadMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

/** Gateway statuses a rolling deploy or an overloaded upstream answers with. */
export function isTransientGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

// Transport failures the client itself observed (`fetch` or the response body
// rejected with a `TypeError`). Tagged so a caller can tell them apart from a
// `TypeError` its own code threw, which is a bug, not a transient failure.
const transportFailures = new WeakSet<object>();

/** Record that `error` is a transport failure of an API request. */
export function markTransportFailure(error: unknown): void {
  if (error instanceof TypeError) transportFailures.add(error);
}

// 502s the client synthesizes for a response it could not accept (a non-JSON
// or malformed success body). The server did answer; repeating the read gives
// the same answer, so these are definitive rather than transient.
const invalidResponses = new WeakSet<object>();

/** A 502 for a response the client received but could not accept. */
export function invalidApiResponseError(
  body: string,
  options?: ConstructorParameters<typeof OpenGeniApiError>[2],
): OpenGeniApiError {
  const error = new OpenGeniApiError(502, body, options);
  invalidResponses.add(error);
  return error;
}

// Transport failure messages across browsers, Node/undici and Bun, for
// `TypeError`s that did not pass through this client.
const NETWORK_FAILURE_MESSAGE =
  /failed to fetch|fetch failed|networkerror|network error|load failed|network request failed|network connection was lost|terminated|err_http2|econnreset|socket hang up/iu;

/**
 * A failure a later identical safe read can plausibly succeed after: a
 * transport error (`fetch` or the response body rejected with a `TypeError`)
 * or a retryable 502, 503 or 504, including the maintenance marker. Auth,
 * permission, not-found, validation, rate limits, aborts, other server
 * errors, a success response the client could not accept, and `TypeError`s
 * from application code are definitive and are not transient.
 */
export function isTransientRequestError(error: unknown): boolean {
  if (error instanceof OpenGeniApiError) {
    if (isMaintenanceError(error)) return true;
    return (
      !invalidResponses.has(error) && isTransientGatewayStatus(error.status) && error.retryable
    );
  }
  if (!(error instanceof TypeError)) return false;
  return transportFailures.has(error) || NETWORK_FAILURE_MESSAGE.test(error.message);
}

/** `Retry-After` as milliseconds from `now`, or `null` when absent or invalid. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }
  // Otherwise only an HTTP-date (it always names the month); never a number.
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/**
 * The delay before retry number `retry` (1 for the first retry), or `null`
 * when no retry fits the policy. A server `Retry-After` is honored, plus up to
 * 20% so clients told the same instant do not all return at once; otherwise
 * the exponential backoff is jittered to between half and all of it.
 */
export function readRetryDelayMs(
  policy: ReadRetryPolicy,
  retry: number,
  elapsedMs: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (retry >= policy.maxAttempts) return null;
  let delay: number;
  if (retryAfterMs !== null) {
    delay = retryAfterMs * (1 + 0.2 * Math.min(Math.max(random(), 0), 1));
  } else {
    const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (retry - 1));
    delay = base / 2 + (base / 2) * Math.min(Math.max(random(), 0), 1);
  }
  if (elapsedMs + delay > policy.maxElapsedMs) return null;
  return Math.round(delay);
}

/** Resolve after `ms`, or reject with the signal's reason once it aborts. */
export function abortableReadRetryDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
