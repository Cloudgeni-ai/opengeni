import type { SessionEvent } from "@opengeni/contracts";
import type { EventBus } from "@opengeni/events";

export class MemoryEventBus implements EventBus {
  published: SessionEvent[][] = [];
  private subscribers = new Map<string, Set<(events: SessionEvent[]) => void | Promise<void>>>();

  async publish(workspaceId: string, sessionId: string, events: SessionEvent[]): Promise<void> {
    this.published.push(events);
    const subscribers = this.subscribers.get(subject(workspaceId, sessionId));
    if (!subscribers) {
      return;
    }
    await Promise.all([...subscribers].map((subscriber) => subscriber(events)));
  }

  async subscribe(workspaceId: string, sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>): Promise<() => void> {
    const key = subject(workspaceId, sessionId);
    const subscribers = this.subscribers.get(key) ?? new Set();
    subscribers.add(onEvents);
    this.subscribers.set(key, subscribers);
    return () => {
      subscribers.delete(onEvents);
    };
  }

  async close(): Promise<void> {}
}

function subject(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}
