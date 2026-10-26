import { randomUUID } from "node:crypto";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import type { NatsRequestConnection } from "./control-rpc";

/** Wire-only capability, deliberately absent from model-facing tool contracts. */
const REPLAY_HEADER = "Opengeni-Control-Replay";
/** How long past a request's own timeout its reply is still recovered; the
 * agent refuses a delivery whose recovery deadline has passed. */
export const CONTROL_REPLY_RECOVERY_MS = 120_000;
const RECOVERY_MS = CONTROL_REPLY_RECOVERY_MS;
/** How often a request still waiting for its reply checks that its agent
 * connection was not replaced. It reads Opengeni's own state, never the agent. */
const REPLACEMENT_CHECK_MS = 1_000;
/** The fraction by which a delivery understates its elapsed offset. Elapsed
 * clocks on two hosts tick at slightly different rates, because time
 * synchronization steers each host's frequency on its own (Linux bounds that
 * steering at 500 ppm). The agent refuses an offset that would place a call
 * after its own present, so with an exact offset a caller clock only slightly
 * faster than the agent's made every older token unusable once the rate
 * difference times the token's age exceeded the network round trip. A 1%
 * understatement covers that bound twenty times. The agent then charges the
 * call slightly more elapsed time, never less, so its delivery and exec
 * deadlines can only come sooner. */
const ELAPSED_RATE_ALLOWANCE = 0.01;

/** The header of the empty reply a compute agent gateway publishes to a
 * request it forwarded into a session that then ended before the agent
 * answered: the request may have reached the agent, and its answer can no
 * longer come back that way. Never sent by an agent. */
export const AGENT_LINK_LOST_HEADER = "Opengeni-Agent-Link-Lost";

/** Marks a housekeeping request that must never wake its sandbox. A compute
 * host delivers it only while the sandbox runs and its agent holds the
 * subscription, never counts it as activity and never queues it; otherwise
 * it answers it itself with AGENT_UNANSWERED_HEADER. A Connected Machine's
 * agent simply receives it. */
export const NO_WAKE_HEADER = "Opengeni-No-Wake";

/** The header of the empty reply a compute host gives a no-wake request it
 * did not hand to the agent: "asleep" (the sandbox is not running), "away"
 * (the agent does not hold the subscription) or "busy" (too many requests
 * outstanding). Only the host says it; it strips it from anything the agent
 * publishes. */
export const AGENT_UNANSWERED_HEADER = "Opengeni-Agent-Unanswered";

/** The link that carried a request to its agent ended before the answer
 * came back. The request may have been delivered, so it is never "never
 * sent"; a replayable request is delivered again at once. */
export class AgentLinkLostError extends Error {
  readonly code = "AGENT_LINK_LOST";
  constructor() {
    super("the link that carried this request to its agent ended before the agent answered");
    this.name = "AgentLinkLostError";
  }
}

function linkLost(reply: { data: Uint8Array; headers?: { get(name: string): string } }): boolean {
  return reply.data.byteLength === 0 && reply.headers?.get(AGENT_LINK_LOST_HEADER) === "1";
}

type Token = { id: string; receivedAt: number; usableUntil: number };
type Pool = {
  tokens: Token[];
  legacy: boolean;
  expiresAt: number;
  refill?: Promise<{ data: Uint8Array } | undefined>;
};
// One-off adapters create new RPC facades, but share the authenticated bus.
// Cache by that connection and exact process subject, never by enrollment alone.
const pools = new WeakMap<NatsRequestConnection, Map<string, Pool>>();

function transient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    [
      "503",
      "TIMEOUT",
      "DISCONNECT",
      "CONNECTION_CLOSED",
      "AUTHENTICATION_EXPIRED",
      "AGENT_LINK_LOST",
    ].includes(code)
  );
}

/** Retrying stopped because the agent connection the request's subject names
 * was replaced by a new one, so the request stops waiting on that subject.
 * The old process may still run. `neverSent` when no attempt reached a
 * responder. */
