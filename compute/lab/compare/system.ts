/**
 * One interface over every sandbox system the benchmark drives. Every timed
 * call takes `started`, a `performance.now()` value, and reports its times
 * from it, so the open-loop runner can time from an arrival's schedule.
 */

/** How a create gets its sandbox. */
export type CreateKind = "cold" | "template" | "pool";

export interface Sandbox {
  /** The system's own name for it. */
  readonly id: string;
}

/** One command run inside a sandbox. */
export interface RunResult {
  /** Milliseconds from `started` to the first byte of output. */
  firstByteMs: number;
  /** Milliseconds from `started` to the command's exit status. */
  doneMs: number;
  output: string;
  status: number;
  /** System-specific phases in milliseconds, such as the host's wake. */
  phases: Record<string, number>;
}

export interface System<S extends Sandbox = Sandbox> {
  readonly name: string;
  /** Resting states an existing sandbox can be put in, shallowest first. */
  readonly restLevels: readonly string[];
  /** Creates a sandbox and runs `script` in it as its first command. */
  create(kind: CreateKind, script: string, started: number): Promise<{ sandbox: S; run: RunResult }>;
  /** Runs `script`, bringing the sandbox back from rest first. */
  run(sandbox: S, script: string, started: number): Promise<RunResult>;
  /** Puts the sandbox at `level` and returns once it is there. */
  rest(sandbox: S, level: string): Promise<void>;
  remove(sandbox: S): Promise<void>;
  /** Ids of the sandboxes the system holds now. */
  list(): Promise<string[]>;
  /** Versions, flags and machine facts, recorded with every result. */
  describe(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Thrown when a command's output is not what the benchmark expected. */
export class WrongOutputError extends Error {}

/**
 * Quotes `text` for a POSIX shell: inside single quotes only the quote
 * itself needs care.
 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Where the state check keeps its file inside every sandbox. */
export const STATE_FILE = "/tmp/compare-state";

/** The script that writes the state check's token before a sandbox rests. */
export function writeStateScript(token: string): string {
  return `printf %s ${shellQuote(token)} > ${STATE_FILE} && sync`;
}

/** The Python program an activation runs to read the token back. */
export const READ_STATE_SCRIPT = `python3 -c 'print(open("${STATE_FILE}").read())'`;
