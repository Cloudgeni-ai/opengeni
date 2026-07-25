import type { HumanInputQuestion, SessionEvent } from "@opengeni/sdk";

/** Minimal actionable request shape available from the durable event log. */
export type PendingHumanInputRequest = {
  id: string;
  turnId: string | null;
  questions: HumanInputQuestion[];
  allowSkip: boolean;
  expiresAt: string | null;
};

/** Parse one generic `session.humanInput.requested` event defensively. */
export function humanInputRequestFromEvent(
  event: Pick<SessionEvent, "type" | "payload" | "turnId">,
): PendingHumanInputRequest | null {
  if (event.type !== "session.humanInput.requested" || !isRecord(event.payload)) return null;
  const request = event.payload.request;
  if (!isRecord(request) || typeof request.id !== "string" || !Array.isArray(request.questions)) {
    return null;
  }
  return {
    id: request.id,
    turnId: event.turnId ?? null,
    questions: request.questions as HumanInputQuestion[],
    allowSkip: request.allowSkip === true,
    expiresAt: typeof request.expiresAt === "string" ? request.expiresAt : null,
  };
}

/**
 * Fold a durable event log into the structured requests that are actionable
 * now. Responses remove one request; a terminal owning turn clears any
 * unresolved requests that died with it. Replaying history cannot resurrect a
 * previously answered card.
 */
export function projectPendingHumanInputRequests(
  events: SessionEvent[],
): PendingHumanInputRequest[] {
  const pending = new Map<string, PendingHumanInputRequest>();
  for (const event of events) {
    const requested = humanInputRequestFromEvent(event);
    if (requested) {
      pending.set(requested.id, requested);
      continue;
    }
    if (event.type === "user.humanInputResponse" && isRecord(event.payload)) {
      if (typeof event.payload.requestId === "string") pending.delete(event.payload.requestId);
      continue;
    }
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      for (const [id, request] of pending) {
        if (
          request.turnId === null ||
          event.turnId === null ||
          event.turnId === undefined ||
          request.turnId === event.turnId
        ) {
          pending.delete(id);
        }
      }
    }
  }
  return [...pending.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
