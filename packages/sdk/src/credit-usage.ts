/**
 * The Opengeni credits a turn charged (`usage` on terminal turn events) are
 * the product server's billing data, not something to show the person
 * chatting. Opengeni already leaves them out of reads a session proxy relays;
 * helpers that re-emit a server's own full-projection reads to browsers use
 * this to do the same.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The event without the turn's credit usage (a copy only when it has one). */
export function withoutTurnCreditUsage<T extends { payload?: unknown }>(event: T): T {
  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.usage) || !("creditsMicros" in payload.usage)) {
    return event;
  }
  const { usage: _usage, ...rest } = payload;
  return { ...event, payload: rest };
}