export class ControlConnectionReplacedError extends Error {
  constructor(readonly neverSent: boolean) {
    super("the agent connection this request was sent to was replaced");
    this.name = "ControlConnectionReplacedError";
  }
}

/** Marks a no-responder that outlasted the whole recovery window, so callers
 * know the wait for this exact process already happened. */
function windowExhausted(error: unknown): unknown {
  if ((error as { code?: unknown } | null)?.code !== "503") return error;
  return Object.assign(error as object, { responderWaitExhausted: true });
}

/** Whether a no-responder came after the full recovery window. */
export function responderWaitExhausted(error: unknown): boolean {
  return (error as { responderWaitExhausted?: unknown } | null)?.responderWaitExhausted === true;
}

/** Negotiates against one exact process, never an enrollment or a replacement
 * process. Retries keep the entire subject and payload immutable. The native
 * journal issues a monotonic lease before execution, then atomically joins
 * duplicates. Unknown/collected identities are never admitted. Legacy mutations
 * remain one-shot; sender wall-clock deadlines are no longer negotiated. */
export class ControlReplyRecovery {
  constructor(
    private readonly recoveryMs = RECOVERY_MS,
    private readonly retryDelayMs = 250,
    /** Called on each "no responders" with the request's own subject, before
     * the same delivery is retried. It may act to bring the responder back (a
     * sleeping sandbox is woken); false or a throw stops retrying at once. */
    private readonly onNoResponders?: (subject: string) => Promise<boolean>,
  ) {}

  async request(
    conn: NatsRequestConnection,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
    /** False once the subject's connection was replaced; see ControlRpc. */
    connectionCurrent?: () => Promise<boolean>,
  ): Promise<{ data: Uint8Array }> {
    if (!conn.supportsHeaders) {
      return await attempt(conn, subject, payload, timeoutMs, connectionCurrent);
    }
    const lifetimeMs = Math.ceil(timeoutMs + this.recoveryMs);
    const deadline = performance.now() + lifetimeMs;
    const readySubject = subject.endsWith(".rpc") ? `${subject.slice(0, -4)}.hello` : undefined;
    let subjects = pools.get(conn);
    if (!subjects) pools.set(conn, (subjects = new Map()));
    for (const [key, candidate] of subjects) {
      if (!candidate.refill && candidate.expiresAt <= performance.now()) subjects.delete(key);
    }
    let pool = subjects.get(subject);
    if (!pool) subjects.set(subject, (pool = { tokens: [], legacy: false, expiresAt: deadline }));
    if (pool.legacy) return await attempt(conn, subject, payload, timeoutMs, connectionCurrent);
    const take = () => {
      pool.tokens = pool.tokens.filter(
        (token) => token.usableUntil >= performance.now() + lifetimeMs,
      );
      return pool.tokens.shift();
    };
    let token = take();
    while (!token) {
      const invalid = await this.refill(
        conn,
        subject,
        pool,
        timeoutMs,
        lifetimeMs,
        readySubject,
        connectionCurrent,
      );
      if (invalid) {
        try {
          const response = ControlResponse.decode(invalid.data);
          response.requestId = ControlRequest.decode(payload).requestId;
          return { data: ControlResponse.encode(response).finish() };
        } catch {
          return invalid;
        }
      }
      if (pool.legacy) {
        // Negotiation and the request share one deadline.
        return await attempt(
          conn,
          subject,
          payload,
          Math.max(1, Math.min(timeoutMs, deadline - performance.now())),
          connectionCurrent,
        );
      }
      token = take();
      if (performance.now() >= deadline)
        throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    }
    // A warm call does not await replenishment. Concurrent callers share one
    // refill; only a cold/expired/exhausted pool needs a negotiation round trip.
    if (pool.tokens.length <= 16) {
      void this.refill(
        conn,
        subject,
        pool,
        timeoutMs,
        lifetimeMs,
        readySubject,
        connectionCurrent,
      ).catch(() => {});
    }
    const elapsedMs = Math.max(0, performance.now() - token.receivedAt);
    const ageMs = Math.floor(elapsedMs * (1 - ELAPSED_RATE_ALLOWANCE));
    const delivery = `${subject}.replay.${token.id}.${ageMs}.${lifetimeMs}`;
    // The machine's receipt now ends that much sooner, so stop retrying sooner
    // too: a late retry should not meet an expired receipt instead of its reply.
    const reply = await this.retry(
      conn,
      subject,
      delivery,
      payload,
      timeoutMs,
      deadline - (elapsedMs - ageMs),
      readySubject,
      connectionCurrent,
    );
    // A suspended caller may not observe elapsed sleep in performance.now().
    // Never reissue this call, but discard stale prefetched tokens for the next.
    try {
      if (
        ControlResponse.decode(reply.data).error?.detail.failure_code === "control_delivery_expired"
      ) {
        pool.tokens = [];
      }
    } catch {
      /* The normal response decoder owns malformed reply handling. */
    }
    return reply;
  }

