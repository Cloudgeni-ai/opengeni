import type { SessionEvent } from "@opengeni/sdk";

const TURN_END_TYPES: ReadonlySet<string> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The Opengeni credits each answer cost: a turn's `usage.creditsMicros`
 * (from its terminal event), shown on that turn's last assistant message.
 * Keyed by the message's event id and its completion time, so the timeline
 * row can be matched either way. Turns without a known amount (still
 * running, older than the field, or unpriced) show nothing.
 */
export function answerCosts(events: readonly SessionEvent[]): {
  costFor: (item: { turnId: string | null; id: string; occurredAt: string }) => number | null;
} {
  const turnCost = new Map<string, number>();
  const lastAnswer = new Map<string, { id: string; occurredAt: string }>();
  const answerIds = new Set<string>();
  for (const event of events) {
    if (!event.turnId) continue;
    if (event.type === "agent.message.completed") {
      answerIds.add(event.id);
      lastAnswer.set(event.turnId, { id: event.id, occurredAt: event.occurredAt });
    } else if (TURN_END_TYPES.has(event.type)) {
      const credits = record(record(event.payload)?.usage)?.creditsMicros;
      if (typeof credits === "number" && Number.isFinite(credits) && credits >= 0) {
        turnCost.set(event.turnId, credits);
      } else {
        turnCost.delete(event.turnId);
      }
    }
  }
  return {
    costFor: (item) => {
      if (!item.turnId) return null;
      const cost = turnCost.get(item.turnId);
      const answer = lastAnswer.get(item.turnId);
      if (cost === undefined || !answer) return null;
      // A row keyed by its event id matches only that event; the completion
      // time is the fallback for rows keyed otherwise.
      if (answerIds.has(item.id)) return item.id === answer.id ? cost : null;
      return item.occurredAt === answer.occurredAt ? cost : null;
    },
  };
}
