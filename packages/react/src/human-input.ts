import type { HumanInputQuestion, SessionEvent, SessionHumanInputRequest } from "@opengeni/sdk";
import { isRecord } from "@opengeni/contracts/values";

/** Minimal actionable request shape available from the durable event log. */
export type PendingHumanInputRequest = {
  id: string;
  turnId: string | null;
  questions: HumanInputQuestion[];
  allowSkip: boolean;
  expiresAt: string | null;
  /**
   * `secret_use_approval` marks a host-owned approval card. It belongs to the
   * blocked use, not to the turn that hit it, so it stays actionable after
   * that turn ends.
   */
  origin?: "tool_call" | "secret_use_approval" | undefined;
};

/** A pending row stops being actionable at its durable deadline, even before refresh. */
export function isActionableHumanInputRequest(
  request: Pick<SessionHumanInputRequest, "status" | "expiresAt">,
  nowMs = Date.now(),
): boolean {
  if (request.status !== "pending") return false;
  if (!request.expiresAt) return true;
  const deadline = Date.parse(request.expiresAt);
  return Number.isFinite(deadline) && deadline > nowMs;
}

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
    ...(request.origin === "secret_use_approval" ? { origin: "secret_use_approval" as const } : {}),
  };
}

/**
 * Fold a durable event log into the structured requests that are actionable
 * now. Responses remove one request; a terminal owning turn clears any
 * unresolved requests that died with it, except host-owned secret-use approval
 * cards, which outlive their turn. Replaying history cannot resurrect a
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
        if (request.origin === "secret_use_approval") continue;
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
