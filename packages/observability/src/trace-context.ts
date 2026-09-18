import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** W3C-compatible identity only: never propagate baggage or user attributes. */
export type TraceContext = { traceId: string; spanId: string };
type ActiveContext = TraceContext & { addLink?: ((link: TraceContext) => void) | undefined };
const storage = new AsyncLocalStorage<ActiveContext | undefined>();

export function validTraceContext(value: TraceContext | undefined): TraceContext | undefined {
  if (!value) return undefined;
  if (!/^[0-9a-f]{32}$/.test(value.traceId) || /^0+$/.test(value.traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(value.spanId) || /^0+$/.test(value.spanId)) return undefined;
  return { traceId: value.traceId, spanId: value.spanId };
}

export function currentTraceContext(): TraceContext | undefined {
  return validTraceContext(storage.getStore());
}

/** Scoped run, never enterWith: interleaved requests cannot inherit each other's spans. */
export function withTraceContext<T>(context: ActiveContext | undefined, run: () => T): T {
  const valid = validTraceContext(context);
  return storage.run(valid ? { ...valid, addLink: context?.addLink } : undefined, run);
}

/** Stable identity of an actually emitted admission anchor, not session ancestry. */
export function admissionTraceContext(eventId: string): TraceContext | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId))
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

/** Remote context must be admitted by the caller's trust boundary before use. */
export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value ?? "");
  return match ? validTraceContext({ traceId: match[1]!, spanId: match[2]! }) : undefined;
}

export function traceparent(context: TraceContext): string | undefined {
  const valid = validTraceContext(context);
  return valid ? `00-${valid.traceId}-${valid.spanId}-01` : undefined;
}
