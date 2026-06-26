import type { SessionBusMessage, SessionEvent } from "@opengeni/contracts";
import { appendSessionEvents, sessionSubject, type AppendEventInput, type Database } from "@opengeni/db";
import { connect, JSONCodec, type ConnectionOptions, type Msg, type NatsConnection, type Subscription } from "nats";

const codec = JSONCodec<SessionBusMessage | SessionEvent>();

export {
  decodeAuthRequest,
  mintAuthResponse,
  mintUserJwt,
  workspaceAgentPermissions,
  type DecodedAuthRequest,
  type MintAuthResponseInput,
  type MintUserJwtInput,
  type NatsPermission,
  type NatsPermissions,
} from "./nats-jwt";

// Re-export the raw NATS primitives a consumer needs to open a direct connection or
// generate nkeys (the auth-callout responder's standalone connection, the
// agent-simulating integration tests). This keeps `nats` an internal dependency of
// this leaf — callers in the bun workspace reach it through @opengeni/events rather
// than depending on `nats` directly.
export { connect, nkeys, type NatsConnection } from "nats";

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
   * Subscribe to the agent EVENT plane (the one-way fire-and-forget heartbeats +
   * going-offline the agent PUBLISHES on `agent.<ws>.<id>.events`, NOT a
   * request/reply). The M10 metrics-ingestion consumer subscribes the wildcard
   * `agent.*.*.events` and gets each raw payload plus its concrete subject (so it
   * can extract `<ws>`/`<id>` for the per-enrollment upsert). Returns an
   * unsubscribe fn. Decoding the AgentEvent is the caller's concern (this leaf
   * does not depend on `@opengeni/agent-proto`).
   */
  subscribeAgentEvents: (
    subject: string,
    handler: (payload: Uint8Array, subject: string) => void | Promise<void>,
  ) => () => void;
  /**
   * The `RequestConnection` accessor the selfhosted `NatsControlRpc` consumes —
   * the SAME managed connection (pub/sub + request/reply share it). The control
   * plane injects this so the transport never opens a second connection.
   */
  getRequestConnection: () => RequestConnection;
  close: () => Promise<void>;
};

/**
 * Connect the event bus + control-plane request/reply over ONE managed NATS
 * connection. `auth` is the PRIVILEGED control-plane login (M-AUTH): when the
 * server runs with auth_callout, the api/worker authenticates as a static account
 * user permitted to request `agent.*.rpc` + receive its inbox replies. When `auth`
 * is omitted the connection is anonymous (local dev / a NATS without auth_callout)
 * — the existing behavior, unchanged.
 */
export async function createNatsEventBus(
  natsUrl: string,
  auth?: { user: string; pass: string },
): Promise<EventBus> {
  const connectOptions: ConnectionOptions = { servers: natsUrl };
  if (auth) {
    connectOptions.user = auth.user;
    connectOptions.pass = auth.pass;
  }
  const nc = await connect(connectOptions);
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
    subscribeAgentEvents: (subject, handler) => subscribeAgentEvents(nc, subject, handler),
    getRequestConnection: () => requestConnection,
    close: async () => {
      await nc.drain();
    },
  };
}

/**
 * A standalone NATS connection answering request/reply on ONE subject — the
 * transport primitive the auth-callout responder uses. It is DELIBERATELY a
 * SEPARATE connection from the event bus: the callout responder authenticates as
 * the callout account's `auth_users` user (a username/password or token in the
 * `AUTH` account), which is a DIFFERENT identity from the control-plane's
 * privileged account that the event bus + `NatsControlRpc` ride. One connection
 * per identity; never multiplex the two.
 *
 * `request`/`reply` here is the RAW NATS request/reply (`$SYS.REQ.USER.AUTH`): the
 * server publishes an authorization request with a reply inbox; the handler returns
 * the signed authorization-response bytes which we `respond` on that inbox.
 */
export interface ResponderConnection {
  /** Subscribe-and-reply on `subject`; returns an async close that drains. */
  close: () => Promise<void>;
}

/** Connection auth for a standalone NATS connection (the callout responder). */
export type NatsConnectAuth =
  | { kind: "user-password"; user: string; pass: string }
  | { kind: "token"; token: string }
  | { kind: "anonymous" };

/**
 * Open a standalone NATS connection and subscribe `subject`, replying to every
 * request with `handler(requestBytes, subject)`. Used by the auth-callout
 * responder to serve `$SYS.REQ.USER.AUTH` as the callout auth user. Returns a
 * handle whose `close()` drains the connection. A handler that throws leaves the
 * request UNANSWERED — for auth-callout that means the server denies the
 * connection on its own timeout, which is the correct fail-closed behavior (a
 * responder bug must never accidentally grant access).
 */
export async function createResponderConnection(
  natsUrl: string,
  auth: NatsConnectAuth,
  subject: string,
  handler: RequestHandler,
  options: { name?: string } = {},
): Promise<ResponderConnection> {
  const connectOptions: ConnectionOptions = { servers: natsUrl };
  if (options.name) {
    connectOptions.name = options.name;
  }
  if (auth.kind === "user-password") {
    connectOptions.user = auth.user;
    connectOptions.pass = auth.pass;
  } else if (auth.kind === "token") {
    connectOptions.token = auth.token;
  }
  const nc = await connect(connectOptions);
  const sub: Subscription = nc.subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      if (!msg.reply) {
        continue;
      }
      try {
        const reply = await handler(msg.data, msg.subject);
        msg.respond(reply);
      } catch {
        // Leave UNANSWERED — fail-closed. The server denies the connect attempt
        // on its callout timeout; a responder error never grants access.
      }
    }
  })();
  return {
    close: async () => {
      sub.unsubscribe();
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

/**
 * Subscribe to the one-way agent event plane: deliver each published payload (the
 * agent's `AgentEvent` heartbeat / going-offline, NOT a request/reply) to the
 * handler with its concrete subject. A plain `nc.subscribe` (no reply); a handler
 * that throws is swallowed so one bad event never tears down the subscription
 * (ingestion is best-effort — a metrics gap is never fatal).
 */
function subscribeAgentEvents(
  nc: NatsConnection,
  subject: string,
  handler: (payload: Uint8Array, subject: string) => void | Promise<void>,
): () => void {
  const sub: Subscription = nc.subscribe(subject);
  void (async () => {
    for await (const msg of sub) {
      try {
        await handler(msg.data, msg.subject);
      } catch {
        // Swallow: best-effort ingestion. The subscription stays live for the
        // next event.
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
