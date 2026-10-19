import { randomUUID } from "node:crypto";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import type { NatsRequestConnection } from "./control-rpc";

/** Wire-only capability, deliberately absent from model-facing tool contracts. */
const REPLAY_HEADER = "Opengeni-Control-Replay";
const RECOVERY_MS = 120_000;
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
    ["503", "TIMEOUT", "DISCONNECT", "CONNECTION_CLOSED", "AUTHENTICATION_EXPIRED"].includes(code)
  );
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
  ) {}

  async request(
    conn: NatsRequestConnection,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
  ): Promise<{ data: Uint8Array }> {
    if (!conn.supportsHeaders) return conn.request(subject, payload, { timeout: timeoutMs });
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
    if (pool.legacy) return conn.request(subject, payload, { timeout: timeoutMs });
    const take = () => {
      pool.tokens = pool.tokens.filter(
        (token) => token.usableUntil >= performance.now() + lifetimeMs,
      );
      return pool.tokens.shift();
    };
    let token = take();
    while (!token) {
      const invalid = await this.refill(conn, subject, pool, timeoutMs, lifetimeMs, readySubject);
      if (invalid) {
        try {
          const response = ControlResponse.decode(invalid.data);
          response.requestId = ControlRequest.decode(payload).requestId;
          return { data: ControlResponse.encode(response).finish() };
        } catch {
          return invalid;
        }
      }
      if (pool.legacy) return conn.request(subject, payload, { timeout: timeoutMs });
      token = take();
      if (performance.now() >= deadline)
        throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    }
    // A warm call does not await replenishment. Concurrent callers share one
    // refill; only a cold/expired/exhausted pool needs a negotiation round trip.
    if (pool.tokens.length <= 16) {
      void this.refill(conn, subject, pool, timeoutMs, lifetimeMs, readySubject).catch(() => {});
    }
    const ageMs = Math.max(0, Math.floor(performance.now() - token.receivedAt));
    const delivery = `${subject}.replay.${token.id}.${ageMs}.${lifetimeMs}`;
    const reply = await this.retry(conn, delivery, payload, timeoutMs, deadline, readySubject);
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
  ): Promise<{ data: Uint8Array } | undefined> {
    if (pool.refill) return pool.refill;
    const pending = this.fetchBatch(conn, subject, pool, timeoutMs, lifetimeMs, readySubject);
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
      probe,
      timeoutMs,
      startedAt + lifetimeMs,
      readySubject,
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
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
    deadline: number,
    readySubject: string | undefined,
  ): ReturnType<NatsRequestConnection["request"]> {
    let uncertain: unknown;
    for (;;) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw uncertain ?? Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      }
      try {
        return await conn.request(subject, payload, {
          timeout: Math.max(1, Math.min(timeoutMs, remainingMs)),
          ...(readySubject ? { resendOn: readySubject } : {}),
        });
      } catch (error) {
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
        if (performance.now() + this.retryDelayMs >= deadline) throw uncertain ?? error;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }
}