  private refill(
    conn: NatsRequestConnection,
    subject: string,
    pool: Pool,
    timeoutMs: number,
    lifetimeMs: number,
    readySubject: string | undefined,
    connectionCurrent?: () => Promise<boolean>,
  ): Promise<{ data: Uint8Array } | undefined> {
    if (pool.refill) return pool.refill;
    const pending = this.fetchBatch(
      conn,
      subject,
      pool,
      timeoutMs,
      lifetimeMs,
      readySubject,
      connectionCurrent,
    );
    pool.refill = pending;
    void pending
      .finally(() => {
        if (pool.refill === pending) delete pool.refill;
      })
      .catch(() => {});
    return pending;
  }

  private async fetchBatch(
    conn: NatsRequestConnection,
    subject: string,
    pool: Pool,
    timeoutMs: number,
    lifetimeMs: number,
    readySubject: string | undefined,
    connectionCurrent?: () => Promise<boolean>,
  ): Promise<{ data: Uint8Array } | undefined> {
    const startedAt = performance.now();
    const windowMs = lifetimeMs * 2;
    // Retrying this safe request can only allocate unused tokens, never execute
    // the operation. The local usable bound starts before network transmission.
    const probe = ControlRequest.encode(
      ControlRequest.fromPartial({
        requestId: randomUUID(),
        op: { $case: "ping", ping: { nonce: "0", controlReplayWindowMs: String(windowMs) } },
      }),
    ).finish();
    const negotiated = await this.retry(
      conn,
      subject,
      subject,
      probe,
      timeoutMs,
      startedAt + lifetimeMs,
      readySubject,
      connectionCurrent,
    );
    if (negotiated.headers?.get(REPLAY_HEADER) !== "2") {
      pool.legacy = true;
      pool.expiresAt = startedAt + windowMs;
      return;
    }
    let response: ControlResponse;
    try {
      response = ControlResponse.decode(negotiated.data);
    } catch {
      // Let the existing malformed-response boundary classify these bytes as a
      // protocol error, not a transport outage. The mutation was never sent.
      return negotiated;
    }
    const tokens =
      response.result?.$case === "ping" ? response.result.ping.controlReplayTokens : [];
    if (
      response.error ||
      !tokens.length ||
      new Set(tokens).size !== tokens.length ||
      tokens.some((token) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token))
    ) {
      return {
        data: ControlResponse.encode({
          requestId: response.requestId,
          result: undefined,
          error: response.error ?? {
            code: ErrorCode.ERROR_CODE_PROTOCOL,
            message: "The machine did not issue a valid control delivery token.",
            retryable: false,
            detail: {},
          },
        }).finish(),
      };
    }
    const receivedAt = performance.now();
    pool.expiresAt = Math.max(pool.expiresAt, startedAt + windowMs);
    pool.tokens.push(
      ...tokens.map((id) => ({ id, receivedAt, usableUntil: startedAt + windowMs })),
    );
  }

  private async retry(
    conn: NatsRequestConnection,
    target: string,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
    deadline: number,
    readySubject: string | undefined,
    connectionCurrent?: () => Promise<boolean>,
  ): ReturnType<NatsRequestConnection["request"]> {
    let uncertain: unknown;
    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw uncertain ?? Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      }
      try {
        return await attempt(
          conn,
          subject,
          payload,
          Math.max(1, Math.min(timeoutMs, remainingMs)),
          connectionCurrent,
          readySubject,
        );
      } catch (error) {
        // Replaced while this attempt waited: it may have reached the old agent.
        if (error instanceof ControlConnectionReplacedError) throw error;
        // A transport-level resend may already have an uncertain first delivery.
        // Keep that uncertainty, but do not retry a permanent refusal underneath it.
        const cause = (error as { cause?: unknown } | null)?.cause;
        if (cause && !transient(cause)) throw error;
        // Even a definitive refusal of THIS attempt says nothing about a prior
        // attempt whose reply was lost. Stop, but preserve its uncertain outcome.
        if (!transient(error)) throw uncertain ?? error;
        // A later 503 cannot prove an EARLIER delivery did not execute. Keep
        // ambiguity across retries so the caller cannot classify this as a
        // never-sent mutation and mint another delivery after the journal expires.
        if ((error as { code?: string }).code !== "503") uncertain ??= error;
        // Another process holds the connection: stop retrying this subject.
        if (connectionCurrent && !(await connectionCurrent().catch(() => true))) {
          throw new ControlConnectionReplacedError(uncertain === undefined);
        }
        // The window is spent, so callers do not wait it again.
        if (performance.now() + this.retryDelayMs >= deadline)
          throw uncertain ?? windowExhausted(error);
        if ((error as { code?: string }).code === "503" && this.onNoResponders) {
          const keepTrying = await this.onNoResponders(target).catch(() => false);
          // A refusal that came only once the hook had spent the window
          // still spent it.
          const spent = performance.now() + this.retryDelayMs >= deadline;
          if (!keepTrying) throw uncertain ?? (spent ? windowExhausted(error) : error);
          if (spent) throw uncertain ?? windowExhausted(error);
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }
}

