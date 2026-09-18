import { AsyncLocalStorage } from "node:async_hooks";

/** W3C-compatible identity only: never propagate baggage or user attributes. */
export type TraceContext = { traceId: string; spanId: string };
const storage = new AsyncLocalStorage<TraceContext | undefined>();

export function validTraceContext(value: TraceContext | undefined): TraceContext | undefined {
  if (!value) return undefined;
  if (!/^[0-9a-f]{32}$/.test(value.traceId) || /^0+$/.test(value.traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(value.spanId) || /^0+$/.test(value.spanId)) return undefined;
  return { traceId: value.traceId, spanId: value.spanId };
}

export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Scoped run, never enterWith: interleaved requests cannot inherit each other's spans. */
export function withTraceContext<T>(context: TraceContext | undefined, run: () => T): T {
  return storage.run(validTraceContext(context), run);
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
