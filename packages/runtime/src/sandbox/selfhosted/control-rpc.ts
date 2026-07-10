// The selfhosted CONTROL-PLANE transport seam (the M3/M4 layering boundary).
//
// `ControlRpc` is the ONE seam the `SelfhostedSession` depends on to reach a
// user's enrolled machine: request/reply addressed by the subject
// `agent.<workspaceId>.<agentId>.rpc`, payloads encoded/decoded via
// `@opengeni/agent-proto` (the single-source-of-truth wire types). The session
// knows NOTHING about NATS — it speaks only `ControlRpc`.
//
// M3 ships TWO implementors behind this interface:
//   - `NatsControlRpc` — a thin wrapper over a NATS request/reply connection
//     (the existing `@opengeni/events` bus connection). Constructed LAZILY: if
//     NATS/the relay is not configured it surfaces `agent_offline` rather than
//     throwing at construction, so boot never requires a live NATS.
//   - `MockAgentResponder` — an in-process test double that answers
//     exec/fs.read/fs.write/ping (and the rest of the op table) without any
//     broker, so the session surface + the AgentError→reason mapping are unit-
//     and integration-testable with no live NATS (that is M4).
//
// M4 will HARDEN/REPLACE `NatsControlRpc` (NATS Accounts, real request
// hardening, retries) behind this SAME `ControlRpc` interface — design for that,
// do not duplicate.