/** One request attempt. While it waits for its reply, it ends as soon as the
 * agent connection its subject names is replaced, however long a host holds
 * the request: the caller stops waiting on the old process. It also ends when
 * the link that carried it ends (AgentLinkLostError). The attempt was
 * published, so it may have reached that agent: never "never sent". */
async function attempt(
  conn: NatsRequestConnection,
  subject: string,
  payload: Uint8Array,
  timeout: number,
  connectionCurrent: (() => Promise<boolean>) | undefined,
  /** The agent's reconnect notification: the same delivery is resent on it. */
  resendOn?: string,
): ReturnType<NatsRequestConnection["request"]> {
  const reply = await awaitReply(conn, subject, payload, timeout, connectionCurrent, resendOn);
  if (linkLost(reply)) throw new AgentLinkLostError();
  return reply;
}

async function awaitReply(
  conn: NatsRequestConnection,
  subject: string,
  payload: Uint8Array,
  timeout: number,
  connectionCurrent: (() => Promise<boolean>) | undefined,
  resendOn: string | undefined,
): ReturnType<NatsRequestConnection["request"]> {
  const reply = conn.request(subject, payload, { timeout, ...(resendOn ? { resendOn } : {}) });
  if (!connectionCurrent) return await reply;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const replaced = new Promise<never>((_, reject) => {
    const check = async () => {
      if (done) return;
      if (!(await connectionCurrent().catch(() => true))) {
        reject(new ControlConnectionReplacedError(false));
        return;
      }
      if (!done) timer = setTimeout(check, REPLACEMENT_CHECK_MS);
    };
    timer = setTimeout(check, REPLACEMENT_CHECK_MS);
  });
  void replaced.catch(() => {});
  try {
    return await Promise.race([reply, replaced]);
  } finally {
    done = true;
    clearTimeout(timer);
    void reply.catch(() => {});
  }
}
