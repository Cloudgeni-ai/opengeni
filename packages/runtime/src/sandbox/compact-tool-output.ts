/**
 * Experiment: compact model-visible shell tool output.
 *
 * Gated by `OPENGENI_EXPERIMENT_COMPACT_TOOL_OUTPUT=1` (default off). When on,
 * the final string returned by `exec_command`, `write_stdin` and
 * `command_input` is rewritten once, at the tool-result boundary, before the
 * SDK records it. Accepted history is never touched, so prompt-cache prefixes
 * stay stable: a result is compacted exactly once, when it is created.
 *
 * Only the command body after the SDK `Output:` delimiter changes. The
 * metadata header (Chunk ID / Wall time / Process status / Original token
 * count) is preserved byte-for-byte because timeline parsers and background
 * command handling read it.
 *
 * Transforms, in order:
 *  - PTY newlines: a pseudo-terminal turns every newline into CRLF; those
 *    become LF again (lossless, only for PTY output).
 *  - terminal rendering: carriage-return overwrites resolve to the final
 *    visible line and ANSI escape sequences are removed (what a terminal
 *    displays).
 *  - repeated consecutive identical lines folded with an exact count
 *    (lossless).
 *  - lossy, failure-preserving: long runs of dependency download/install
 *    progress lines and long runs of passing-test lines keep their first and
 *    last line plus a counted marker. Lines mentioning an error, failure or
 *    warning never join a run.
 *  - grep `path:line:` rows sharing one file grouped under a single path
 *    heading, ripgrep `--heading` style (information-preserving).
 *  - a whole-body pretty-printed JSON document minified (whitespace outside
 *    strings only, so every lexeme is preserved; lossless).
 *
 * Commands that read files (cat, sed, head, tail, grep, git show, ...) get
 * only the lossless transforms and keep their escape sequences, so a fixture
 * or log file the model asked to read is shown as it is.
 *
 * Recovery: a command containing `OPENGENI_RAW_OUTPUT=1` (for example
 * `OPENGENI_RAW_OUTPUT=1 npm test`) is returned unmodified, as are later
 * `write_stdin` polls of that session. Every lossy marker names this escape.
 */

export const COMPACT_TOOL_OUTPUT_ENV = "OPENGENI_EXPERIMENT_COMPACT_TOOL_OUTPUT";
export const RAW_OUTPUT_OPT_OUT = "OPENGENI_RAW_OUTPUT=1";

export function compactToolOutputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMPACT_TOOL_OUTPUT_ENV] === "1";
}

export type CompactShellOutputOptions = {
  /**
   * The command ran in a pseudo-terminal, whose line discipline turned every
   * newline into CRLF. `null` means unknown: normalize only when every newline
   * in the body is CRLF.
   */
  pty: boolean | null;
  /** Resolve carriage-return overwrites and remove ANSI escape sequences. */
  terminal: boolean;
  /** Permit lossy (counted, failure-preserving) run folding. */
  lossy: boolean;
};

const SDK_HEADER =
  /^(?:Chunk ID: [^\n]*\nWall time: [^\n]*\n(?:Process (?:running with session ID \d+|exited with code -?\d+)\n)?(?:Original token count: \d+\n)?Output:\n|Process (?:exited with code -?\d+|running with session ID \d+)\n\nOutput:\n)/u;
const RUNNING_SESSION = /^(?:[^\n]*\n)*?Process running with session ID (\d+)\n/u;

/** Split an exec response into its preserved metadata header and the body. */
export function splitExecResponse(raw: string): { header: string; body: string } | null {
  const match = SDK_HEADER.exec(raw);
  if (!match) return null;
  return { header: match[0], body: raw.slice(match[0].length) };
}

// CSI (including private-mode `?25l`), OSC (BEL or ST terminated), and the
// remaining two-byte ESC sequences.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/gu;
// eslint-disable-next-line no-control-regex
const ERASE_LINE = /\x1b\[[02]?K/u;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Resolve what a terminal would show: a carriage return overwrites the line
 * from column 0 (an erase-line sequence clears the rest), and ANSI escape
 * sequences are presentation only. A trailing CR before the newline is part of
 * a CRLF pair and leaves the line unchanged.
 */
export function renderTerminalText(text: string): string {
  if (!text.includes("\r") && !text.includes("\x1b")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return stripAnsi(line);
      let visible = "";
      for (const segment of line.split("\r")) {
        const erases = ERASE_LINE.test(segment);
        const plain = stripAnsi(segment);
        visible = erases ? plain : plain + visible.slice(plain.length);
      }
      return visible;
    })
    .join("\n");
}

export function foldRepeatedLines(text: string, minRun = 3): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j += 1;
    const run = j - i + 1;
    if (run >= minRun && lines[i]!.trim() !== "") {
      out.push(lines[i]!, `[previous line repeated ${run - 1} more times]`);
    } else {
      for (let k = i; k <= j; k += 1) out.push(lines[k]!);
    }
    i = j + 1;
  }
  return out.join("\n");
}

