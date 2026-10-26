import { tracedFetchTarget } from "@opengeni/observability";

/** Cancels and joins a transport's local work for one exact abort signal. */
export type UsageReadAbortAndJoin = (signal: AbortSignal) => Promise<void>;

/**
 * The transport check of the administered usage reads, which hold a custody
 * transaction open across the provider request: the join of `fetchImpl`'s
 * local work, or null when it is the reader's native fetch.
 *
 * Native fetch already cancels its request and body for the caller's signal.
 * It stays native behind a transparent wrapper such as the API's request
 * tracing, which wraps `globalThis.fetch` at startup, so the check looks
 * through it. Any other transport must provide `abortAndJoin`, or the read is
 * refused (with `refusal`) before it receives a bearer.
 */
export function usageReadTransportJoin(
  fetchImpl: unknown,
  nativeFetch: unknown,
  refusal: string,
): UsageReadAbortAndJoin | null {
  const target = tracedFetchTarget(fetchImpl);
  if (target === tracedFetchTarget(nativeFetch)) return null;
  const join = (target as { abortAndJoin?: unknown } | null | undefined)?.abortAndJoin;
  if (typeof join !== "function") throw new Error(refusal);
  return (join as UsageReadAbortAndJoin).bind(target);
}
