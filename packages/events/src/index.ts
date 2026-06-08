import type { SessionBusMessage, SessionEvent } from "@opengeni/contracts";
import { appendSessionEvents, sessionSubject, type AppendEventInput, type Database } from "@opengeni/db";
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";

const codec = JSONCodec<SessionBusMessage | SessionEvent>();

export type EventBus = {
  publish: (workspaceId: string, sessionId: string, events: SessionEvent[]) => Promise<void>;
  subscribe: (workspaceId: string, sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>) => Promise<() => void>;
  close: () => Promise<void>;
};

export async function createNatsEventBus(natsUrl: string): Promise<EventBus> {
  const nc = await connect({ servers: natsUrl });
  return {
    publish: async (workspaceId, sessionId, events) => {
      if (events.length === 0) {
        return;
      }
      nc.publish(sessionSubject(workspaceId, sessionId), codec.encode({ workspaceId, sessionId, events }));
      await nc.flush();
    },
    subscribe: async (workspaceId, sessionId, onEvents) => subscribeSession(nc, workspaceId, sessionId, onEvents),
    close: async () => {
      await nc.drain();
    },
  };
}

export async function appendAndPublishEvents(db: Database, bus: EventBus, workspaceId: string, sessionId: string, events: AppendEventInput[]): Promise<SessionEvent[]> {
  const appended = await appendSessionEvents(db, workspaceId, sessionId, events);
  await bus.publish(workspaceId, sessionId, appended);
  return appended;
}

function subscribeSession(nc: NatsConnection, workspaceId: string, sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>): () => void {
  const sub: Subscription = nc.subscribe(sessionSubject(workspaceId, sessionId));
  void (async () => {
    for await (const msg of sub) {
      const decoded = codec.decode(msg.data) as SessionBusMessage | SessionEvent;
      const events = "events" in decoded ? decoded.events : [decoded];
      await onEvents(events);
    }
  })();
  return () => {
    sub.unsubscribe();
  };
}

export function formatSse(event: SessionEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
