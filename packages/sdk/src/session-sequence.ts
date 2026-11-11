/**
 * Read consistency for session projections (prompt queue, pending questions,
 * goal, lineage). The server reads the session's event sequence before the
 * projection and returns it in this header, so the projection reflects every
 * event at or below that sequence. A client that also loads the event log can
 * then re-read a projection only for an event after it, instead of after every
 * historical event it happens to see first.
 */
export const SESSION_SEQUENCE_HEADER = "X-OpenGeni-Session-Sequence";

const observed = new WeakMap<object, number>();

/** @internal Record the header for one parsed response body. */
export function recordObservedSessionSequence(value: unknown, header: string | null): void {
  if (header === null || typeof value !== "object" || value === null) return;
  const sequence = Number(header);
  if (Number.isSafeInteger(sequence) && sequence >= 0) observed.set(value, sequence);
}

/** @internal Carry a recorded sequence to a value unwrapped from the response body. */
export function copyObservedSessionSequence(from: unknown, to: unknown): void {
  if (typeof from !== "object" || from === null || typeof to !== "object" || to === null) return;
  const sequence = observed.get(from);
  if (sequence !== undefined) observed.set(to, sequence);
}

/**
 * The session event sequence a value read from the API reflects, or
 * `undefined` when the server (or a proxy in between) did not report one.
 * Values from `getQueue`, `listHumanInputRequests`, `getGoal`/`findGoal` and
 * `getSessionLineage` carry it on current servers.
 */
export function observedSessionSequence(value: unknown): number | undefined {
  return typeof value === "object" && value !== null ? observed.get(value) : undefined;
}
