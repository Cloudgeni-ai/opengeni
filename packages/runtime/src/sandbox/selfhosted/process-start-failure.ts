// A machine agent that cannot start a program reports
// "spawn or apply execution containment for program "<program>": <OS error>",
// with a note before the OS error when it had to open a missing /dev/null by
// path, or (0.1.153 and later) when no shell is left to start. Agents up to
// 0.1.151 wrote the first command element there,
// unquoted, which for a shell command is the whole script, so that text could
// reach events, tool output and the person's failure banner. Everything here is
// pure string work on that one stable marker, so older agents get the same
// short message as newer ones.

/** The stable marker of a failed process start in an agent error message. */
export const PROCESS_START_FAILURE_MARKER = "spawn or apply execution containment for ";

/** The longest program name kept from an agent's message. */
const PROGRAM_LIMIT = 160;
/** The longest rest of a newer agent's message kept after the program. */
const TAIL_LIMIT = 300;
/** The longest OS error kept from an older agent's message. */
const CAUSE_LIMIT = 200;

/** The note an agent adds when neither `/bin/sh` nor a dash or bash
 * fallback can be started. A restart does not bring a shell back. */
export const MISSING_SHELL_NOTE = "the shell /bin/sh is missing and no dash or bash was found";

/** The notes newer agents add before the OS error when the machine itself
 * cannot start programs: a missing `/dev/null`, or no shell at all. */
