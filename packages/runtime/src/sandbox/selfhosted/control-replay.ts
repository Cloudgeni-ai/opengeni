import { randomUUID } from "node:crypto";
import { ControlRequest } from "@opengeni/agent-proto";
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

/** The header of the empty reply a compute agent gateway publishes to a
 * request it forwarded into a session that then ended before the agent
 * answered: the request may have reached the agent, and its answer can no
 * longer come back that way. Never sent by an agent. */
export const AGENT_LINK_LOST_HEADER = "Opengeni-Agent-Link-Lost";

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
    const readySubject = subject.endsWith(".rpc") ? `${subject.slice(0, -4)}.hello` : undefined;
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
        readySubject,
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
    return this.retry(
      conn,
      subject,
      delivery,
      payload,
      timeoutMs,
      deadline,
      readySubject,
      connectionCurrent,
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
      try {
        return await attempt(
          conn,
          subject,
          payload,
          Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
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
