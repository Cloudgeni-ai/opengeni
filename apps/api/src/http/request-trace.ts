import { parseTraceparent, type TraceContext } from "@opengeni/observability";

/**
 * Most child spans (database queries, outbound calls) one request records.
 * Enough for the widest read routes; a request past it records how many it
 * dropped instead of exporting an unbounded trace.
 */
export const HTTP_REQUEST_CHILD_SPAN_LIMIT = 256;

/**
 * Where an API request span sits relative to the caller's W3C trace context.
 *
 * A valid incoming `traceparent` is always kept: by default as a span link, so
 * the request starts its own trace and the caller cannot choose its trace ID,
 * join an unrelated trace or grow one without bound, yet a trace viewer can
 * still follow the link across the boundary. A deployment whose callers are all
 * trusted (an embedding backend, a trusted edge) sets
 * OPENGENI_OBSERVABILITY_TRUST_INCOMING_TRACE_CONTEXT, and the request span
 * then joins the caller's trace as its child. Malformed or repeated headers are
 * ignored. `tracestate` and baggage are never read.
 */
export function requestSpanTraceParent(
  header: string | undefined,
  trustIncoming: boolean,
): { parent: TraceContext | null; links: TraceContext[] } {
  const incoming = parseTraceparent(header);
  if (!incoming) return { parent: null, links: [] };
  return trustIncoming ? { parent: incoming, links: [] } : { parent: null, links: [incoming] };
}
