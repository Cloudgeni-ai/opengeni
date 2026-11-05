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
import {
  COMPUTE_WAKE_TIMEOUT_SECONDS_DETAIL_KEY,
  drainingPresentation,
  SelfhostedControlError,
  START_CONFIRMED_DETAIL_KEY,
} from "./control-rpc";
import { MISSING_SHELL_NOTE, processStartFailureMachineNote } from "./process-start-failure";

/**
 * A stable, low-cardinality fault-class string for a `SelfhostedControlError` — the
 * out-of-band twin of the in-band renderer's class taxonomy (single-sourced here).
 * Used for the `machine.op.*` event class + the metrics label + the infra filter.
 */
export function selfhostedFaultClass(error: SelfhostedControlError): string {
  if (error.agentOffline || error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE) return "offline";
  if (error.draining) return "draining";
  if (error.payloadTooLarge || error.code === ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE)
    return "payload_too_large";
  if (error.reason === "agent_reconnecting") return "reconnecting";
  if (error.reason === "consent_required") return "consent";
  if (error.processStartFailed) return "process_start";
  if (error.osNotFound || error.code === ErrorCode.ERROR_CODE_NOT_FOUND) return "not_found";
  if (error.fenced || error.code === ErrorCode.ERROR_CODE_FENCED) return "fenced";
  switch (error.code) {
    case ErrorCode.ERROR_CODE_OS:
      return "os";
    case ErrorCode.ERROR_CODE_STREAM:
      return "stream";
    case ErrorCode.ERROR_CODE_PROTOCOL:
      return "protocol";
    default:
      return "unspecified";
  }
}

/**
 * The fault classes that count as an INFRASTRUCTURE fault (a `machine.op.failed`
 * event). A semantic miss the model asked about — a missing path (`not_found`), a
 * consent gate (`consent`), a nonzero exit (never a fault at all) — is an OUTCOME,
 * not an infra fault, and is DELIBERATELY excluded; `fenced` is a routing/session
 * condition, not a machine fault. (Doctrine two-planes / the team ruling.)
 */
export const SELFHOSTED_INFRASTRUCTURE_FAULT_CLASSES: ReadonlySet<string> = new Set([
  "offline",
  "draining",
  "payload_too_large",
  "reconnecting",
  "process_start",
  "os",
  "stream",
  "protocol",
]);

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

/** Where the faulted command ran, when the caller knows it. */
export interface SelfhostedFaultContext {
  /** The command ran on a Connected Machine (the person's own computer), not
   *  a compute box. Only then can the copy point at the Opengeni app there. */
  connectedMachine?: boolean;
  /** The command ran on the chat's own workspace machine (a compute box), which
   *  speaks the same agent protocol but restarts on its own. Its faults are
   *  named for it instead of for a Connected Machine. */
  workspaceMachine?: boolean;
}

/** The context of a routed backend kind: `selfhosted` is a Connected Machine,
 *  `compute` is the chat's workspace machine; anything else (or unknown) is
 *  neither and keeps the generic copy. */
export function selfhostedFaultContext(kind: string | undefined): SelfhostedFaultContext {
  return { connectedMachine: kind === "selfhosted", workspaceMachine: kind === "compute" };
}

const CONNECTED_MACHINE_PREFIX = "[connected machine] ";
const WORKSPACE_MACHINE_PREFIX = "[workspace machine] ";

/** What the person is told when their machine went offline mid-command. The
 *  code cannot know what stopped the agent (a command, sleep, a lost
 *  network), only that the machine stopped answering while the command ran,
 *  so the copy says the command "may have" stopped it. */
export const CONNECTED_MACHINE_OFFLINE_DURING_COMMAND_NOTICE =
  "Your machine went offline while running a command that may have stopped the Opengeni agent. " +
  "It restarts automatically; if it doesn't come back, open the Opengeni app on that machine (or reinstall).";

/** What the person is told when the agent came back on a new connection
 *  mid-command: the machine is answering again, so it is not "offline". */