// The path must contain a dot or slash so timestamps (`12:30:45`) never match.
const GREP_ROW = /^([^\s:]*[./][^\s:]*):(\d+):(.*)$/u;
const NUMBERED_ROW = /^\d+[:-]/u;

/**
 * Group runs of at least `minGroup` consecutive `path:line:content` rows that
 * share one path under a single path heading (`rg --heading` layout). Context
 * rows of the same file (`path-line-content`) and `--` separators inside the
 * run stay with the group. Runs followed by a line that itself looks like a
 * numbered row are left alone so headings stay unambiguous.
 */
export function groupGrepRows(text: string, minGroup = 3): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const head = GREP_ROW.exec(lines[i]!);
    if (!head) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    const path = head[1]!;
    const contextPrefix = `${path}-`;
    const rows: string[] = [];
    let matched = 0;
    let j = i;
    for (; j < lines.length; j += 1) {
      const line = lines[j]!;
      const row = GREP_ROW.exec(line);
      if (row && row[1] === path) {
        rows.push(`${row[2]}:${row[3]}`);
        matched += 1;
        continue;
      }
      if (line.startsWith(contextPrefix)) {
        const rest = line.slice(contextPrefix.length);
        const context = /^(\d+)-(.*)$/u.exec(rest);
        if (context) {
          rows.push(`${context[1]}-${context[2]}`);
          continue;
        }
      }
      if (line === "--" && j + 1 < lines.length && lines[j + 1]!.startsWith(path)) {
        rows.push("--");
        continue;
      }
      break;
    }
    const next = j < lines.length ? lines[j]! : null;
    if (matched >= minGroup && (next === null || !NUMBERED_ROW.test(next))) {
      out.push(path, ...rows);
    } else {
      for (let k = i; k < j; k += 1) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Minify a body that is exactly one pretty-printed JSON document by removing
 * whitespace outside strings. Every number/string lexeme is kept verbatim.
 */
export function minifyJsonBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 64 || !/^[[{]/u.test(trimmed) || !/\n\s/u.test(trimmed)) return text;
  try {
    JSON.parse(trimmed);
  } catch {
    return text;
  }
  let out = "";
  let inString = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += trimmed[i + 1] ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r") {
      out += ch;
    }
  }
  const trailing = text.endsWith("\n") ? "\n" : "";
  return out + trailing;
}

const FAILURE_WORD =
  /\b(?:error|errors|fail|failed|failing|failure|failures|panic|exception|fatal|traceback|warning|denied|timeout|timed out|abort|aborted)\b/iu;

const INSTALL_PROGRESS =
  /^\s*(?:go: (?:downloading|finding|extracting) \S|Collecting \S|Downloading \S|Requirement already satisfied: |Using cached \S|Obtaining \S|Building wheel for \S|Created wheel for \S|Stored in directory: |Compiling \S+ v\d|Downloaded \S+ v\d|Checking \S+ v\d|Fresh \S+ v\d|Get:\d+ |Hit:\d+ |Ign:\d+ |Unpacking \S|Setting up \S|Selecting previously unselected package |Preparing to unpack |npm (?:WARN|warn) deprecated |Progress: resolved \d|Resolving: total \d|Downloading packages|Fetching \S+ \d|Installing \S+ \d)/u;

const PASSING_TEST =
  /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME) +\S|--- PASS: \S|PASS$|ok\s+\S+\s+(?:\d[\d.]*m?s|\(cached\))|\S+::\S.* PASSED\b|test \S+ \.\.\. ok$|[✓✔√] \S)/u;

type NoiseRun = { pattern: RegExp; label: string; minRun: number };

const NOISE_RUNS: readonly NoiseRun[] = [
  { pattern: INSTALL_PROGRESS, label: "dependency download/install progress", minRun: 8 },
  { pattern: PASSING_TEST, label: "passing-test", minRun: 12 },
];

function noiseMarker(count: number, label: string): string {
  return `[... ${count} more ${label} lines omitted; prefix the command with ${RAW_OUTPUT_OPT_OUT} to see every line]`;
}

/** Fold long runs of lines matching one noise pattern, keeping first and last. */
export function foldNoiseRuns(text: string, runs: readonly NoiseRun[] = NOISE_RUNS): string {
  const lines = text.split("\n");
  const matches = (line: string, pattern: RegExp) => pattern.test(line) && !FAILURE_WORD.test(line);
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const run = runs.find((candidate) => matches(lines[i]!, candidate.pattern));
    if (!run) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && matches(lines[j + 1]!, run.pattern)) j += 1;
    const length = j - i + 1;
    if (length >= run.minRun) {
      out.push(lines[i]!, noiseMarker(length - 2, run.label), lines[j]!);
    } else {
      for (let k = i; k <= j; k += 1) out.push(lines[k]!);
    }
    i = j + 1;
  }
  return out.join("\n");
}

