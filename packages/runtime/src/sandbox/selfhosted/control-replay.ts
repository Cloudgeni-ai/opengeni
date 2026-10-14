import { randomUUID } from "node:crypto";
import { ControlRequest } from "@opengeni/agent-proto";
import type { NatsRequestConnection } from "./control-rpc";

/** Wire-only capability, deliberately absent from model-facing tool contracts. */
const REPLAY_HEADER = "Opengeni-Control-Replay";
const RECOVERY_MS = 120_000;

function transient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["503", "TIMEOUT", "DISCONNECT", "CONNECTION_CLOSED", "AUTHENTICATION_EXPIRED"].includes(code)
  );
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
  ) {}

  async request(
    conn: NatsRequestConnection,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
  ): Promise<{ data: Uint8Array }> {
    if (!conn.supportsHeaders) return conn.request(subject, payload, { timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs + this.recoveryMs;
    let supported = this.supported.get(subject);
    if (!supported) {
      const probe = ControlRequest.encode(
        ControlRequest.fromPartial({
          requestId: randomUUID(),
          op: { $case: "ping", ping: { nonce: "0" } },
        }),
      ).finish();
      supported = this.retry(conn, subject, probe, timeoutMs, deadline).then(
        (reply) => reply.headers?.get(REPLAY_HEADER) === "1",
      );
      this.supported.set(subject, supported);
      void supported.catch(() => {
        if (this.supported.get(subject) === supported) this.supported.delete(subject);
      });
    }
    if (!(await supported)) return conn.request(subject, payload, { timeout: timeoutMs });
    const delivery = `${subject}.replay.${deadline}.${randomUUID()}`;
    return this.retry(conn, delivery, payload, timeoutMs, deadline);
  }

  private async retry(
    conn: NatsRequestConnection,
    subject: string,
    payload: Uint8Array,
    timeoutMs: number,
    deadline: number,
  ): ReturnType<NatsRequestConnection["request"]> {
    let uncertain: unknown;
    for (;;) {
      try {
        return await conn.request(subject, payload, {
          timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
        });
      } catch (error) {
        // Even a definitive refusal of THIS attempt says nothing about a prior
        // attempt whose reply was lost. Stop, but preserve its uncertain outcome.
        if (!transient(error)) throw uncertain ?? error;
        // A later 503 cannot prove an EARLIER delivery did not execute. Keep
        // ambiguity across retries so the caller cannot classify this as a
        // never-sent mutation and mint another delivery after the journal expires.
        if ((error as { code?: string }).code !== "503") uncertain ??= error;
        if (Date.now() + this.retryDelayMs >= deadline) throw uncertain ?? error;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }
}
