// The in-band fault renderer for Connected Machine (selfhosted) control faults.
//
// The failure-visibility doctrine: every fault the model sees at the point of
// impact must carry FOUR fields — what happened, which layer, what was preserved,
// what to try — with a retry verdict that is actually correct for the fault class.
//
// Why this exists: a thrown `SelfhostedControlError` reaches the model already
// wrapped by the SDK's generic tool-error function as
// "An error occurred while running the tool. Please try again. Error: …". That
// "Please try again" is actively wrong for a machine that is offline, a consent
// that has not been granted, or a reply that was too large — the model retries a
// fault that a retry cannot fix, and must parse prose to recover which layer
// failed. The typed `SelfhostedControlError` flags carry the truth; this renders
// them into the four structural fields so the capability tools can surface a
// legible fault as their result instead of the misleading wrapper.

import { errorCodeToJSON, ErrorCode } from "@opengeni/agent-proto";
import { SelfhostedControlError } from "./control-rpc";

/** The four mandatory field labels (exported so tests can assert their presence). */
export const FAULT_FIELD_WHAT_HAPPENED = "What happened:";
export const FAULT_FIELD_WHICH_LAYER = "Which layer:";
export const FAULT_FIELD_WHAT_PRESERVED = "What was preserved:";
export const FAULT_FIELD_WHAT_TO_TRY = "What to try:";

interface FaultFields {
  headline: string;
  happened: string;
  layer: string;
  preserved: string;
  tryNext: string;
}

/** Assemble the four-field block. The typed wire code is folded into "what
 *  happened" so the model has both the plain language and the precise code. */
function assemble(error: SelfhostedControlError, f: FaultFields): string {
  const code = errorCodeToJSON(error.code);
  return [
    `[connected machine] ${f.headline}`,
    `${FAULT_FIELD_WHAT_HAPPENED} ${f.happened} (control code ${code}).`,
    `${FAULT_FIELD_WHICH_LAYER} ${f.layer}`,
    `${FAULT_FIELD_WHAT_PRESERVED} ${f.preserved}`,
    `${FAULT_FIELD_WHAT_TO_TRY} ${f.tryNext}`,
  ].join("\n");
}

/**
 * Render a `SelfhostedControlError` into the doctrine's four in-band fields with a
 * correct retry verdict. The fault CLASS is read from the typed flags (never the
 * message prose), so each class gets the right "which layer" and "what to try":
 *
 *  - PAYLOAD_TOO_LARGE → the command ran but its reply was too big to return; the
 *    fix is to bound the output, not to retry.
 *  - DRAINING → pre-admission backpressure; nothing ran; safe to retry shortly.
 *  - CONSENT_REQUIRED → a machine-side consent gate; retrying cannot help.
 *  - AGENT_OFFLINE → the machine link is down. If the transport KNOWS the request
 *    never left (`neverSent`), nothing ran; otherwise the effect is ambiguous and
 *    the model must check before re-running. Either way "try again" is wrong until
 *    the machine reconnects.
 *  - agent_reconnecting (TIMEOUT) → a transient link blip AFTER send: ambiguous, so
 *    a state-changing command must be checked before re-running (at-least-once).
 *  - NOT_FOUND → a command/filesystem miss, not a link fault.
 *  - FENCED → the active machine session changed (a swap); re-run.
 *  - default (OS/UNSUPPORTED/STREAM/PROTOCOL) → the command/op failed on the machine.
 */
export function renderSelfhostedFault(error: SelfhostedControlError): string {
  const detail = error.detail;

  if (error.payloadTooLarge || error.code === ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE) {
    const sizes =
      detail.encoded_bytes && detail.max_payload
        ? `its ${detail.encoded_bytes}-byte reply exceeded the machine link's ${detail.max_payload}-byte per-message limit`
        : "its reply was larger than the machine link can deliver in one message";
    return assemble(error, {
      headline: "the command's output was too large to return",
      happened: `the command ran on the machine, but ${sizes}`,
      layer: "the machine link's per-message size limit — the command itself executed",
      preserved: "nothing was returned; the oversized reply was dropped whole.",
      tryNext:
        "re-run with the output bounded: redirect to a file (`> /tmp/out.log 2>&1`) then read it " +
        "back in ranges/chunks, or slice it with `head -c` / `tail -c` / `head` / `tail`.",
    });
  }

  if (error.draining) {
    const retried = detail.retries ? ` after ${detail.retries} retries` : "";
    return assemble(error, {
      headline: "the machine is at its concurrent-work capacity",
      happened: `the machine rejected this command at its admission gate${retried} because its work pool is full`,
      layer: "the machine's host-work admission — the machine is online, just saturated",
      preserved: "nothing ran; the command was rejected before it started.",
      tryNext: "try again shortly, or reduce the number of commands you run in parallel.",
    });
  }

  if (error.reason === "consent_required") {
    return assemble(error, {
      headline: "the operation needs consent that has not been granted",
      happened: "the machine rejected the operation because the required consent is not granted",
      layer: "the machine's consent gate — not your command",
      preserved: "nothing ran; the operation was rejected.",
      tryNext:
        "the consent must be granted on the machine itself; retrying will keep failing until it is.",
    });
  }

  if (error.agentOffline || error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE) {
    const preserved = error.neverSent
      ? "nothing ran; the command never reached the machine."
      : "unknown — the link dropped and the command may or may not have run.";
    const tryNext = error.neverSent
      ? "the machine appears offline; check that it is powered on and connected. Retrying will not help until it reconnects."
      : "check the machine, and check whether the command already took effect before re-running it.";
    return assemble(error, {
      headline: "the machine is unreachable",
      happened: "the enrolled machine did not respond; it appears offline",
      layer: "the machine link — the machine itself, not your command",
      preserved,
      tryNext,
    });
  }

  if (error.reason === "agent_reconnecting") {
    return assemble(error, {
      headline: "the machine link blipped",
      happened: "the machine did not respond in time; the link may be reconnecting",
      layer: "the machine link (transport) — not your command",
      preserved: "unknown — the command may or may not have run (its reply was lost).",
      tryNext:
        "wait a moment and try again; if this was a state-changing command, check whether it " +
        "already took effect before re-running it.",
    });
  }

  if (error.osNotFound || error.code === ErrorCode.ERROR_CODE_NOT_FOUND) {
    return assemble(error, {
      headline: "the path or reference was not found on the machine",
      happened: `the machine reported: ${error.message}`,
      layer: "the command / filesystem on the machine — not the machine link",
      preserved: "not applicable; the operation did not apply.",
      tryNext: "check the path or reference exists on the machine, then re-run.",
    });
  }

  if (error.fenced || error.code === ErrorCode.ERROR_CODE_FENCED) {
    return assemble(error, {
      headline: "the active machine session changed",
      happened: "the machine session was swapped underneath the command",
      layer: "the session-routing layer — not your command",
      preserved: "nothing ran on this session.",
      tryNext: "re-run the command; it will target the machine's current session.",
    });
  }

  // OS / UNSUPPORTED / STREAM / PROTOCOL / UNSPECIFIED — a command/op-level failure.
  return assemble(error, {
    headline: "the command failed on the machine",
    happened: `the machine reported: ${error.message}`,
    layer: "the command / operating system on the machine",
    preserved: "not applicable; the command did not complete successfully.",
    tryNext: "read the message above and adjust the command; a blind retry is unlikely to help.",
  });
}