import { AgentError, ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import type { CapabilityUnavailableReason } from "@opengeni/contracts";

// Re-export the contracts reason union locally so callers of the mapping below
// don't have to import from two places. CapabilityUnavailableReason here is the
// agent-proto mirror of the contracts enum (same string values); the runtime
// negotiation maps to the contracts type, which is structurally identical.
export type SelfhostedUnavailableReason = Extract<
  CapabilityUnavailableReason,
  "agent_offline" | "agent_reconnecting" | "consent_required" | "display_unavailable"
>;

/**
 * The selfhosted control-plane transport seam. ONE method: `request` — send a
 * `ControlRequest` to the agent addressed by subject and await its
 * `ControlResponse`. The subject is `subjectFor(workspaceId, agentId)`.
 *
 * The CONTRACT every implementor MUST honour (the M3 ruling): a
 * no-responder / request-timeout is NOT an exception that means "not found" — it
 * is surfaced as a `ControlResponse` carrying an `AgentError` with code
 * `AGENT_OFFLINE` (no responder at all) or, when the caller can distinguish a
 * transient blip, `TIMEOUT` (→ `agent_reconnecting`). The session maps these to
 * the runtime error taxonomy; it NEVER lets agent-offline look like a provider
 * NotFound (which would cold-create a rival box for a user's real machine).
 */
export interface ControlRpc {
  request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse>;
}

/** The control-plane RPC subject for an enrolled agent — its subscription IS the
 *  registry (the binding two-plane decision). */
export function subjectFor(workspaceId: string, agentId: string): string {
  return `agent.${workspaceId}.${agentId}.rpc`;
}

// ── The runtime error taxonomy for a selfhosted control op ────────────────────

/**
 * The runtime-level error a `SelfhostedSession` op throws when the agent returns
 * an `AgentError` (or no responder / timeout maps to one). It carries:
 *   - `code`     — the wire `ErrorCode` (single-source-of-truth);
 *   - `reason`   — the negotiated `CapabilityUnavailableReason` the capability /
 *                  liveness surface uses (`agent_offline` / `agent_reconnecting`
 *                  / `consent_required`), or null for op-level errors
 *                  (OS/NOT_FOUND/UNSUPPORTED/STREAM/PROTOCOL) that are not a
 *                  machine-liveness condition;
 *   - `retryable`— whether the caller should re-resolve + retry (DRAINING /
 *                  FENCED / a reconnecting blip);
 *   - `notFound` — ALWAYS the provider-NotFound discriminator value: for
 *                  selfhosted this is true ONLY for an OS-level NOT_FOUND of a
 *                  path/ref (a real "the file does not exist"), and is FALSE for
 *                  AGENT_OFFLINE (the machine isn't recreatable — never let the
 *                  lease cold-create a rival). `isProviderSandboxNotFoundError`
 *                  reads this.
 */
export class SelfhostedControlError extends Error {
  readonly name = "SelfhostedControlError";
  readonly code: ErrorCode;
  readonly reason: SelfhostedUnavailableReason | null;
  readonly retryable: boolean;
  readonly fenced: boolean;
  readonly draining: boolean;
  readonly agentOffline: boolean;
  readonly osNotFound: boolean;
  readonly detail: Record<string, string>;

  constructor(input: {
    message: string;
    code: ErrorCode;
    reason: SelfhostedUnavailableReason | null;
    retryable: boolean;
    fenced?: boolean;
    draining?: boolean;
    agentOffline?: boolean;
    osNotFound?: boolean;
    detail?: Record<string, string>;
  }) {
    super(input.message);
    this.code = input.code;
    this.reason = input.reason;
    this.retryable = input.retryable;
    this.fenced = input.fenced ?? false;
    this.draining = input.draining ?? false;
    this.agentOffline = input.agentOffline ?? false;
    this.osNotFound = input.osNotFound ?? false;
    this.detail = input.detail ?? {};
  }
}

/**
 * Map an `AgentError` (from a `ControlResponse`) to the runtime
 * `SelfhostedControlError`. THE load-bearing mapping (the M3 ruling):
 *   - AGENT_OFFLINE         → reason `agent_offline`, agentOffline=true,
 *                             osNotFound=FALSE (NEVER a provider NotFound).
 *   - TIMEOUT (a transient missed-window / no-responder blip the caller marked
 *                             retryable) → reason `agent_reconnecting`.
 *   - CONSENT_REQUIRED      → reason `consent_required`.
 *   - DRAINING              → no capability reason; retryable (turn pauses + retries).
 *   - FENCED                → no capability reason; retryable (the existing
 *                             epoch-fence retry; the caller re-resolves + retries).
 *   - NOT_FOUND             → an OS-level path/ref NotFound — osNotFound=true (a
 *                             real "file does not exist"), no machine-liveness
 *                             reason. (This is the ONLY NotFound; it is NOT the
 *                             box-gone NotFound that licenses a cold restore.)
 *   - PAYLOAD_TOO_LARGE     → the reply exceeded the transport's max payload;
 *                             non-retryable, with actionable copy (the sizes + a
 *                             redirect-to-file workaround).
 *   - OS / UNSUPPORTED / STREAM / PROTOCOL / UNSPECIFIED → op-level error, no
 *                             reason, non-retryable.
 */
export function agentErrorToControlError(err: AgentError): SelfhostedControlError {
  const message = err.message || `agent error (${err.code})`;
  const detail = err.detail ?? {};
  switch (err.code) {
    case ErrorCode.ERROR_CODE_AGENT_OFFLINE:
      return new SelfhostedControlError({
        message: message || "the enrolled agent is offline",
        code: err.code,
        reason: "agent_offline",
        retryable: false,
        agentOffline: true,
        detail,
      });
    case ErrorCode.ERROR_CODE_TIMEOUT:
      // A timeout is a transient blip: the agent may be reconnecting. The turn
      // pauses-with-timeout then retries against the re-resolved active sandbox.
      return new SelfhostedControlError({
        message: message || "the enrolled agent did not respond in time",
        code: err.code,
        reason: "agent_reconnecting",
        retryable: true,
        detail,
      });
    case ErrorCode.ERROR_CODE_CONSENT_REQUIRED:
      return new SelfhostedControlError({
        message: message || "the op requires consent that has not been granted",
        code: err.code,
        reason: "consent_required",
        retryable: false,
        detail,
      });
    case ErrorCode.ERROR_CODE_DRAINING:
      // A pre-admission backpressure rejection (the machine's bounded host-work
      // pool is full, or it is shutting down): the op NEVER started, so it is safe
      // to retry (SelfhostedSession.call retries it a bounded number of times).
      // Replace the agent's internal "N in flight" phrasing with human-language,
      // actionable copy; call() appends the retry count when it finally surfaces.
      return new SelfhostedControlError({
        message: drainingMessage(0),
        code: err.code,
        reason: null,
        retryable: true,
        draining: true,
        detail,
      });
    case ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE:
      // The op's reply exceeded the control transport's negotiated max payload and
      // could not be published (a huge file read, an unbounded exec dump, a full-res
      // screenshot). Not retryable — the same op reproduces the same oversized reply.
      // Surface the actual sizes + a concrete workaround (write to a file, read in
      // ranges) instead of the raw byte-count message.
      return new SelfhostedControlError({
        message: payloadTooLargeMessage(detail),
        code: err.code,
        reason: null,
        retryable: false,
        detail,
      });
    case ErrorCode.ERROR_CODE_FENCED:
      return new SelfhostedControlError({
        message: message || "a stale op was fenced by the epoch guard; re-resolve and retry",
        code: err.code,
        reason: null,
        retryable: true,
        fenced: true,
        detail,
      });
    case ErrorCode.ERROR_CODE_NOT_FOUND:
      // An OS-level path/ref NotFound — a real "the file/ref does not exist". This
      // is NOT the box-gone NotFound (selfhosted has no box-gone — the machine is
      // not recreatable). osNotFound is surfaced so a fs-layer caller can 404 the
      // path, but isProviderSandboxNotFoundError stays FALSE for selfhosted (see
      // session.ts) — a missing file must never license a cold re-create.
      return new SelfhostedControlError({
        message: message || "the referenced path or ref does not exist",
        code: err.code,
        reason: null,
        retryable: Boolean(err.retryable),
        osNotFound: true,
        detail,
      });
    default:
      // OS / UNSUPPORTED / STREAM / PROTOCOL / UNSPECIFIED — an op-level failure.
      return new SelfhostedControlError({
        message,
        code: err.code,
        reason: null,
        retryable: Boolean(err.retryable),
        detail,
      });
  }
}

// ── Actionable, human-language error copy ─────────────────────────────────────
// These build the messages the model / API caller sees for the failure modes that
// have a concrete workaround. They live here (next to the mapping) so the phrasing
// is single-sourced and unit-testable, and deliberately avoid the wire's internal
// vocabulary ("in flight", "negotiated max payload", raw byte counts alone).

/**
 * PAYLOAD_TOO_LARGE copy: state the actual sizes (from the agent's `detail` map —
 * `encoded_bytes` / `max_payload`) and tell the caller how to get the data anyway:
 * redirect the output to a file and read it back in ranges/chunks.
 */
export function payloadTooLargeMessage(detail: Record<string, string>): string {
  const encoded = detail.encoded_bytes;
  const max = detail.max_payload;
  const sizes =
    encoded && max
      ? `The result was ${encoded} bytes, over the machine link's ${max}-byte per-message limit. `
      : "The result was larger than the machine link can deliver in a single message. ";
  return (
    `${sizes}Redirect the command's output to a file (for example ` +
    "`<command> > /tmp/out.log 2>&1`) and then read that file back in ranges or chunks " +
    "instead of returning it all at once."
  );
}

/**
 * DRAINING copy: the machine is at its concurrent-work capacity. `retries` is the
 * number of times `SelfhostedSession.call` already re-tried before giving up (0 at
 * the mapping layer, the final count when it surfaces after exhausting retries).
 */
export function drainingMessage(retries: number): string {
  const retried =
    retries > 0 ? ` It was retried ${retries} time${retries === 1 ? "" : "s"} first.` : "";
  return (
    "The machine is at its concurrent-work capacity and could not accept this command." +
    retried +
    " Try again shortly, or reduce the number of commands you run in parallel."
  );
}

/** Rebuild a DRAINING error with the final retry count folded into its message —
 *  used by `SelfhostedSession.call` when the bounded DRAINING retries are exhausted. */
export function drainingExhaustedError(
  base: SelfhostedControlError,
  retries: number,
): SelfhostedControlError {
  return new SelfhostedControlError({
    message: drainingMessage(retries),
    code: base.code,
    reason: base.reason,
    retryable: base.retryable,
    draining: base.draining,
    detail: base.detail,
  });
}

/**
 * exec-deadline copy: the command was terminated at the exec time limit. Advise
 * running long jobs in the background and polling their output rather than blocking
 * the turn on one long command. Surfaced on a timed-out exec result's stderr.
 */
export function execDeadlineHint(seconds: number): string {
  return (
    `The command was terminated at the ${seconds}-second execution limit. ` +
    "Run long jobs in the background (for example " +
    "`nohup <command> > /tmp/job.log 2>&1 &`, or start them in a terminal session) " +
    "and poll the output file instead of blocking on a single command."
  );
}

/** Build a synthesized AGENT_OFFLINE `AgentError` — the control plane uses this
 *  when no agent responds on the subject at all. */
export function offlineAgentError(message = "no agent responded (offline)"): AgentError {
  return {
    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    message,
    retryable: false,
    detail: {},
  };
}

/** Build a synthesized TIMEOUT `AgentError` — the control plane uses this when a
 *  responder existed but the request timed out (a transient blip → reconnecting). */
export function timeoutAgentError(message = "the agent did not respond in time"): AgentError {
  return {
    code: ErrorCode.ERROR_CODE_TIMEOUT,
    message,
    retryable: true,
    detail: {},
  };
}

// ── NatsControlRpc — the thin request/reply wrapper (M4 hardens this) ─────────

/**
 * The minimal NATS request/reply surface `NatsControlRpc` needs. It mirrors the
 * `nats` `NatsConnection.request` signature WITHOUT importing `nats` into the
 * agent-loop-free runtime leaf: the API/worker injects the live connection (the
 * SAME `@opengeni/events` bus connection). A factory may return `null` when NATS
 * is not configured (boot must not require a live NATS) — `NatsControlRpc` then
 * surfaces `agent_offline` for every request rather than throwing.
 */
export interface NatsRequestConnection {
  request(
    subject: string,
    payload: Uint8Array,
    opts: { timeout: number },
  ): Promise<{ data: Uint8Array }>;
}

/** A NATS error whose `code` marks "no responder on the subject" (NATS 503). The
 *  selfhosted control plane reads this as `agent_offline`, NEVER a NotFound. */
const NATS_NO_RESPONDERS_CODE = "503";

function isNoRespondersError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code === NATS_NO_RESPONDERS_CODE) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /no responders|503/i.test(message);
}

