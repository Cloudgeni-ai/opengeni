import { getSessionEvent, resolveWaitingSteer, type Database } from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import type { SessionEvent } from "@opengeni/contracts";

/**
 * A turn just settled into an ownerless wait (an approval, a structured
 * question or a capacity wait) before reaching its next model step. A Steer
 * that was waiting for that step replaces the wait now, the same as a Steer
 * accepted after the wait began. Returns true when it did, so the activity
 * ends idle and the Steer is claimed next.
 */
export async function handOverWaitToSteer(
  db: Database,
  bus: EventBus | null | undefined,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<boolean> {
  const resolved = await resolveWaitingSteer(db, input);
  if (!resolved) return false;
  if (bus) {
    const events = (
      await Promise.all(
        resolved.eventIds.map((eventId) => getSessionEvent(db, input.workspaceId, eventId)),
      )
    ).filter((event): event is SessionEvent => Boolean(event));
    await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, events);
  }
  return true;
}
