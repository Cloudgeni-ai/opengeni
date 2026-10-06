import type { SessionEvent } from "@opengeni/sdk";

// Keep this client scheduling predicate aligned with the meaningful-attention
// predicate in packages/db/src/session-meaningful-events.ts. The server remains
// authoritative; this only avoids personal-state writes for streaming activity.
export const SESSION_ATTENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent.message.completed",
  "turn.completed",
  "turn.failed",
  "session.requiresAction",
  "session.humanInput.requested",
  "tool.auth_needed",
  "credential.auth_needed",
  "goal.completed",
  "goal.paused",
  "goal.progress",
  "goal.rewrite.proposed",
  "rig.setup.failed",
  "sandbox.operation.failed",
  "sandbox.box.lost",
  "workspace.revision.degraded",
  "machine.op.failed",
  "machine.link.lost",
  "session.event.envelope_omitted",
]);

/**
 * The latest delivered attention boundary, independent of raw token activity.
 * A foreground reader acknowledges through this sequence, so streaming flushes
 * never cause a personal-state write and later activity stays unread.
 */
export function sessionAttentionReadThroughSequence(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      !SESSION_ATTENTION_EVENT_TYPES.has(event.type) ||
      event.duplicateOfEventId ||
      (event.turnAssociation != null && event.turnAssociation !== "current")
    )
      continue;
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    if (
      event.type === "agent.message.completed" &&
      (payload.phase === "commentary" || payload.text == null || payload.text === "")
    )
      continue;
    if (event.type === "turn.completed") {
      if (Object.hasOwn(payload, "maintenance") || Object.hasOwn(payload, "segmentLimit")) continue;
      const output = payload.output ?? payload.result;
      if ((output == null || output === "") && (payload.reply == null || payload.reply === ""))
        continue;
    }
    return event.sequence;
  }
  return 0;
}
