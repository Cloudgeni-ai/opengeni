import type { SessionEvent } from "@opengeni/sdk";

/** Only the exact durable prompt can retire its optimistic creation handoff. */
export function creationHandoffReconciled(
  handoff: { session: { id: string; workspaceId: string }; clientEventId: string } | null,
  events: readonly SessionEvent[],
): boolean {
  return (
    !!handoff &&
    events.some(
      (event) =>
        event.type === "user.message" &&
        event.sessionId === handoff.session.id &&
        event.workspaceId === handoff.session.workspaceId &&
        event.clientEventId === handoff.clientEventId,
    )
  );
}
