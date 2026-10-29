// The selfhosted CONTROL-PLANE transport seam (the M3/M4 layering boundary).
//
// `ControlRpc` is the ONE seam the `SelfhostedSession` depends on to reach a
// user's enrolled machine: request/reply addressed by the subject
// `agent.<workspaceId>.<agentId>.connection.<instanceId>.rpc`, payloads encoded/decoded via
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
import {
  AGENT_LINK_LOST_HEADER,
  AGENT_UNANSWERED_HEADER,
  AgentLinkLostError,
  ControlConnectionReplacedError,
  ControlReplyRecovery,
  NO_WAKE_HEADER,
  responderWaitExhausted,
} from "./control-replay";
import { errorMessage } from "@opengeni/contracts/values";

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
 * `ControlResponse`. The subject is
 * `subjectFor(workspaceId, agentId, connectionInstanceId)`.
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
    opts: {
      timeoutMs: number;
      /** Whether the agent connection the subject names is still the
       * enrollment's live one. A transport asks it after an attempt fails;
       * false means another agent process holds the connection now, so the
       * transport stops retrying on the subject and answers with a
       * connection-replaced AGENT_OFFLINE. That does not prove the old process
       * exited. Unknown is true. */
      connectionCurrent?: () => Promise<boolean>;
      /** A housekeeping request that must never wake a sleeping sandbox (see
       * `requestWithoutWaking`): one attempt with NO_WAKE_HEADER, no replay,
       * no redelivery and nothing done on "no responders". When the agent
       * does not answer it, the response is an AGENT_OFFLINE error carrying
       * AGENT_UNANSWERED_DETAIL_KEY. */
      noWake?: boolean;
    },
  ): Promise<ControlResponse>;
}

/** The control-plane RPC subject for one exact claimed daemon instance. */
const AGENT_RPC_SUBJECT = /^agent\.([^.]+)\.([^.]+)\.connection\.([^.]+)\.rpc$/u;

/** The exact agent connection an RPC subject from `subjectFor` addresses. */
export function parseAgentRpcSubject(
  subject: string,
): { workspaceId: string; agentId: string; connectionInstanceId: string } | null {
  const match = AGENT_RPC_SUBJECT.exec(subject);
  return match
    ? { workspaceId: match[1]!, agentId: match[2]!, connectionInstanceId: match[3]! }
    : null;
}

