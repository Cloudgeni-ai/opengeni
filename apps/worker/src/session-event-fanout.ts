import type { SessionEvent } from "@opengeni/contracts";
import type { EventBus } from "@opengeni/events";

/** Best-effort live fanout of events that are already durable, grouped by
 * session. Durable catch-up remains the source of truth, so failures are only
 * reported. */
export async function publishDurableSessionEvents(
  bus: EventBus | null | undefined,
  workspaceId: string,
  events: readonly SessionEvent[] | undefined,
  onError: (error: unknown) => void = () => undefined,
): Promise<void> {
  if (!bus || !events?.length) return;
  for (const sessionId of new Set(events.map((event) => event.sessionId))) {
    await bus
      .publish(
        workspaceId,
        sessionId,
        events.filter((event) => event.sessionId === sessionId),
      )
      .catch(onError);
  }
}