function isRequestTimeoutError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  // nats.js uses "TIMEOUT" for a request timeout.
  if (typeof code === "string" && /timeout/i.test(code)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out/i.test(message);
}

/**
 * A thin `ControlRpc` over a NATS request/reply connection. Constructed with a
 * LAZY factory: the connection is resolved on first `request` (so boot never
 * requires a live NATS). A null factory result, a no-responder error, or a
 * request timeout each yield a `ControlResponse` carrying a synthesized
 * `AgentError` (AGENT_OFFLINE / TIMEOUT) — NEVER a thrown transport error and
 * NEVER a NotFound.
 *
 * The factory is async and memoized; it may itself dial the bus. M4 replaces the
 * factory's body with the Accounts-scoped, hardened connection — this class's
 * shape does not change.
 */
export class NatsControlRpc implements ControlRpc {
  private readonly connect: () => Promise<NatsRequestConnection | null>;
  private connection: NatsRequestConnection | undefined;
  private connecting: Promise<NatsRequestConnection | null> | undefined;

  constructor(connect: () => Promise<NatsRequestConnection | null>) {
    this.connect = connect;
  }

  private async resolveConnection(): Promise<NatsRequestConnection | null> {
    if (this.connection) {
      return this.connection;
    }
    // Share one in-flight dial across concurrent callers, but cache only a real
    // connection. A transient null/throw must be retried by the next request;
    // pinning null here would make a recovered NATS bus look offline until the
    // API/worker process restarted.
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

  async request(
    subject: string,
    req: ControlRequest,
    opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    const conn = await this.resolveConnection();
    if (!conn) {
      // No NATS configured / not reachable → the agent is unaddressable → offline.
      return offlineControlResponse(req.requestId);
    }
    const payload = ControlRequest.encode(req).finish();
    try {
      const reply = await conn.request(subject, payload, { timeout: opts.timeoutMs });
      return ControlResponse.decode(reply.data);
    } catch (err) {
      // Re-allow a future request to re-dial if the cached conn was torn down.
      if (isNoRespondersError(err)) {
        // No subscriber on the subject at all → the machine is offline.
        return offlineControlResponse(req.requestId);
      }
      if (isRequestTimeoutError(err)) {
        // A responder may exist but the request timed out → a transient blip.
        return timeoutControlResponse(req.requestId);
      }
      // Any other transport error → treat as offline (never a NotFound). The op
      // surfaces agent_offline and the lease never cold-creates a rival.
      this.connection = undefined; // force a re-dial next time
      return offlineControlResponse(req.requestId);
    }
  }
}

/** A `ControlResponse` carrying a synthesized AGENT_OFFLINE error. */
export function offlineControlResponse(requestId: string): ControlResponse {
  return { requestId, error: offlineAgentError(), result: undefined };
}

/** A `ControlResponse` carrying a synthesized TIMEOUT error (→ reconnecting). */
export function timeoutControlResponse(requestId: string): ControlResponse {
  return { requestId, error: timeoutAgentError(), result: undefined };
}
