import { randomUUID } from "node:crypto";
import { ControlRequest } from "@opengeni/agent-proto";
import type { NatsRequestConnection } from "./control-rpc";

/** Wire-only capability, deliberately absent from model-facing tool contracts. */
const REPLAY_HEADER = "Opengeni-Control-Replay";
const RECOVERY_MS = 120_000;
/** How often a request still waiting for its reply checks that its agent
 * connection was not replaced. It reads Opengeni's own state, never the agent. */
const REPLACEMENT_CHECK_MS = 1_000;

function transient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["503", "TIMEOUT", "DISCONNECT", "CONNECTION_CLOSED", "AUTHENTICATION_EXPIRED"].includes(code)
  );
}

/** Retrying stopped because the agent connection the request's subject names
 * was replaced by a new one: that agent process is gone, and nothing will ever
 * answer the subject again. `neverSent` when no attempt reached a responder. */
export class ControlConnectionReplacedError extends Error {
  constructor(readonly neverSent: boolean) {
    super("the agent connection this request was sent to was replaced");
    this.name = "ControlConnectionReplacedError";
  }
}

/** Negotiates against one exact process, never an enrollment or a replacement
 * process. Retries keep the entire subject and payload immutable. The native
 * journal atomically joins duplicates and refuses expired deliveries even after
 * their retained reply has been collected. Legacy mutations remain one-shot. */
export class ControlReplyRecovery {
  private readonly supported = new Map<string, Promise<boolean>>();

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
    const deadline = Date.now() + timeoutMs + this.recoveryMs;
    let supported = this.supported.get(subject);
    if (!supported) {
      const probe = ControlRequest.encode(
        ControlRequest.fromPartial({
          requestId: randomUUID(),
          op: { $case: "ping", ping: { nonce: "0" } },
        }),
      ).finish();
      supported = this.retry(
        conn,
        subject,
        subject,
        probe,
        timeoutMs,
        deadline,
        connectionCurrent,
      ).then((reply) => reply.headers?.get(REPLAY_HEADER) === "1");
      this.supported.set(subject, supported);
      void supported.catch(() => {
        if (this.supported.get(subject) === supported) this.supported.delete(subject);
      });
    }
    if (!(await supported)) {
      // Negotiation and the request share one absolute deadline.
      return await attempt(
        conn,
        subject,
        payload,
        Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
        connectionCurrent,
      );
    }
    const delivery = `${subject}.replay.${deadline}.${randomUUID()}`;
    return this.retry(conn, subject, delivery, payload, timeoutMs, deadline, connectionCurrent);
  }

  private async retry(
    conn: NatsRequestConnection,
    target: string,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
    deadline: number,
    connectionCurrent?: () => Promise<boolean>,
  ): ReturnType<NatsRequestConnection["request"]> {
    let uncertain: unknown;
    for (;;) {
      try {
        return await attempt(
          conn,
          subject,
          payload,
          Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
          connectionCurrent,
        );
      } catch (error) {
        // Replaced while this attempt waited: it may have reached the old agent.
        if (error instanceof ControlConnectionReplacedError) throw error;
        // Even a definitive refusal of THIS attempt says nothing about a prior
        // attempt whose reply was lost. Stop, but preserve its uncertain outcome.
        if (!transient(error)) throw uncertain ?? error;
        // A later 503 cannot prove an EARLIER delivery did not execute. Keep
        // ambiguity across retries so the caller cannot classify this as a
        // never-sent mutation and mint another delivery after the journal expires.
        if ((error as { code?: string }).code !== "503") uncertain ??= error;
        // A replaced connection never answers again: its process is gone.
        if (connectionCurrent && !(await connectionCurrent().catch(() => true))) {
          throw new ControlConnectionReplacedError(uncertain === undefined);
        }
        if ((error as { code?: string }).code === "503" && this.onNoResponders) {
          const keepTrying = await this.onNoResponders(target).catch(() => false);
          if (!keepTrying) throw uncertain ?? error;
        }
        if (Date.now() + this.retryDelayMs >= deadline) throw uncertain ?? error;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }
}

/** One request attempt. While it waits for its reply, it ends as soon as the
 * agent connection its subject names is replaced: the old agent process is gone
 * and will never answer, however long a host holds the request. The attempt
 * was published, so it may have reached that agent: never "never sent". */
async function attempt(
  conn: NatsRequestConnection,
  subject: string,
  payload: Uint8Array,
  timeout: number,
  connectionCurrent: (() => Promise<boolean>) | undefined,
): ReturnType<NatsRequestConnection["request"]> {
  const reply = conn.request(subject, payload, { timeout });
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