export const CONNECTED_MACHINE_AGENT_RECONNECTED_DURING_COMMAND_NOTICE =
  "The Opengeni agent on your machine reconnected during a command that may have stopped it. It's back now.";

/** Assemble the four-field block. The typed wire code is folded into "what
 *  happened" so the model has both the plain language and the precise code. */
function assemble(error: SelfhostedControlError, f: FaultFields): string {
  const code = errorCodeToJSON(error.code);
  return [
    `${CONNECTED_MACHINE_PREFIX}${f.headline}`,
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
export function renderSelfhostedFault(
  error: SelfhostedControlError,
  context: SelfhostedFaultContext = {},
): string {
  if (!context.workspaceMachine) return renderConnectedMachineFault(error, context);
  if (error.agentOffline || error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE) {
    // The box did not come back while waking, before anything was sent.
    const wakeSeconds = error.detail[COMPUTE_WAKE_TIMEOUT_SECONDS_DETAIL_KEY];
    if (wakeSeconds) {
      return onWorkspaceMachine(
        assemble(error, {
          headline: "this chat's workspace machine did not come back",
          happened: `this chat's workspace machine did not answer within ${wakeSeconds}s of being woken`,
          layer: "the workspace machine itself, not your command",
          preserved: "nothing ran; the command was never sent.",
          tryNext:
            "retry once; if it still does not answer, stop and tell the person the workspace machine is not starting.",
        }),
      );
    }
    // A workspace machine that stops answering is most likely restarting (its
    // agent or the whole box) and comes back on its own within seconds; it is
    // not "offline" the way a person's own computer can be.
    return onWorkspaceMachine(
      assemble(error, {
        headline: "this chat's workspace machine stopped answering; it is most likely restarting",
        happened:
          "this chat's workspace machine did not answer, most likely because it is restarting",
        layer: "the workspace machine itself, not your command",
        preserved: error.neverSent
          ? "nothing ran; the command never reached the workspace machine."
          : "unknown — the command was in flight when the workspace machine stopped answering, so it may not have run, or may have run fully or partly.",
        tryNext: error.neverSent
          ? "retry the command; the workspace machine is usually back within seconds."
          : "once the workspace machine is back (usually within seconds), check whether a command that changes state took effect, fully or partly, before re-running it; programs started earlier may have stopped.",
      }),
    );
  }
  return onWorkspaceMachine(renderConnectedMachineFault(error, {}));
}

/** The same four fields, named for the chat's workspace machine. */
function onWorkspaceMachine(rendered: string): string {
  return rendered.startsWith(CONNECTED_MACHINE_PREFIX)
    ? `${WORKSPACE_MACHINE_PREFIX}${rendered.slice(CONNECTED_MACHINE_PREFIX.length)}`
    : rendered;
}

function renderConnectedMachineFault(
  error: SelfhostedControlError,
  context: SelfhostedFaultContext,
): string {
  const detail = error.detail;

  if (error.code === ErrorCode.ERROR_CODE_PROTOCOL && detail.outcome_unknown === "true") {
    return assemble(error, {
      headline: "the machine could not recover this delivery's outcome",
      happened: error.message,
      layer: "the machine link's control delivery journal — not the command itself",
      preserved: "unknown — an earlier delivery may have executed or may still be running.",
      tryNext:
        "inspect the command or its effects before retrying; do not repeat a state-changing operation blindly.",
    });
  }

  if (error.payloadTooLarge || error.code === ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE) {
    if (detail.direction === "request") {
      return assemble(error, {
        headline: "the request was too large to send",
        happened: "the request was not sent because it exceeded the per-message size limit",
        layer: "the machine link's outbound request size limit, not machine availability",
        preserved: "the rejected request did not execute on the machine",
        tryNext: "use a supported bounded transfer; retrying the unchanged request will not help",
      });
    }
    // The STREAMING retention-ceiling overflow (op-stream OP_OVERFLOW) is a
    // different truth than the legacy reply-size wall: the machine STOPPED the
    // command at the ceiling (it did not run to completion), and none of its
    // output was returned. Same correct next action, honest distinct fields.
    if (detail.failure_code === "OP_OVERFLOW") {
      const retained = detail.retained_bytes
        ? `after retaining ${detail.retained_bytes} bytes of output`
        : "when its output exceeded what the machine can retain for delivery";
      return assemble(error, {
        headline: "the command produced more output than the machine link can deliver",
        happened: `the machine stopped the command ${retained} — its output-retention ceiling was reached`,
        layer:
          "the machine link's output-retention ceiling — the command was terminated at the ceiling, not by its own logic",
        preserved:
          "no output was returned, and the command did NOT run to completion — any side effects up to the stop point may have applied.",
        tryNext:
          "re-run with the output bounded: redirect to a file (`> /tmp/out.log 2>&1`) then read it " +
          "back in ranges/chunks, or slice it with `head -c` / `tail -c` / `head` / `tail`.",
      });
    }
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
    const presentation = drainingPresentation(detail);
    return assemble(error, {
      headline: presentation.headline,
      happened: `the machine rejected this command at its admission gate${retried} because ${presentation.cause}`,
      layer: "the machine's host-work admission — not the command's execution",
      preserved: "nothing ran; the command was rejected before it started.",
      tryNext: presentation.tryNext,
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
    if (context.connectedMachine && !error.neverSent) {
      return renderConnectedMachineOfflineDuringCommand(error);
    }
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

  if (error.processStartFailed) {
    const note = processStartFailureMachineNote(error.message);
    return assemble(error, {
      headline: "the machine could not start the program",
      happened: `the machine could not start a process: ${error.message}`,
      layer: "the machine's operating system — not your command",
      preserved: "nothing ran; the command never started.",
      tryNext:
        note === MISSING_SHELL_NOTE
          ? `${note}, so the machine cannot start programs, and a restart does not bring the shell back. Stop running commands and tell the person: a connected machine needs /bin/sh put back; for a workspace machine, a new chat gets a fresh one.`
          : `${
              note ? `${note}, so the machine` : "the machine likely"
            } cannot start programs. Stop running commands and tell the person the machine needs a restart: a connected machine by restarting it; for a workspace machine, retrying may restart it, and a new chat gets a fresh one.`,
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

/**
 * A Connected Machine that stopped answering, or whose agent came back on a
 * new connection, after the command may have reached it. A command can stop
 * the agent (`pkill -f opengeni`, deleting its files), so the copy says so and
 * hands the model the sentence to tell the person, instead of a bare
 * "unreachable … not your command".
 */
function renderConnectedMachineOfflineDuringCommand(error: SelfhostedControlError): string {
  const avoid =
    "check whether the command took effect before re-running it, and don't re-run a command that stops or deletes the Opengeni agent";
  if (error.connectionReplaced) {
    const startUnconfirmed = error.detail[START_CONFIRMED_DETAIL_KEY] === "0";
    return assemble(error, {
      headline: startUnconfirmed
        ? "the machine's Opengeni agent reconnected before this command's outcome was known"
        : "the machine's Opengeni agent reconnected while running this command",
      happened: error.message.replace(/\.$/, ""),
      layer: "the Opengeni agent on the machine, or its connection",
      preserved: startUnconfirmed
        ? "unknown — the command may not have started, may still be running, may have finished, or may have stopped with the agent."
        : "unknown — the command may still be running, may have finished, or may have stopped with the agent.",
      tryNext: `the agent is connected again; ${avoid}. Tell the person: "${CONNECTED_MACHINE_AGENT_RECONNECTED_DURING_COMMAND_NOTICE}"`,
    });
  }
  return assemble(error, {
    headline: "the machine went offline while running this command",
    happened:
      "the machine stopped answering while this command was running; it may have gone to sleep or lost its network, or the command may have stopped the Opengeni agent",
    layer: "the machine or its Opengeni agent",
    preserved: "unknown — the command may have run partly, fully or not at all.",
    tryNext: `once the machine is on and connected again, ${avoid}. Tell the person: "${CONNECTED_MACHINE_OFFLINE_DURING_COMMAND_NOTICE}"`,
  });
}
