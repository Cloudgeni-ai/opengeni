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

/** The null-device notes newer agents add before the OS error. */
const NULL_DEVICE_NOTE =
  /\((the null device \/dev\/null is missing|\/dev\/null has been replaced by something other than the null device)\)/;

/** Whether `message` reports that the machine could not start a program. */
export function isProcessStartFailureMessage(message: string): boolean {
  return message.includes(PROCESS_START_FAILURE_MARKER);
}

/**
 * The same message with the started program reduced to a bounded single-line
 * name and nothing else from the command. A shell command (old agents) becomes
 * "a shell command"; the OS error and any null-device note are kept. Messages
 * without the marker are returned unchanged.
 */
export function sanitizeProcessStartFailureMessage(message: string): string {
  const at = message.indexOf(PROCESS_START_FAILURE_MARKER);
  if (at < 0) return message;
  const before = message.slice(0, at).replace(/\s+/g, " ").slice(-200);
  const rest = message.slice(at + PROCESS_START_FAILURE_MARKER.length);
  const program = new RegExp(`^([^\\s()]{1,${PROGRAM_LIMIT}})(?=$|\\s\\(|: )`).exec(rest)?.[1];
  const note = NULL_DEVICE_NOTE.exec(rest)?.[1];
  const cause = /([^:\n]{1,200}\(os error \d+\))\s*$/.exec(rest)?.[1]?.trim();
  return `${before}${PROCESS_START_FAILURE_MARKER}${program ?? "a shell command"}${
    note ? ` (${note})` : ""
  }${cause ? `: ${cause}` : ""}`;
}

/** The null-device note in a process-start failure, when the agent named it. */
export function processStartFailureNullDeviceNote(message: string): string | null {
  return NULL_DEVICE_NOTE.exec(message)?.[1] ?? null;
}
