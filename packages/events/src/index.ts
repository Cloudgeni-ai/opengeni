import type { SessionBusMessage, SessionEvent } from "@opengeni/contracts";
import { appendSessionEvents, sessionSubject, type AppendEventInput, type Database } from "@opengeni/db";
import { connect, JSONCodec, type Msg, type NatsConnection, type Subscription } from "nats";

const codec = JSONCodec<SessionBusMessage | SessionEvent>();

/**
 * A raw request/reply reply — just the response bytes. Mirrors the subset of the
 * NATS `Msg` shape a binary request/reply caller needs (`NatsControlRpc` consumes
 * exactly this). Kept minimal so the events package does not leak the `nats` `Msg`
 * type into the agent-loop-free runtime leaf.
 */
export type RequestReply = { data: Uint8Array };

/**
 * The minimal request/reply connection the selfhosted control plane consumes
 * (structurally identical to `@opengeni/runtime`'s `NatsRequestConnection`). The
 * API/worker hand this accessor to `NatsControlRpc` so the control transport rides
 * the SAME managed NATS connection the event bus already owns — a NATS connection
 * natively supports both pub/sub and request/reply, so there is NEVER a second
 * connection.
 */
export interface RequestConnection {
  request(subject: string, payload: Uint8Array, opts: { timeout: number }): Promise<RequestReply>;
}

/**
 * A handler answering a request/reply on a subscribed subject: given the request
 * bytes (+ the concrete subject the message landed on, for `agent.<ws>.<id>.rpc`
 * style wildcard routing), return the response bytes to reply with. A thrown error
 * leaves the request unanswered (the caller's request times out / sees no
 * responder), which the control plane maps to `agent_offline` / reconnecting.
 */
export type RequestHandler = (request: Uint8Array, subject: string) => Promise<Uint8Array> | Uint8Array;

export type EventBus = {
  publish: (workspaceId: string, sessionId: string, events: SessionEvent[]) => Promise<void>;
  subscribe: (workspaceId: string, sessionId: string, onEvents: (events: SessionEvent[]) => void | Promise<void>) => Promise<() => void>;
  /**
   * Issue a binary request/reply on a subject over the bus's NATS connection
   * (the selfhosted control plane: `agent.<ws>.<id>.rpc`). A new usage of what was
   * a one-way bus — same connection, native NATS request/reply. Rejects on a
   * no-responder (NATS 503) or a request timeout; the caller (`NatsControlRpc`)
   * maps those to `agent_offline` / `agent_reconnecting`, never a NotFound.
   */
  request: (subject: string, payload: Uint8Array, opts: { timeoutMs: number }) => Promise<RequestReply>;
  /**
   * Subscribe-and-reply on a subject (the responder side — the enrolled agent, or
   * a test stand-in for it): for every request on `subject`, call `handler` and
   * `respond` with its bytes over the SAME connection. Returns an unsubscribe fn.
   * A subject may be a NATS wildcard (e.g. `agent.*.*.rpc`).
   */
  subscribeRequests: (subject: string, handler: RequestHandler) => () => void;
  /**
   * The `RequestConnection` accessor the selfhosted `NatsControlRpc` consumes —
   * the SAME managed connection (pub/sub + request/reply share it). The control
   * plane injects this so the transport never opens a second connection.
   */
  getRequestConnection: () => RequestConnection;
  close: () => Promise<void>;
};

export async function createNatsEventBus(natsUrl: string): Promise<EventBus> {
  const nc = await connect({ servers: natsUrl });
  const requestConnection: RequestConnection = {
    request: async (subject, payload, opts) => requestReply(nc, subject, payload, opts.timeout),
  };
  return {
    publish: async (workspaceId, sessionId, events) => {
      if (events.length === 0) {
        return;
      }
      nc.publish(sessionSubject(workspaceId, sessionId), codec.encode({ workspaceId, sessionId, events }));
      await nc.flush();
    },
    subscribe: async (workspaceId, sessionId, onEvents) => subscribeSession(nc, workspaceId, sessionId, onEvents),
    request: async (subject, payload, opts) => requestReply(nc, subject, payload, opts.timeoutMs),
    subscribeRequests: (subject, handler) => subscribeRequests(nc, subject, handler),
    getRequestConnection: () => requestConnection,
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

/**
 * A binary request/reply over the managed connection. Returns ONLY the reply
 * bytes (the `RequestReply` shape) — the request/reply error semantics (a
 * no-responder NATS 503, a request timeout) propagate as the rejected promise so
 * the caller owns the mapping. The reply is delivered via the connection's
 * built-in mux inbox; no extra subscription is created here.
 */
async function requestReply(nc: NatsConnection, subject: string, payload: Uint8Array, timeout: number): Promise<RequestReply> {
  const msg: Msg = await nc.request(subject, payload, { timeout });
  return { data: msg.data };
}

/**
 * Subscribe to `subject` and reply to every request with the handler's bytes,
 * over the SAME connection. The responder side of request/reply: each delivered
 * `Msg` carries a `reply` inbox; `msg.respond(bytes)` publishes the answer there.
 * A handler that throws (or a message with no `reply` subject) is left unanswered
 * — the requester then sees a timeout, never a malformed reply.
 */
function subscribeRequests(nc: NatsConnection, subject: string, handler: RequestHandler): () => void {
  const sub: Subscription = nc.subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      // A request always carries a reply inbox; a plain publish to this subject
      // (no reply) is ignored — request/reply is the only contract here.
      if (!msg.reply) {
        continue;
      }
      try {
        const reply = await handler(msg.data, msg.subject);
        msg.respond(reply);
      } catch {
        // Leave the request unanswered: the requester's request times out, which
        // the selfhosted control plane reads as a transient blip (reconnecting),
        // never a malformed reply. The responder stays subscribed for the next op.
      }
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
