import type { SessionEvent } from "@infra-agents/contracts";
import type { EventBus } from "@infra-agents/events";

export class MemoryEventBus implements EventBus {
  published: SessionEvent[][] = [];
  private subscribers = new Map<string, Set<(events: SessionEvent[]) => void | Promise<void>>>();

  async publish(sessionId: string, events: SessionEvent[]): Promise<void> {
    this.published.push(events);
    const subscribers = this.subscribers.get(sessionId);
    if (!subscribers) {
      return;
    }
    await Promise.all([...subscribers].map((subscriber) => subscriber(events)));
  }

  async subscribe(sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>): Promise<() => void> {
    const subscribers = this.subscribers.get(sessionId) ?? new Set();
    subscribers.add(onEvents);
    this.subscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(onEvents);
    };
  }

  async close(): Promise<void> {}
}
