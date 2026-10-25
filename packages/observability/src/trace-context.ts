import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** W3C-compatible identity only: never propagate baggage or user attributes. */
export type TraceContext = { traceId: string; spanId: string; traceFlags?: string };
/** OTLP span kind: a request served, a call made to another system, or local work. */
export type SpanKind = "internal" | "server" | "client";
export type ChildSpanAttributes = Record<string, string | number | boolean | undefined>;
/** A span started through the active scope's child-span recorder. */
export type ChildSpan = TraceContext & {
  end: (input?: { attributes?: ChildSpanAttributes; error?: unknown }) => void;
};
/**
 * Starts a child of `parent` within the owning root's bounded span budget, or
 * returns undefined once that budget is spent or the root has ended.
 */
export type ChildSpanRecorder = (
  name: string,
  attributes: ChildSpanAttributes,
  kind: SpanKind,
  parent: TraceContext,
) => ChildSpan | undefined;
type ActiveContext = TraceContext & {
  addLink?: ((link: TraceContext) => void) | undefined;
  childSpans?: ChildSpanRecorder | undefined;
};
const storage = new AsyncLocalStorage<ActiveContext | undefined>();

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function validTraceContext(value: unknown): TraceContext | undefined {
  // Snapshot primitive own data once. Never invoke getters, coercion or toJSON.
  const traceId = ownData(value, "traceId");
  const spanId = ownData(value, "spanId");
  const traceFlags = ownData(value, "traceFlags");
  if (typeof traceId !== "string" || typeof spanId !== "string") return undefined;
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(spanId)) return undefined;
  if (
    traceFlags !== undefined &&
    (typeof traceFlags !== "string" || !/^[0-9a-f]{2}$/.test(traceFlags))
  )
    return undefined;
  return { traceId, spanId, ...(traceFlags === undefined ? {} : { traceFlags }) };
}

export function currentTraceContext(): TraceContext | undefined {
  return validTraceContext(storage.getStore());
}

/**
 * Scoped run, never enterWith: interleaved requests cannot inherit each other's spans.
 * A context without its own child-span recorder keeps the enclosing scope's
 * recorder only when it belongs to the same trace, so nested spans of one
 * request share that request's budget and an unrelated trace never does.
 */
export function withTraceContext<T>(context: ActiveContext | undefined, run: () => T): T {
  const valid = validTraceContext(context);
  const addLink = ownData(context, "addLink");
  const ownRecorder = ownData(context, "childSpans");
  const enclosing = storage.getStore();
  const childSpans =
    typeof ownRecorder === "function"
      ? (ownRecorder as ChildSpanRecorder)
      : valid && enclosing?.traceId === valid.traceId
        ? enclosing.childSpans
        : undefined;
  return storage.run(
    valid
      ? {
          ...valid,
          addLink:
            typeof addLink === "function" ? (addLink as ActiveContext["addLink"]) : undefined,
          childSpans,
        }
      : undefined,
    run,
  );
}

/** Run outside any trace, for example telemetry export, which must never trace itself. */
export function withoutTraceContext<T>(run: () => T): T {
  return storage.run(undefined, run);
}

/** Whether the active scope records child spans; lets callers skip building span input. */
export function childSpanRecordingActive(): boolean {
  return typeof storage.getStore()?.childSpans === "function";
}

/**
 * Start a child of the active span when its scope records child spans (API
 * requests do; see the HTTP middleware). Returns undefined, at no cost, in
 * every other scope. Run nested work under the result with withTraceContext.
 */
export function startChildSpan(
  name: string,
  attributes: ChildSpanAttributes = {},
  kind: SpanKind = "client",
): ChildSpan | undefined {
  const active = storage.getStore();
  const recorder = active?.childSpans;
  const parent = validTraceContext(active);
  if (typeof recorder !== "function" || !parent) return undefined;
  try {
    return recorder(name, attributes, kind, parent);
  } catch {
    // Tracing must never change the traced operation.
    return undefined;
  }
}

/** Stable identity of an actually emitted admission anchor, not session ancestry. */
export function admissionTraceContext(eventId: string): TraceContext | undefined {
  if (
    typeof eventId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)
  )
    return undefined;
  const digest = createHash("sha256")
    .update("opengeni:accepted-event-trace:v1\0")
    .update(eventId.toLowerCase())
    .digest("hex");
  return validTraceContext({ traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) });
}

export function linkCurrentSpanToAdmission(eventId: string): void {
  const link = admissionTraceContext(eventId);
  if (link) storage.getStore()?.addLink?.(link);
}

/**
 * Parse one W3C `traceparent` value. Remote context must still be admitted by
 * the caller's trust boundary before it may become a parent; see the API's
 * HTTP request span.
 *
 * Follows W3C Trace Context level 1: lowercase hex only; version `ff` and
 * all-zero identities are invalid; version `00` is exactly four fields; a later
 * version is read by its first four fields and may only continue after a `-`.
 * Repeated headers arrive joined by a comma and are therefore rejected.
 */
export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/s.exec(value);
  if (!match) return undefined;
  const [, version, traceId, spanId, traceFlags, rest] = match;
  if (version === "ff" || (version === "00" && rest !== undefined)) return undefined;
  return validTraceContext({ traceId: traceId!, spanId: spanId!, traceFlags: traceFlags! });
}

export function traceparent(context: TraceContext): string | undefined {
  const valid = validTraceContext(context);
  return valid ? `00-${valid.traceId}-${valid.spanId}-${valid.traceFlags ?? "01"}` : undefined;
}
