import type { Context } from "hono";

declare module "hono" {
  interface ContextVariableMap {
    opengeniCorrelationId: string;
  }
}

const requestCorrelationIds = new WeakMap<Request, string>();

export function assignRequestCorrelationId(
  context: Context,
  requestedId: string | undefined,
): string {
  const correlationId = boundedCorrelationId(requestedId) ?? crypto.randomUUID();
  context.set("opengeniCorrelationId", correlationId);
  requestCorrelationIds.set(context.req.raw, correlationId);
  return correlationId;
}

export function correlationIdForContext(context: Context): string | undefined {
  return context.get("opengeniCorrelationId") ?? requestCorrelationIds.get(context.req.raw);
}

function boundedCorrelationId(value: string | undefined): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
  return value;
}
