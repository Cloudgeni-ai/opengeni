import type { Session, SessionEvent } from "@/types";

export type ModelRecovery = {
  kind: "rate_limited" | "unavailable";
};

/** Current provider pacing only, never retry authority or a prediction of availability. */
export function currentModelRecovery(
  session: Pick<Session, "id" | "status" | "activeTurnId" | "effectiveControl">,
  events: readonly SessionEvent[],
): ModelRecovery | null {
  if (
    session.status !== "recovering" ||
    session.effectiveControl.state !== "active" ||
    !session.activeTurnId
  )
    return null;
  // Event pages can be merged or replayed out of order. Use the newest current
  // boundary, not array position, and never borrow another turn's diagnosis.
  let latest: SessionEvent | undefined;
  for (const event of events) {
    if (
      event.sessionId !== session.id ||
      event.turnId !== session.activeTurnId ||
      event.duplicateOfEventId ||
      (event.turnAssociation && event.turnAssociation !== "current") ||
      !["turn.recovery.requested", "turn.started", "turn.completed", "turn.failed"].includes(
        event.type,
      )
    )
      continue;
    if (!latest || event.sequence > latest.sequence) latest = event;
  }
  if (latest?.type !== "turn.recovery.requested") return null;
  const payload = latest.payload;
  if (!payload || typeof payload !== "object") return null;
  const { reason } = payload as Record<string, unknown>;
  const kind =
    reason === "provider_rate_limited"
      ? "rate_limited"
      : reason === "provider_unavailable"
        ? "unavailable"
        : null;
  if (!kind) return null;
  return { kind };
}
