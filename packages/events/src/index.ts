import type { SessionBusMessage, SessionEvent } from "@infra-agents/contracts";
import { appendSessionEvents, sessionSubject, type AppendEventInput, type Database } from "@infra-agents/db";
import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";

const codec = JSONCodec<SessionBusMessage | SessionEvent>();

export type EventBus = {
  publish: (sessionId: string, events: SessionEvent[]) => Promise<void>;
  subscribe: (sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>) => Promise<() => void>;
  close: () => Promise<void>;
};

export async function createNatsEventBus(natsUrl: string): Promise<EventBus> {
  const nc = await connect({ servers: natsUrl });
  return {
    publish: async (sessionId, events) => {
      if (events.length === 0) {
        return;
      }
      nc.publish(sessionSubject(sessionId), codec.encode({ sessionId, events }));
      await nc.flush();
    },
    subscribe: async (sessionId, onEvents) => subscribeSession(nc, sessionId, onEvents),
    close: async () => {
      await nc.drain();
    },
  };
}

export async function appendAndPublishEvents(db: Database, bus: EventBus, sessionId: string, events: AppendEventInput[]): Promise<SessionEvent[]> {
  const appended = await appendSessionEvents(db, sessionId, events);
  await bus.publish(sessionId, appended);
  return appended;
}

function subscribeSession(nc: NatsConnection, sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>): () => void {
  const sub: Subscription = nc.subscribe(sessionSubject(sessionId));
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
