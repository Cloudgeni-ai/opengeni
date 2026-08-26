import {
  boundWorkspaceControlEvent,
  type SessionEvent,
  type WorkspaceControlEvent,
} from "@opengeni/contracts";
import {
  SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
  type EventBus,
  type RequestConnection,
  type RequestHandler,
  type RequestReply,
} from "@opengeni/events";

export class MemoryEventBus implements EventBus {
  published: SessionEvent[][] = [];
  publishedWorkspaceControl: WorkspaceControlEvent[] = [];
  private subscribers = new Map<string, Set<(events: SessionEvent[]) => void | Promise<void>>>();
  private workspaceControlSubscribers = new Map<
    string,
    Set<(event: WorkspaceControlEvent) => void | Promise<void>>
  >();
  /** One responder per subject — the in-memory mirror of a NATS request/reply
   *  subscription. A missing entry models "no responder" (NATS 503 → offline). */
  private responders = new Map<string, RequestHandler>();
  /** Agent-event (one-way) subscribers, keyed by the subscribed subject pattern.
   *  The in-memory mirror of `agent.*.*.connection.*.events` pub/sub for the
   *  metrics-ingestion consumer. */
  private agentEventSubscribers = new Map<
    string,
    Set<(payload: Uint8Array, subject: string) => void | Promise<void>>
  >();
  private sessionEventRecoverySubscribers = new Set<(generation: number) => void>();
  private sessionEventRecoveryGeneration = 0;

  readonly sessionEventDurableFanout = {
    version: SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
    subscribeRecovery: (listener: (generation: number) => void) => {
      this.sessionEventRecoverySubscribers.add(listener);
      return () => this.sessionEventRecoverySubscribers.delete(listener);
    },
  };

  async publish(workspaceId: string, sessionId: string, events: SessionEvent[]): Promise<void> {
    this.published.push(events);
    const subscribers = this.subscribers.get(subject(workspaceId, sessionId));
    if (!subscribers) {
      return;
    }
    await Promise.all([...subscribers].map((subscriber) => subscriber(events)));
  }

  async publishConfirmed(
    workspaceId: string,
    sessionId: string,
    events: SessionEvent[],
  ): Promise<void> {
    await this.publish(workspaceId, sessionId, events);
  }

  async subscribe(
    workspaceId: string,
    sessionId: string,
    onEvents: (events: SessionEvent[]) => void | Promise<void>,
  ): Promise<() => void> {
    const key = subject(workspaceId, sessionId);
    const subscribers = this.subscribers.get(key) ?? new Set();
    subscribers.add(onEvents);
    this.subscribers.set(key, subscribers);
    return () => {
      subscribers.delete(onEvents);
    };
  }

  async publishWorkspaceControl(workspaceId: string, event: WorkspaceControlEvent): Promise<void> {
    const bounded = boundWorkspaceControlEvent(event, { surface: "nats_legacy_guard" });
    this.publishedWorkspaceControl.push(bounded);
    const subscribers = this.workspaceControlSubscribers.get(workspaceId);
    if (subscribers) {
      await Promise.all([...subscribers].map((subscriber) => subscriber(bounded)));
    }
  }

  async subscribeWorkspaceControl(
    workspaceId: string,
    onEvent: (event: WorkspaceControlEvent) => void | Promise<void>,
  ): Promise<() => void> {
    const subscribers = this.workspaceControlSubscribers.get(workspaceId) ?? new Set();
    subscribers.add(onEvent);
    this.workspaceControlSubscribers.set(workspaceId, subscribers);
    return () => subscribers.delete(onEvent);
  }

  async request(
    requestSubject: string,
    payload: Uint8Array,
    _opts: { timeoutMs: number },
  ): Promise<RequestReply> {
    const handler = this.responders.get(requestSubject);
    if (!handler) {
      // No responder on the subject — model the NATS 503 NoResponders the real
      // transport surfaces, so a consumer's offline mapping is exercised in-memory.
      const error = new Error("503") as Error & { code: string };
      error.code = "503";
      throw error;
    }
    const data = await handler(payload, requestSubject);
    return { data };
  }

  subscribeRequests(requestSubject: string, handler: RequestHandler): () => void {
    this.responders.set(requestSubject, handler);
    return () => {
      if (this.responders.get(requestSubject) === handler) {
        this.responders.delete(requestSubject);
      }
    };
  }

  subscribeAgentEvents(
    subjectPattern: string,
    handler: (payload: Uint8Array, subject: string) => void | Promise<void>,
  ): () => void {
    const subscribers = this.agentEventSubscribers.get(subjectPattern) ?? new Set();
    subscribers.add(handler);
    this.agentEventSubscribers.set(subjectPattern, subscribers);
    return () => {
      subscribers.delete(handler);
    };
  }

  /** Test helper: publish a raw agent-event payload on a concrete process subject,
   *  delivering it to every matching wildcard subscriber. Mirrors NATS delivery
   *  so ingestion tests can drive a generation-fenced heartbeat without a broker. */
  async emitAgentEvent(eventSubject: string, payload: Uint8Array): Promise<void> {
    const matching: Array<(payload: Uint8Array, subject: string) => void | Promise<void>> = [];
    for (const [pattern, subscribers] of this.agentEventSubscribers) {
      if (subjectMatches(pattern, eventSubject)) {
        matching.push(...subscribers);
      }
    }
    await Promise.all(matching.map((handler) => handler(payload, eventSubject)));
  }

  /** Test helper: model one successful broker/subscription recovery generation. */
  emitSessionEventRecovery(): number {
    this.sessionEventRecoveryGeneration += 1;
    for (const listener of this.sessionEventRecoverySubscribers) {
      listener(this.sessionEventRecoveryGeneration);
    }
    return this.sessionEventRecoveryGeneration;
  }

  getRequestConnection(): RequestConnection {
    return {
      request: (requestSubject, payload, opts) =>
        this.request(requestSubject, payload, { timeoutMs: opts.timeout }),
    };
  }

  async close(): Promise<void> {
    this.sessionEventRecoverySubscribers.clear();
  }
}

/** NATS-style subject wildcard match: `*` matches exactly one token. */
function subjectMatches(pattern: string, candidateSubject: string): boolean {
  const p = pattern.split(".");
  const s = candidateSubject.split(".");
  if (p.length !== s.length) {
    return false;
  }
  return p.every((token, i) => token === "*" || token === s[i]);
}

function subject(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}