const MACHINE_NOTE_TEXTS = ["the null device /dev/null is missing", MISSING_SHELL_NOTE] as const;
const MACHINE_NOTE_ALTERNATIVES = MACHINE_NOTE_TEXTS.map((note) =>
  note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");
const MACHINE_NOTE = new RegExp(`\\((${MACHINE_NOTE_ALTERNATIVES})\\)`);

/** A newer agent's quoted program: `program "<name>"`, then the end, `: <OS
 * error>`, or exactly one machine note. The agent never puts `"` or a
 * line break in the name and bounds it; any length is still read as a name
 * and cut when kept. */
const QUOTED_PROGRAM = new RegExp(
  `^program "([^"\\n]*)"(?=$|: | \\((?:${MACHINE_NOTE_ALTERNATIVES})\\)(?:$|: ))`,
);

/** What an agent puts before the marker ("not found: ") and wrappers add
 * ("Failed to run function tools: SelfhostedControlError: "): words and
 * colons only. Anything else is dropped, so no command text survives there. */
const PLAIN_PREFIX = /^[A-Za-z0-9 _.:-]*$/;

/** The OS error a missing program, shell or `/dev/null` gives (ENOENT). */
const NOT_FOUND_CAUSE = /\(os error 2\)$/;

/** An older agent's unquoted program name: path characters only, then the
 * end or `: <OS error>`. Anything else (spaces, quotes, `=`, `;`, `(`) is
 * command text an older agent put there and is never kept. */
const LEGACY_PROGRAM = new RegExp(`^([A-Za-z0-9._/+@~-]{1,${PROGRAM_LIMIT}})(?=$|: )`);

/** A Windows path, which has backslashes and may have spaces but is a name. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/** Whitespace or shell syntax: what an older agent reported for a script. */
const SHELL_TEXT = /[\s'"`$;&|<>(){}*?!#=\\]/;
/** Shell syntax an agent's own note and OS error never hold. */
const SHELL_SYNTAX = /['"`$;&|<>{}=]/;

/** Whether `message` reports that the machine could not start a program. */
export function isProcessStartFailureMessage(message: string): boolean {
  return message.includes(PROCESS_START_FAILURE_MARKER);
}

type ParsedStart =
  | { kind: "quoted"; program: string; tail: string }
  | { kind: "legacy-program"; program: string; tail: string }
  | { kind: "legacy-text"; reported: string; tail: string };

function parse(rest: string): ParsedStart {
  const quoted = QUOTED_PROGRAM.exec(rest);
  if (quoted) {
    const program = quoted[1] ?? "";
    return {
      kind: "quoted",
      program: program.length > PROGRAM_LIMIT ? `${program.slice(0, PROGRAM_LIMIT)}…` : program,
      tail: rest.slice(quoted[0].length),
    };
  }
  const legacy = LEGACY_PROGRAM.exec(rest)?.[1];
  if (legacy) {
    return { kind: "legacy-program", program: legacy, tail: rest.slice(legacy.length) };
  }
  // An older agent appended ": <OS error>" after whatever it reported, so the
  // last ": " separates the two.
  const at = rest.lastIndexOf(": ");
  return {
    kind: "legacy-text",
    reported: at < 0 ? rest : rest.slice(0, at),
    tail: at < 0 ? "" : rest.slice(at),
  };
}

/** The final `: <OS error> (os error N)` of an older agent's message, on one
 * bounded line. Nothing else is kept: an older agent's text before it (or
 * without it, as in an error's context) can be command text. */
function legacyCause(tail: string): string | null {
  const line = tail.replace(/\s+/g, " ").trimEnd();
  return new RegExp(`: ([^:]{1,${CAUSE_LIMIT}}\\(os error \\d+\\))$`).exec(line)?.[1] ?? null;
}

function restAfterMarker(message: string): string | null {
  const at = message.indexOf(PROCESS_START_FAILURE_MARKER);
  return at < 0 ? null : message.slice(at + PROCESS_START_FAILURE_MARKER.length);
}

/**
 * Whether a failed process start says the machine itself cannot start
 * programs, rather than that this one program is missing, not permitted or
 * short of resources: a newer agent named a missing `/dev/null` or a missing
 * shell, or an older agent failed to start its shell for a shell command (it
 * reported the script, as in the 4 Nov incident). Only these warrant
 * restarting the machine; brief memory or process pressure never does,
 * because several sessions can share one machine.
 */
export function isMachineProcessStartFailureMessage(message: string): boolean {
  const rest = restAfterMarker(message);
  if (rest === null) return false;
  const parsed = parse(rest);
  switch (parsed.kind) {
    case "quoted":
      return MACHINE_NOTE.test(parsed.tail);
    case "legacy-program":
      return false;
    case "legacy-text": {
      // An older agent's shell that would not start for a shell command: it
      // reported the script and ENOENT, as in the 4 Nov incident. Memory,
      // process or permission errors (EAGAIN, ENOMEM, EACCES) never count.
      const reported = parsed.reported.trim();
      const cause = legacyCause(parsed.tail);
      return (
        cause !== null &&
        NOT_FOUND_CAUSE.test(cause) &&
        !WINDOWS_PATH.test(reported) &&
        SHELL_TEXT.test(reported)
      );
    }
  }
}

/**
 * The same message on one bounded line with nothing from the command but the
 * program's name. A newer agent's quoted program keeps the rest of its message
 * (the note, the OS error and its context). From an older agent only a plain
 * program name and the final OS error are kept; anything else it reported (a
 * shell script) becomes "a shell command". Messages without the marker are
 * unchanged.
 */
export function sanitizeProcessStartFailureMessage(message: string): string {
  const at = message.indexOf(PROCESS_START_FAILURE_MARKER);
  if (at < 0) return message;
  const prefix = message.slice(0, at).replace(/\s+/g, " ").slice(-200);
  const before = PLAIN_PREFIX.test(prefix) ? prefix : "";
  const rest = message.slice(at + PROCESS_START_FAILURE_MARKER.length);
  const parsed = parse(rest);
  if (parsed.kind === "quoted") {
    const tail = parsed.tail.replace(/\s+/g, " ").trimEnd().slice(0, TAIL_LIMIT);
    // A newer agent's tail is its note and OS error, never shell syntax; one
    // that has it is reduced to the final OS error, as for older agents.
    let kept = tail;
    if (SHELL_SYNTAX.test(tail)) {
      const note = MACHINE_NOTE.exec(tail)?.[0];
      const cause = legacyCause(tail);
      kept = `${note ? ` ${note}` : ""}${cause ? `: ${cause}` : ""}`;
    }
    return `${before}${PROCESS_START_FAILURE_MARKER}program "${parsed.program}"${kept}`;
  }
  const name = parsed.kind === "legacy-program" ? parsed.program : "a shell command";
  const cause = legacyCause(parsed.tail);
  return `${before}${PROCESS_START_FAILURE_MARKER}${name}${cause ? `: ${cause}` : ""}`;
}

/** The note in a process-start failure that names what the machine is
 * missing (`/dev/null`, or every shell), when the agent named it. */
export function processStartFailureMachineNote(message: string): string | null {
  const rest = restAfterMarker(message);
  if (rest === null) return null;
  const parsed = parse(rest);
  return parsed.kind === "quoted" ? (MACHINE_NOTE.exec(parsed.tail)?.[1] ?? null) : null;
}
