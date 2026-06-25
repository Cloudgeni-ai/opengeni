import type { SessionEvent } from "@opengeni/contracts";
import type { EventBus, RequestConnection, RequestHandler, RequestReply } from "@opengeni/events";

export class MemoryEventBus implements EventBus {
  published: SessionEvent[][] = [];
  private subscribers = new Map<string, Set<(events: SessionEvent[]) => void | Promise<void>>>();
  /** One responder per subject — the in-memory mirror of a NATS request/reply
   *  subscription. A missing entry models "no responder" (NATS 503 → offline). */
  private responders = new Map<string, RequestHandler>();

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

  async request(subject: string, payload: Uint8Array, _opts: { timeoutMs: number }): Promise<RequestReply> {
    const handler = this.responders.get(subject);
    if (!handler) {
      // No responder on the subject — model the NATS 503 NoResponders the real
      // transport surfaces, so a consumer's offline mapping is exercised in-memory.
      const error = new Error("503") as Error & { code: string };
      error.code = "503";
      throw error;
    }
    const data = await handler(payload, subject);
    return { data };
  }

  subscribeRequests(subject: string, handler: RequestHandler): () => void {
    this.responders.set(subject, handler);
    return () => {
      if (this.responders.get(subject) === handler) {
        this.responders.delete(subject);
      }
    };
  }

  getRequestConnection(): RequestConnection {
    return {
      request: (subject, payload, opts) => this.request(subject, payload, { timeoutMs: opts.timeout }),
    };
  }

  async close(): Promise<void> {}
}

function subject(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}
