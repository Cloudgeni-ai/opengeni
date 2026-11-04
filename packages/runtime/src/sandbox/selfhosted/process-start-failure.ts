// A machine agent that cannot start a program reports
// "spawn or apply execution containment for <program>: <OS error>". Agents up
// to 0.1.150 put the first command element there, which for a shell command is
// the whole script, so that text could reach events, tool output and the
// person's failure banner. Everything here is pure string work on that one
// stable marker, so older agents get the same short message as newer ones.

/** The stable marker of a failed process start in an agent error message. */
export const PROCESS_START_FAILURE_MARKER = "spawn or apply execution containment for ";

/** The longest program name kept from an agent's message. */
const PROGRAM_LIMIT = 160;
/** The longest rest of the message kept after a program name. */
const TAIL_LIMIT = 300;

/** A program name: path characters only. Anything else (spaces, quotes,
 * `=`, `;`) is command text an older agent put there, never kept. */
const PROGRAM_TOKEN = new RegExp(`^([A-Za-z0-9._/+@~-]{1,${PROGRAM_LIMIT}})(?=$|\\s\\(|: )`);

/** Linux errnos for exhausted machine resources: EAGAIN, ENOMEM, ENFILE, EMFILE. */
const RESOURCE_ERRNOS: ReadonlySet<number> = new Set([11, 12, 23, 24]);

/** The null-device notes newer agents add before the OS error. */
const NULL_DEVICE_NOTE =
  /\((the null device \/dev\/null is missing|\/dev\/null has been replaced by something other than the null device)\)/;

/** Whether `message` reports that the machine could not start a program. */
export function isProcessStartFailureMessage(message: string): boolean {
  return message.includes(PROCESS_START_FAILURE_MARKER);
}

function programName(rest: string): string | null {
  return PROGRAM_TOKEN.exec(rest)?.[1] ?? null;
}

/**
 * Whether a failed process start says the machine itself cannot start
 * programs, rather than that this one program is missing or not permitted:
 * the agent named a missing or replaced `/dev/null`; an older agent failed to
 * start its shell for a shell command (it reported the script, no program
 * name, as in the 4 Nov incident); or the machine is out of processes,
 * memory or file handles. Only these warrant restarting the machine.
 */
export function isMachineProcessStartFailureMessage(message: string): boolean {
  const at = message.indexOf(PROCESS_START_FAILURE_MARKER);
  if (at < 0) return false;
  const rest = message.slice(at + PROCESS_START_FAILURE_MARKER.length);
  if (NULL_DEVICE_NOTE.test(rest)) return true;
  if (programName(rest) === null) return true;
  const errno = /\(os error (\d+)\)\s*$/.exec(rest)?.[1];
  return errno !== undefined && RESOURCE_ERRNOS.has(Number(errno));
}

/**
 * The same message on one bounded line with nothing from the command but the
 * program's name. A program name keeps the rest of the agent's message (the
 * OS error and its context); anything that is not a plain name (an older
 * agent's shell script) becomes "a shell command" with only the null-device
 * note and the OS error kept. Messages without the marker are unchanged.
 */
export function sanitizeProcessStartFailureMessage(message: string): string {
  const at = message.indexOf(PROCESS_START_FAILURE_MARKER);
  if (at < 0) return message;
  const before = message.slice(0, at).replace(/\s+/g, " ").slice(-200);
  const rest = message.slice(at + PROCESS_START_FAILURE_MARKER.length);
  const program = programName(rest);
  if (program !== null) {
    const tail = rest.slice(program.length).replace(/\s+/g, " ").trimEnd().slice(0, TAIL_LIMIT);
    return `${before}${PROCESS_START_FAILURE_MARKER}${program}${tail}`;
  }
  const note = NULL_DEVICE_NOTE.exec(rest)?.[1];
  const cause = /([^:\n]{1,200}\(os error \d+\))\s*$/.exec(rest)?.[1]?.trim();
  return `${before}${PROCESS_START_FAILURE_MARKER}a shell command${note ? ` (${note})` : ""}${
    cause ? `: ${cause}` : ""
  }`;
}

/** The null-device note in a process-start failure, when the agent named it. */
export function processStartFailureNullDeviceNote(message: string): string | null {
  return NULL_DEVICE_NOTE.exec(message)?.[1] ?? null;
}
