// The op-stream TRANSPORT seam (op-stream protocol v1.1, server half).
//
// The op-stream client needs two primitives the request/reply `ControlRpc`
// cannot express: a plain SUBSCRIPTION (runner→server op frames on
// `agent.<ws>.<id>.op.<op_id>`, fire-and-forget publishes) and a plain PUBLISH
// (server→runner acks on `agent.<ws>.<id>.ack`). This module defines that seam
// exactly like control-rpc.ts defines `ControlRpc`: the session leaf speaks
// ONLY `OpStreamTransport`; the worker/api inject a live NATS-backed
// implementation (the same lazy-factory discipline — boot never requires a
// live NATS), and tests inject an in-memory one.
//
// The control ops that START/steer an op (OpStart/OpCancel/OpQuery/OpAttach)
// deliberately do NOT ride this seam — they are ordinary `ControlRequest`s on
// the existing rpc subject through the existing `ControlRpc`, with its typed
// offline/timeout synthesis and retry taxonomy.

/** The per-op frame subject (runner→server, fire-and-forget). Mirrors the
 *  runner's wire constant: `agent.<ws>.<id>.op.<op_id>`. */
export function opFrameSubject(workspaceId: string, agentId: string, opId: string): string {
  return `agent.${workspaceId}.${agentId}.op.${opId}`;
}

/** The per-agent ack subject (server→runner, fire-and-forget). Mirrors the
 *  runner's wire constant: `agent.<ws>.<id>.ack`. */
export function opAckSubject(workspaceId: string, agentId: string): string {
  return `agent.${workspaceId}.${agentId}.ack`;
}

/** A live subscription handle. `unsubscribe` is idempotent and never throws. */
export interface OpStreamSubscription {
  unsubscribe(): void;
}

/**
 * The op-stream transport seam. `subscribe` MUST be established before the
 * OpStart that makes frames flow (subscription-before-start is a protocol
 * invariant: no frame is published before the consumer exists on a healthy
 * path; a missed frame is healed via OpAttach replay regardless). `onMessage`
 * is invoked in arrival order; a decode failure inside the handler must be
 * contained by the caller (a torn frame must never kill the subscription).
 */
export interface OpStreamTransport {
  subscribe(
    subject: string,
    onMessage: (payload: Uint8Array) => void,
  ): Promise<OpStreamSubscription>;
  publish(subject: string, payload: Uint8Array): Promise<void>;
}

/** Thrown when the transport has no live connection: the op-stream path is
 *  UNAVAILABLE (never silently degraded). The session catches this pre-start
 *  and falls back to the legacy exec — the op provably never started. */
export class OpStreamUnavailableError extends Error {
  readonly name = "OpStreamUnavailableError";
}

/**
 * The minimal NATS surface the transport needs — mirrors the `nats`
 * `NatsConnection` subscribe/publish WITHOUT importing `nats` into the
 * agent-loop-free runtime leaf (the worker injects the live `@opengeni/events`
 * bus connection, exactly like `NatsRequestConnection` in control-rpc.ts).
 * `subscribe` returns the nats.js Subscription shape: an async iterable of
 * messages plus `unsubscribe()`.
 */
export interface NatsOpStreamConnection {
  subscribe(subject: string): AsyncIterable<{ data: Uint8Array }> & { unsubscribe(): void };
  publish(subject: string, payload: Uint8Array): void;
}

/**
 * The NATS-backed transport. Lazy memoized factory (identical discipline to
 * `NatsControlRpc`): the connection resolves on first use; a null factory
 * result or a dial failure surfaces `OpStreamUnavailableError` — the caller
 * (the session) falls back to the LEGACY exec path rather than failing the op,
 * so a NATS-less boot or a torn bus never strands a turn on a dead transport.
 */
export class NatsOpStreamTransport implements OpStreamTransport {
  private readonly connect: () => Promise<NatsOpStreamConnection | null>;
  private connection: NatsOpStreamConnection | undefined;
  private connecting: Promise<NatsOpStreamConnection | null> | undefined;

  constructor(connect: () => Promise<NatsOpStreamConnection | null>) {
    this.connect = connect;
  }

  private async resolveConnection(): Promise<NatsOpStreamConnection | null> {
    if (this.connection) {
      return this.connection;
    }
    // Share one in-flight dial; cache only a real connection (a transient
    // null/throw must be retried by the next call — see NatsControlRpc).
    this.connecting ??= this.connect()
      .then((connection) => {
        if (connection) {
          this.connection = connection;
        }
        return connection;
      })
      .catch(() => null)
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  async subscribe(
    subject: string,
    onMessage: (payload: Uint8Array) => void,
  ): Promise<OpStreamSubscription> {
    const conn = await this.resolveConnection();
    if (!conn) {
      throw new OpStreamUnavailableError("op-stream transport has no live connection");
    }
    const subscription = conn.subscribe(subject);
    // Pump the async iterator into the callback. The iterator ends when
    // `unsubscribe()` is called (nats.js closes the iterator); a pump error
    // (torn connection) simply ends delivery — the op-stream client's silence
    // handling (OpQuery + re-attach) owns recovery, not the transport.
    void (async () => {
      try {
        for await (const message of subscription) {
          onMessage(message.data);
        }
      } catch {
        // Delivery ended with the connection; recovery is the client's job.
      }
    })();
    let unsubscribed = false;
    return {
      unsubscribe: () => {
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;
        try {
          subscription.unsubscribe();
        } catch {
          // Idempotent teardown: a torn connection already unsubscribed us.
        }
      },
    };
  }

  async publish(subject: string, payload: Uint8Array): Promise<void> {
    const conn = await this.resolveConnection();
    if (!conn) {
      throw new OpStreamUnavailableError("op-stream transport has no live connection");
    }
    conn.publish(subject, payload);
  }
}