/** True when the PTY line discipline produced every newline as CRLF. */
function allNewlinesAreCrlf(text: string): boolean {
  const newlines = text.split("\n").length - 1;
  return newlines > 0 && text.split("\r\n").length - 1 === newlines;
}

export function compactShellOutputBody(body: string, options: CompactShellOutputOptions): string {
  let text = body;
  const ptyNewlines = options.pty ?? allNewlinesAreCrlf(text);
  if (ptyNewlines) text = text.replace(/\r\n/gu, "\n");
  if (options.terminal) text = renderTerminalText(text);
  text = foldRepeatedLines(text);
  if (options.lossy) text = foldNoiseRuns(text);
  text = groupGrepRows(text);
  text = minifyJsonBody(text);
  return text;
}

// A command that reads files gets only the lossless transforms and keeps its
// escape sequences: folding or recoloring a fixture/log file the model asked
// to read would hide exactly the content it requested. A reader counts only in
// command position (start, or after `;`, `&&`, `||`, `(` or a newline); the
// same program used as a `|` filter of another command's output does not.
const FILE_READ_COMMAND =
  /(?:^|[;&\n(]|\|\|)\s*(?:sudo\s+)?(?:cat|sed|head|tail|less|more|nl|awk|grep|egrep|fgrep|rg|ag|jq|diff|od|xxd|hexdump|strings|git\s+(?:show|diff|log|blame|grep))(?:\s|$)/u;
// `cat > file`, `cat >> file` and `cat <<EOF` write a file rather than read one.
const CAT_WRITE = /\bcat\s*(?:>>?|<<-?)/gu;

// A here-document body is data for the command, not more commands.
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/gu;

export function commandReadsFiles(cmd: string): boolean {
  const commands = cmd.replace(HEREDOC_BODY, "<<HEREDOC").replace(CAT_WRITE, "true ");
  return FILE_READ_COMMAND.test(commands);
}

export function rawOutputRequested(cmd: string): boolean {
  return cmd.includes(RAW_OUTPUT_OPT_OUT);
}

export type ShellOutputPolicy = CompactShellOutputOptions & { raw: boolean };

/** Policy for one `exec_command` invocation, from its exact arguments. */
export function execCommandOutputPolicy(args: Record<string, unknown> | null): ShellOutputPolicy {
  const cmd = typeof args?.cmd === "string" ? args.cmd : "";
  const readsFiles = commandReadsFiles(cmd);
  return {
    raw: rawOutputRequested(cmd),
    // The SDK default is a PTY; only an explicit `tty: false` is a pipe.
    pty: args?.tty !== false,
    terminal: !readsFiles,
    lossy: !readsFiles,
  };
}

/** Polls of a session whose start this wrapper did not observe stay lossless. */
const UNKNOWN_SESSION_POLICY: ShellOutputPolicy = {
  raw: false,
  pty: null,
  terminal: true,
  lossy: false,
};

/** Compact one complete exec response string, preserving its header. */
export function compactExecResponse(raw: string, options: CompactShellOutputOptions): string {
  const split = splitExecResponse(raw);
  if (!split) return raw;
  const body = compactShellOutputBody(split.body, options);
  return body === split.body ? raw : split.header + body;
}

type ShellToolLike = {
  type: string;
  name?: string;
  invoke?: (runContext: unknown, input: string, details?: unknown) => Promise<unknown>;
};

const SHELL_TOOL_NAMES = new Set(["exec_command", "write_stdin", "command_input"]);

function parsedObject(input: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Per bound sandbox session: provider session id to the policy of its exec. */
export type ShellOutputPolicyState = Map<number, ShellOutputPolicy>;

/**
 * Wrap a capability tool list so each shell tool's final string result is
 * compacted. `state` remembers the policy of every yielded `exec_command`
 * so later `write_stdin`/`command_input` output of that process follows it.
 */
export function withCompactShellToolOutput<T>(
  tools: T[],
  state: ShellOutputPolicyState = new Map(),
): T[] {
  return tools.map((candidate) => {
    const tool = candidate as unknown as ShellToolLike;
    if (tool.type !== "function" || !tool.name || !SHELL_TOOL_NAMES.has(tool.name)) {
      return candidate;
    }
    const invoke = tool.invoke;
    if (!invoke) return candidate;
    const name = tool.name;
    return {
      ...tool,
      invoke: async (runContext: unknown, input: string, details?: unknown) => {
        const output = await invoke(runContext, input, details);
        if (typeof output !== "string") return output;
        const args = parsedObject(input);
        let policy: ShellOutputPolicy;
        if (name === "exec_command") {
          policy = execCommandOutputPolicy(args);
          const running = RUNNING_SESSION.exec(output);
          if (running) state.set(Number(running[1]), policy);
        } else {
          const sessionId = typeof args?.session_id === "number" ? args.session_id : null;
          policy =
            (sessionId !== null ? state.get(sessionId) : undefined) ?? UNKNOWN_SESSION_POLICY;
        }
        if (policy.raw) return output;
        return compactExecResponse(output, policy);
      },
    } as unknown as T;
  });
}