export function subjectFor(
  workspaceId: string,
  agentId: string,
  connectionInstanceId: string,
): string {
  if (typeof connectionInstanceId !== "string" || connectionInstanceId.trim().length === 0) {
    throw new Error("Connected Machine RPC requires an exact connection instance");
  }
  return `agent.${workspaceId}.${agentId}.connection.${connectionInstanceId}.rpc`;
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
  /** The reply exceeded the transport's max payload (a distinguishing flag so the
   *  fault renderer can name the size wall + recovery instead of a generic OS error). */
  readonly payloadTooLarge: boolean;
  /** The transport synthesized this fault PRE-SEND — it KNOWS the request never
   *  reached the machine (no connection, or no responder on the subject), so the op
   *  provably did not execute. Only such a fault is safe to re-issue for ANY op kind
   *  (a post-send timeout is ambiguous — at-least-once — and must not be re-sent
   *  unless the op is read-only). Never set for an agent-returned error. */
  readonly neverSent: boolean;
  /** The agent connection the request was sent to was replaced by another
   *  agent process, so the transport stopped waiting on its subject. The old
   *  process may still run what it was running. Only the transport sets it
   *  (with `neverSent` when the request reached no responder). */
  readonly connectionReplaced: boolean;
  /** Exact inner control request that produced this failure. Safe opaque
   * correlation only; never a NATS subject, token, or machine credential. */
  readonly controlRequestId: string | null;
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
    payloadTooLarge?: boolean;
    neverSent?: boolean;
    connectionReplaced?: boolean;
    controlRequestId?: string | null;
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
    this.payloadTooLarge = input.payloadTooLarge ?? false;
    this.neverSent = input.neverSent ?? false;
    this.connectionReplaced = input.connectionReplaced ?? false;
    this.controlRequestId = input.controlRequestId ?? null;
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
export function agentErrorToControlError(
  err: AgentError,
  controlRequestId: string | null = null,
): SelfhostedControlError {
  const message = err.message || `agent error (${err.code})`;
  const detail = err.detail ?? {};
  switch (err.code) {
    case ErrorCode.ERROR_CODE_AGENT_OFFLINE:
      // AGENT_OFFLINE is ONLY ever synthesized by our transport (the agent never
      // sends it). The synthesis marks `neverSent` on the pre-send paths (no NATS
      // connection, or no responder on the subject) — the op provably never reached
      // the machine — via the reserved detail key `NEVER_SENT_DETAIL_KEY`.
      return new SelfhostedControlError({
        message: message || "the enrolled agent is offline",
        code: err.code,
        reason: "agent_offline",
        retryable: false,
        agentOffline: true,
        neverSent: detail[NEVER_SENT_DETAIL_KEY] === "1",
        connectionReplaced: detail[CONNECTION_REPLACED_DETAIL_KEY] === "1",
        controlRequestId,
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
        controlRequestId,
        detail,
      });
    case ErrorCode.ERROR_CODE_CONSENT_REQUIRED:
      return new SelfhostedControlError({
        message: message || "the op requires consent that has not been granted",
        code: err.code,
        reason: "consent_required",
        retryable: false,
        controlRequestId,
        detail,
      });
    case ErrorCode.ERROR_CODE_DRAINING:
      // Pre-admission refusal: the op never started. Preserve the typed cause;
      // an update drain or a breaker is not proof of ordinary capacity exhaustion.
      return new SelfhostedControlError({
        message: drainingMessage(0, detail),
        code: err.code,
        reason: null,
        retryable: true,
        draining: true,
        controlRequestId,
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
        payloadTooLarge: true,
        controlRequestId,
        detail,
      });
    case ErrorCode.ERROR_CODE_FENCED:
      return new SelfhostedControlError({
        message: message || "a stale op was fenced by the epoch guard; re-resolve and retry",
        code: err.code,
        reason: null,
        retryable: true,
        fenced: true,
        controlRequestId,
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
        controlRequestId,
        detail,
      });
    default:
      // OS / UNSUPPORTED / STREAM / PROTOCOL / UNSPECIFIED — an op-level failure.
      return new SelfhostedControlError({
        message,
        code: err.code,
        reason: null,
        retryable: Boolean(err.retryable),
        controlRequestId,
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
  if (detail.direction === "request") {
    return "The request exceeds the machine link's per-message size limit and was not sent. The machine is not offline. Use a supported bounded transfer for large file content.";
  }
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

/** Shared copy for plain errors and structured tool faults; unknown reasons
 * must not be presented as proof of capacity exhaustion. */
export function drainingPresentation(detail: Record<string, string>) {
  if (detail.reason === "agent_update") {
    return {
      headline: "the machine is draining accepted work for a self-update",
      cause: "a verified self-update is waiting for accepted work to finish",
      tryNext: "wait for the self-update to finish, then retry; do not interrupt accepted work",
    };
  }
  if (detail.backpressure === "queue_breaker" || detail.backpressure === "wait_breaker") {
    return {
      headline: `the machine's admission breaker '${detail.backpressure}' tripped`,
      cause: `the '${detail.backpressure}' admission breaker detected a pathological backlog`,
      tryNext:
        "inspect host admission telemetry and the backlog before retrying; this is not ordinary load",
    };
  }
  return {
    headline: "the machine temporarily refused new work at admission",
    cause: "the agent refused new work without a recognized admission reason",
    tryNext: "try again shortly; if it persists, inspect the agent's admission and update state",
  };
}

/** `retries` is zero at mapping and the final count after exhausting retries. */
export function drainingMessage(retries: number, detail: Record<string, string> = {}): string {
  const retried =
    retries > 0 ? ` It was retried ${retries} time${retries === 1 ? "" : "s"} first.` : "";
  const presentation = drainingPresentation(detail);
  return `${presentation.headline}.${retried} ${presentation.tryNext}.`;
}

/** Rebuild a DRAINING error with the final retry count folded into its message —
 *  used by `SelfhostedSession.call` when the bounded DRAINING retries are exhausted. */
export function drainingExhaustedError(
  base: SelfhostedControlError,
  retries: number,
): SelfhostedControlError {
  return new SelfhostedControlError({
    message: drainingMessage(retries, base.detail),
    code: base.code,
    reason: base.reason,
    retryable: base.retryable,
    draining: base.draining,
    controlRequestId: base.controlRequestId,
    // Carry the retry count in `detail` so the fault renderer can state it.
    detail: { ...base.detail, retries: String(retries) },
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

/** The reserved `detail` key the transport sets to "1" when it KNOWS a synthesized
 *  AGENT_OFFLINE fault occurred pre-send (no connection / no responder) — so the op
 *  provably never reached the machine. `agentErrorToControlError` reads it into
 *  `SelfhostedControlError.neverSent`. Reserved (never sent by the agent). */
export const NEVER_SENT_DETAIL_KEY = "_never_sent";

/** The reserved `detail` key the transport sets to "1" when the agent
 *  connection a request was sent to was replaced by a new one.
 *  `agentErrorToControlError` reads it into
 *  `SelfhostedControlError.connectionReplaced`. Reserved (never sent by the agent). */
export const CONNECTION_REPLACED_DETAIL_KEY = "_connection_replaced";

/** The synthesized AGENT_OFFLINE for a request whose agent connection was
 *  replaced. Neutral about why: a restart and a second process taking over
 *  look the same. `neverSent` when it reached no responder. */
export function connectionReplacedAgentError(neverSent: boolean): AgentError {
  return {
    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    message: neverSent
      ? "The machine's agent was replaced before this request reached it, so it did not run."
      : "The machine's agent was replaced while this request was in flight, so its outcome is unknown.",
    retryable: false,
    detail: {
      [CONNECTION_REPLACED_DETAIL_KEY]: "1",
      ...(neverSent ? { [NEVER_SENT_DETAIL_KEY]: "1" } : {}),
    },
  };
}

/** The reserved `detail` key on a command's outcome-unknown error after its
 *  agent connection was replaced: "1" when the agent had accepted the
 *  command's start, "0" when that was never confirmed. Reserved (never sent
 *  by the agent). */
export const START_CONFIRMED_DETAIL_KEY = "_start_confirmed";

/** A command whose agent connection was replaced before its outcome was
 *  known. A new connection does not prove the old agent process is gone, so
 *  the outcome is unknown. Each clause states only what is known: whether the
 *  agent had accepted the start, and whether a stop request has actually been
 *  recorded for it. */
export function commandOutcomeUnknownAfterReplacementAgentError(options: {
  startConfirmed: boolean;
  stopRequested: boolean;
}): AgentError {
  const outcome = options.startConfirmed
    ? "The machine's agent was replaced while this command was running, so its outcome is " +
      "unknown: it may still be running, or it may have finished."
    : "The machine's agent was replaced before this command's outcome was known: it may " +
      "not have started, may still be running, or may have finished.";
  return {
    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    message: options.stopRequested ? `${outcome} A stop has been requested for it.` : outcome,
    retryable: false,
    detail: {
      [CONNECTION_REPLACED_DETAIL_KEY]: "1",
      [START_CONFIRMED_DETAIL_KEY]: options.startConfirmed ? "1" : "0",
    },
  };
}

/** The reserved `detail` key the transport sets to "1" when a no-responder fault
 *  comes after it already waited out its reconnect window for that exact process.
 *  Re-issuing would only wait the same window again. Reserved (never sent by the
 *  agent). */
export const RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY = "_responder_wait_exhausted";

/** Build a synthesized AGENT_OFFLINE `AgentError` — the control plane uses this
 *  when no agent responds on the subject at all. `neverSent` marks that the request
 *  provably never reached the machine (no connection / no responder), which makes it
 *  safe to re-issue for ANY op kind; leave it false for an AMBIGUOUS transport error
 *  (a connection torn mid-request may have delivered the op). */
/** Detail key of the error a no-wake request gets when its agent did not
 * answer it: why ("asleep", "away" or "busy" from a compute host, or
 * "no_responders", "link_lost", "timeout", "offline" or "transport"). The
 * request may still have reached the agent, so it never marks never-sent. */
export const AGENT_UNANSWERED_DETAIL_KEY = "_agent_unanswered";

function notAnsweredControlResponse(requestId: string, reason: string): ControlResponse {
  return {
    requestId,
    error: {
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      message: "the agent did not answer a request that may not wake its sandbox",
      retryable: false,
      detail: {
        [AGENT_UNANSWERED_DETAIL_KEY]: /^[a-z_]{1,32}$/u.test(reason) ? reason : "unanswered",
      },
    },
    result: undefined,
  };
}

/** Why an agent did not answer a no-wake request, or null when it answered.
 * Only a transport synthesizes AGENT_OFFLINE and TIMEOUT, so from a no-wake
 * request either means the agent did not answer. */
export function agentNotAnsweredReason(
  error: Pick<AgentError, "code" | "detail"> | undefined | null,
): string | null {
  if (!error) return null;
  const reason = error.detail?.[AGENT_UNANSWERED_DETAIL_KEY];
  if (reason) return reason;
  if (error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE) return "offline";
  if (error.code === ErrorCode.ERROR_CODE_TIMEOUT) return "timeout";
  return null;
}

/** A control failure of a no-wake request whose agent did not answer it. */
export function isAgentNotAnswered(error: unknown): boolean {
  return error instanceof SelfhostedControlError && agentNotAnsweredReason(error) !== null;
}

/** What a housekeeping request got: the agent's answer, or that the agent did
 * not answer it, and why. Not answered records nothing; the agent's own
 * operation inventory, sent while it is talking, takes over. */
export type NoWakeReply =
  | { answered: true; response: ControlResponse }
  | { answered: false; reason: string };

/**
 * Send one housekeeping request that never wakes a sleeping sandbox. A compute
 * host hands it to the agent only while the sandbox runs and the agent holds
 * the subscription, and otherwise answers it itself as unanswered; a Connected
 * Machine's agent simply receives it. It never asks the control service to
 * wake anything, never replays, and is never retried here.
 */
export async function requestWithoutWaking(
  rpc: ControlRpc,
  subject: string,
  req: ControlRequest,
  opts: { timeoutMs: number },
): Promise<NoWakeReply> {
  const response = await rpc.request(subject, req, { timeoutMs: opts.timeoutMs, noWake: true });
  const reason = agentNotAnsweredReason(response.error);
  return reason === null ? { answered: true, response } : { answered: false, reason };
}

/** The same transport with every request sent as a no-wake housekeeping
 * request (see `requestWithoutWaking`). */
export function withoutWaking(rpc: ControlRpc): ControlRpc {
  return {
    request: async (subject, req, opts) =>
      await rpc.request(subject, req, { ...opts, noWake: true }),
  };
}

export function offlineAgentError(
  message = "no agent responded (offline)",
  neverSent = false,
): AgentError {
  return {
    code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
    message,
    retryable: false,
    detail: neverSent ? { [NEVER_SENT_DETAIL_KEY]: "1" } : {},
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
  /** The transport preserves response headers for wire capability negotiation. */
  supportsHeaders?: boolean;
  request(
    subject: string,
    payload: Uint8Array,
    /** Only safe probes or immutable journaled deliveries may opt into resend.
     * `headers` are request headers of a plain request (no `resendOn`), sent
     * only by a transport that `supportsHeaders`. */
    opts: { timeout: number; resendOn?: string; headers?: Record<string, string> },
  ): Promise<{ data: Uint8Array; headers?: { get(name: string): string } }>;
}

/** A NATS error whose `code` marks "no responder on the subject" (NATS 503). The
 *  selfhosted control plane reads this as `agent_offline`, NEVER a NotFound. */
const NATS_NO_RESPONDERS_CODE = "503";

function natsAuthorizationFailure(error: unknown): SelfhostedControlError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code !== "string" ||
    ![
      "PERMISSIONS_VIOLATION",
      "AUTHORIZATION_VIOLATION",
      "AUTHENTICATION_EXPIRED",
      "BAD_AUTHENTICATION",
    ].includes(code)
  )
    return null;
  return new SelfhostedControlError({
    code: ErrorCode.ERROR_CODE_PROTOCOL,
    message: "Control transport authorization failed.",
    reason: null,
    retryable: false,
    detail: { transport_error_code: code },
  });
}

function isNoRespondersError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code === NATS_NO_RESPONDERS_CODE) {
    return true;
  }
  const message = errorMessage(err);
  return /no responders|503/i.test(message);
}

function isRequestTimeoutError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  // nats.js uses "TIMEOUT" for a request timeout.
  if (typeof code === "string" && /timeout/i.test(code)) {
    return true;
  }
  const message = errorMessage(err);
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
  private readonly recovery: ControlReplyRecovery;
  private readonly connect: () => Promise<NatsRequestConnection | null>;
  private connection: NatsRequestConnection | undefined;
  private connecting: Promise<NatsRequestConnection | null> | undefined;
  private readonly connectionCurrent: ((subject: string) => Promise<boolean>) | undefined;

  constructor(
    connect: () => Promise<NatsRequestConnection | null>,
    options: {
      /** Transient-failure recovery allowance beyond the operation timeout (default two minutes). */
      recoveryMs?: number;
      /** See ControlReplyRecovery: acts on each "no responders" of a replayable
       * request before the same delivery is retried. */
      onNoResponders?: (subject: string) => Promise<boolean>;
      /** The `connectionCurrent` check of a request that brings none. */
      connectionCurrent?: (subject: string) => Promise<boolean>;
    } = {},
  ) {
    this.connect = connect;
    this.recovery = new ControlReplyRecovery(options.recoveryMs, undefined, options.onNoResponders);
    this.connectionCurrent = options.connectionCurrent;
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
      .catch((error) => {
        const denied = natsAuthorizationFailure(error);
        if (denied) throw denied;
        return null;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  async request(
    subject: string,
    req: ControlRequest,
    requestOpts: {
      timeoutMs: number;
      connectionCurrent?: () => Promise<boolean>;
      noWake?: boolean;
    },
  ): Promise<ControlResponse> {
    const fallbackCurrent = this.connectionCurrent;
    const opts = {
      timeoutMs: requestOpts.timeoutMs,
      connectionCurrent:
        requestOpts.connectionCurrent ??
        (fallbackCurrent ? async () => await fallbackCurrent(subject) : undefined),
    };
    const conn = await this.resolveConnection();
    if (requestOpts.noWake) {
      if (!conn) return notAnsweredControlResponse(req.requestId, "offline");
      return await this.requestWithoutWaking(conn, subject, req, requestOpts.timeoutMs);
    }
    if (!conn) {
      // No NATS configured / not reachable → the agent is unaddressable → offline.
      // The request was never published (no connection) → NEVER SENT: safe to re-issue.
      return offlineControlResponse(req.requestId, true);
    }
    const payload = ControlRequest.encode(req).finish();
    let reply: { data: Uint8Array };
    try {
      reply = await this.recovery.request(
        conn,
        subject,
        payload,
        opts.timeoutMs,
        opts.connectionCurrent,
      );
    } catch (err) {
      // The link that carried it ended unanswered: it may have been
      // delivered, so this is the same ambiguous blip as a timeout.
      const lostLink = err instanceof AgentLinkLostError;
      if (err instanceof ControlConnectionReplacedError) {
        return {
          requestId: req.requestId,
          error: connectionReplacedAgentError(err.neverSent),
          result: undefined,
        };
      }
      const denied = natsAuthorizationFailure(err);
      if (denied) throw denied;
      // The client rejects this before publishing. Keep the healthy connection;
      // a request size fault is not evidence that the agent is offline.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "MAX_PAYLOAD_EXCEEDED"
      ) {
        return {
          requestId: req.requestId,
          error: {
            code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
            message: "outbound control request exceeds the transport payload limit",
            retryable: false,
            detail: { direction: "request", encoded_bytes: String(payload.byteLength) },
          },
          result: undefined,
        };
      }
      // Re-allow a future request to re-dial if the cached conn was torn down.
      const noResponders = isNoRespondersError(err);
      // A one-shot attempt (no replay) that failed: say so when its connection
      // was replaced, as the replay retries do.
      if (
        (noResponders || lostLink || isRequestTimeoutError(err)) &&
        opts.connectionCurrent &&
        !(await opts.connectionCurrent().catch(() => true))
      ) {
        return {
          requestId: req.requestId,
          error: connectionReplacedAgentError(noResponders),
          result: undefined,
        };
      }
      if (noResponders) {
        // No subscriber on the subject at all → the request reached no responder and
        // was NOT delivered → NEVER SENT (provably not executed): safe to re-issue.
        const offline = offlineControlResponse(req.requestId, true);
        // The reply recovery already waited its whole window for this process
        // to come back; say so, so callers do not wait it again.
        if (responderWaitExhausted(err) && offline.error) {
          offline.error.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY] = "1";
        }
        return offline;
      }
      if (lostLink || isRequestTimeoutError(err)) {
        // A responder may exist but the request timed out → a transient blip. AMBIGUOUS
        // (the op may have run and only the reply was lost) — never marked never-sent.
        return timeoutControlResponse(req.requestId);
      }
      // Any other transport error → treat as offline (never a NotFound). The op
      // surfaces agent_offline and the lease never cold-creates a rival.
      this.connection = undefined; // force a re-dial next time
      return offlineControlResponse(req.requestId);
    }
    return decodeControlReply(req.requestId, reply.data);
  }

  /** One no-wake attempt: no replay negotiation (its probe is a request too),
   * no redelivery and no "no responders" hook, so nothing here wakes a
   * sandbox or waits for one. */
  private async requestWithoutWaking(
    conn: NatsRequestConnection,
    subject: string,
    req: ControlRequest,
    timeoutMs: number,
  ): Promise<ControlResponse> {
    const payload = ControlRequest.encode(req).finish();
    let reply: { data: Uint8Array; headers?: { get(name: string): string } };
    try {
      reply = await conn.request(subject, payload, {
        timeout: timeoutMs,
        ...(conn.supportsHeaders ? { headers: { [NO_WAKE_HEADER]: "1" } } : {}),
      });
    } catch (err) {
      const denied = natsAuthorizationFailure(err);
      if (denied) throw denied;
      if (isNoRespondersError(err))
        return notAnsweredControlResponse(req.requestId, "no_responders");
      if (isRequestTimeoutError(err)) return notAnsweredControlResponse(req.requestId, "timeout");
      this.connection = undefined; // force a re-dial next time
      return notAnsweredControlResponse(req.requestId, "transport");
    }
    if (reply.data.byteLength === 0) {
      const unanswered = reply.headers?.get(AGENT_UNANSWERED_HEADER);
      if (unanswered) return notAnsweredControlResponse(req.requestId, unanswered);
      if (reply.headers?.get(AGENT_LINK_LOST_HEADER) === "1")
        return notAnsweredControlResponse(req.requestId, "link_lost");
    }
    return decodeControlReply(req.requestId, reply.data);
  }
}

/** A received but malformed response is not evidence of an offline agent.
 * Decoding stays outside the transport catch so corruption cannot become a
 * retryable refresh outage (or license retry of an already-sent operation). */
function decodeControlReply(requestId: string, data: Uint8Array): ControlResponse {
  try {
    return ControlResponse.decode(data);
  } catch {
    return {
      requestId,
      error: {
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        message: "The machine returned a malformed control response.",
        retryable: false,
        detail: {},
      },
      result: undefined,
    };
  }
}

/** A `ControlResponse` carrying a synthesized AGENT_OFFLINE error. `neverSent` marks
 *  a pre-send synthesis (no connection / no responder) — the op provably never
 *  reached the machine, so it is safe to re-issue for any op kind. */
export function offlineControlResponse(requestId: string, neverSent = false): ControlResponse {
  return { requestId, error: offlineAgentError(undefined, neverSent), result: undefined };
}

/** A `ControlResponse` carrying a synthesized TIMEOUT error (→ reconnecting). */
export function timeoutControlResponse(requestId: string): ControlResponse {
  return { requestId, error: timeoutAgentError(), result: undefined };
}
