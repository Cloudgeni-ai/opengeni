import { cancelSiteRuntimeConversation, type Database } from "@opengeni/db";
import {
  publishDurableSessionEvents,
  publishDurableWorkspaceControlEvent,
  type EventBus,
} from "@opengeni/events";
import type { SessionWorkflowClient } from "../dependencies";

/** Internal host lifecycle, not a session-read/control API or a viewer grant. */
export async function cancelPublishedSiteSession(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
  },
  input: Parameters<typeof cancelSiteRuntimeConversation>[1],
) {
  const result = await cancelSiteRuntimeConversation(deps.db, input);
  if (!result) return null;
  // Capture only this command's event envelopes under its transaction witness.
  // Never re-open private transcript visibility to do post-commit fanout.
  const bySession = new Map<string, typeof result.events>();
  for (const event of result.events) {
    const group = bySession.get(event.sessionId) ?? [];
    group.push(event);
    bySession.set(event.sessionId, group);
  }
  const effects = await Promise.allSettled([
    ...[...bySession].map(([sessionId, events]) =>
      publishDurableSessionEvents(deps.bus, input.workspaceId, sessionId, events),
    ),
    ...(result.workspaceEvent
      ? [publishDurableWorkspaceControlEvent(deps.bus, input.workspaceId, result.workspaceEvent)]
      : []),
    ...(result.wakeCount > 0 ? [deps.workflowClient.requestSessionWorkflowWakeDispatch()] : []),
  ]);
  if (effects.some((effect) => effect.status === "rejected"))
    console.warn(
      "[site-lifecycle] post-commit fanout failed; durable events and wake outbox retained",
    );
  return {
    receiptId: result.receiptId,
    replay: result.replay,
    cancelledSessionCount: result.cancelledSessionCount,
    cancelledTurnCount: result.cancelledTurnCount,
  };
}
