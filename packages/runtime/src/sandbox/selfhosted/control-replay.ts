import { randomUUID } from "node:crypto";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
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
    // Each call needs a fresh receiver-issued identity. Retrying this safe ping
    // may issue an unused lease, never execute the requested operation.
    const probe = ControlRequest.encode(
      ControlRequest.fromPartial({
        requestId: randomUUID(),
        op: { $case: "ping", ping: { nonce: "0", controlReplayWindowMs: String(lifetimeMs) } },
      }),
    ).finish();
    const negotiated = await this.retry(conn, subject, probe, timeoutMs, deadline, readySubject);
    if (negotiated.headers?.get(REPLAY_HEADER) !== "2") {
      return conn.request(subject, payload, { timeout: timeoutMs });
    }
    let response: ControlResponse;
    try {
      response = ControlResponse.decode(negotiated.data);
    } catch {
      // Let the existing malformed-response boundary classify these bytes as a
      // protocol error, not a transport outage. The mutation was never sent.
      return negotiated;
    }
    const token = response.result?.$case === "ping" ? response.result.ping.controlReplayToken : "";
    if (response.error || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token)) {
      return {
        data: ControlResponse.encode({
          requestId: ControlRequest.decode(payload).requestId,
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
    const delivery = `${subject}.replay.${token}`;
    return this.retry(conn, delivery, payload, timeoutMs, deadline, readySubject);
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
