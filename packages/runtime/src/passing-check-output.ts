/**
 * Long output of a passing test or build (OPENGENI_EXPERIMENT_TOOL_EFFICIENCY).
 *
 * A test run or build that exited 0 usually matters for its first lines (what
 * ran) and its last lines (the summary); the middle is mostly one line per
 * passing test or compiled unit, and it stays in context for every later
 * request. Such output over {@link PASSING_CHECK_TRIM_MIN_BYTES} is shown as
 * its head and tail, and the whole output is stored like any oversized
 * result, with the exact `tool_result_read` call that reads the rest. Lines
 * in the hidden part that report a warning, an error, a failure or a skip are
 * listed in the view, so nothing that signals a problem is hidden. A command
 * that failed, or one that is not a recognised test or build command, is
 * never trimmed.
 */

/** Output at or below this many bytes is always shown whole (about 1,000 tokens). */
export const PASSING_CHECK_TRIM_MIN_BYTES = 4_000;
/** Bytes of head and of tail a trimmed view keeps (about 250 tokens each). */
export const PASSING_CHECK_EDGE_BYTES = 1_000;
/** At most this many flagged lines from the hidden part are listed. */
const MAX_FLAGGED_LINES = 20;
const MAX_FLAGGED_LINE_CHARS = 300;

const TEST_COMMAND =
  /\b(?:pytest|py\.test|unittest|tox|nox|go test|cargo test|cargo nextest|npm (?:test|run test)|yarn test|pnpm test|jest|vitest|mocha|ctest|gradle test|mvn test|dotnet test|rspec|phpunit|mix test|swift test|zig test|bun test|deno test|make test|make check|python3? -m pytest)\b/;
const BUILD_COMMAND =
  /\b(?:go build|go vet|cargo (?:build|check|clippy)|tsc|npm run build|yarn build|pnpm build|make|cmake|gcc|g\+\+|clang|javac|mvn (?:compile|package|verify)|gradle build|dotnet build|swift build|zig build)\b/;
const FLAGGED_LINE =
  /\b(?:warn(?:ing|ings)?|error|errors|fail(?:ed|ure|ures|s)?|skip(?:ped|s)?|xfail|deprecat\w*|exception|traceback|panic)\b/i;

const EXIT_LINE = /^Process exited with code (-?\d+)$/m;
const THEN_SEPARATOR = "\n\nthen:\n";

/** True for a command that runs tests or a build (not its install step). */
export function isCheckCommand(command: string): boolean {
  return TEST_COMMAND.test(command) || BUILD_COMMAND.test(command);
}

export type PassingCheckOutput = {
  /** Text kept whole before the command output (the patch result of `then`). */
  prefix: string;
  /** The exec response of the passing check. */
  output: string;
};

function execCommandOf(toolName: string, input: unknown): string | null {
  if (typeof input !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const command =
    toolName === "exec_command" ? record.cmd : toolName === "apply_patch" ? record.then : null;
  return typeof command === "string" ? command : null;
}

/**
 * The passing check in one tool result: an `exec_command` result, or the
 * `then` part of an `apply_patch` result, of a test or build command that
 * exited 0 with more than {@link PASSING_CHECK_TRIM_MIN_BYTES} of output.
 * Null for anything else.
 */
export function passingCheckOutput(
  toolName: string,
  input: unknown,
  text: string,
): PassingCheckOutput | null {
  if (toolName !== "exec_command" && toolName !== "apply_patch") return null;
  const command = execCommandOf(toolName, input);
  if (!command || !isCheckCommand(command)) return null;
  let prefix = "";
  let output = text;
  if (toolName === "apply_patch") {
    const at = text.indexOf(THEN_SEPARATOR);
    if (at < 0) return null;
    prefix = text.slice(0, at + THEN_SEPARATOR.length);
    output = text.slice(at + THEN_SEPARATOR.length);
  }
  const exit = EXIT_LINE.exec(output.slice(0, 400));
  if (!exit || exit[1] !== "0") return null;
  if (Buffer.byteLength(output, "utf8") <= PASSING_CHECK_TRIM_MIN_BYTES) return null;
  return { prefix, output };
}

function lineStartAtOrAfter(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

function lineEndAtOrBefore(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index);
  return newline < 0 ? 0 : newline + 1;
}

/**
 * The model's view of a passing check: the whole `prefix`, the head and tail
 * of the output (cut at line ends), a note with the stored copy's size and
 * the call that reads it, and the flagged lines of the hidden part. Null when
 * cutting would hide almost nothing.
 */
export function passingCheckView(input: {
  check: PassingCheckOutput;
  /** The sentence that says how to read the whole output from byte `offset`. */
  readInstruction: (offset: number) => string;
  /** Byte offset of the output within the stored text. */
  storedOffset: number;
}): { text: string; hiddenFrom: number; hiddenTo: number } | null {
  const { output } = input.check;
  // Character indices; the output is mostly ASCII, so these track bytes closely.
  const headEnd = lineStartAtOrAfter(output, PASSING_CHECK_EDGE_BYTES);
  const tailStart = lineEndAtOrBefore(output, output.length - PASSING_CHECK_EDGE_BYTES);
  if (tailStart - headEnd < PASSING_CHECK_EDGE_BYTES) return null;
  const hidden = output.slice(headEnd, tailStart);
  const flagged: string[] = [];
  let flaggedCount = 0;
  for (const line of hidden.split("\n")) {
    if (!FLAGGED_LINE.test(line)) continue;
    flaggedCount += 1;
    if (flagged.length < MAX_FLAGGED_LINES) {
      flagged.push(
        line.length > MAX_FLAGGED_LINE_CHARS ? `${line.slice(0, MAX_FLAGGED_LINE_CHARS)}…` : line,
      );
    }
  }
  const hiddenFrom = input.storedOffset + Buffer.byteLength(output.slice(0, headEnd), "utf8");
  const hiddenTo = input.storedOffset + Buffer.byteLength(output.slice(0, tailStart), "utf8");
  const hiddenLines = hidden.split("\n").length - (hidden.endsWith("\n") ? 1 : 0);
  const flaggedNote = flaggedCount
    ? ` Lines there that mention a warning, error, failure or skip${flaggedCount > flagged.length ? ` (first ${flagged.length} of ${flaggedCount})` : ""}:\n${flagged.join("\n")}\n`
    : " None of them mentions a warning, error, failure or skip.";
  const note = `[Opengeni: the command passed; ${hiddenLines} lines of its output (bytes ${hiddenFrom} to ${hiddenTo}) are not shown and the whole output is stored. ${input.readInstruction(hiddenFrom)}${flaggedNote}]\n`;
  return {
    text: `${input.check.prefix}${output.slice(0, headEnd)}${note}${output.slice(tailStart)}`,
    hiddenFrom,
    hiddenTo,
  };
}
