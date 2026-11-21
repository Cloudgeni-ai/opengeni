/**
 * Lossless compaction of shell command output (OPENGENI_EXPERIMENT_TOOL_EFFICIENCY).
 *
 * Command output often carries bytes the model reads as noise but pays for on
 * every later request of the session: terminal colour codes, the intermediate
 * states of `\r` progress bars, runs of identical lines, and the indentation
 * of pretty-printed JSON. Each transform here drops only that, so every
 * identifier, path, number and message line of the output stays visible:
 *
 * - ANSI escape sequences (colours, cursor movement, OSC titles) are removed.
 * - A line rewritten in place with `\r` keeps only its last state (a trailing
 *   `\r` before the newline, as in CRLF output, is kept).
 * - Three or more identical consecutive non-blank lines become one line with
 *   `[repeated N times]` appended, so the count is kept.
 * - A body that is one whole JSON document spread over several lines loses
 *   the whitespace outside its strings (values are not re-serialised). Output
 *   of a command that shows a file (cat, sed, head, jq …) is left as is,
 *   because a later edit quotes the file's own lines.
 *
 * Only the body after the `Output:` line of an exec response is changed; the
 * banner (chunk id, wall time, exit code, token counts) is kept byte for byte.
 * It runs on the tool's result, before the result store decides whether the
 * output is shown whole, so a result that fits once compacted is not stored.
 */
import type { Tool } from "@openai/agents";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;

const ANSI_PATTERN =
  // CSI (colours, cursor), OSC (titles, links; BEL or ST terminated), charset
  // selection and keypad mode switches.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

const OUTPUT_HEADER = "\nOutput:\n";
const MIN_REPEATED_LINES = 3;

/** Commands whose output is a file's own text, which later edits quote. */
const FILE_VIEWERS = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "nl",
  "less",
  "more",
  "bat",
  "batcat",
  "jq",
  "awk",
  "tac",
  "view",
]);

export type CommandOutputCompaction = {
  text: string;
  /** Which transforms changed the text. */
  applied: Array<"ansi" | "progress" | "repeats" | "json">;
};

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI_PATTERN, "") : text;
}

/** Keep the last state of each line rewritten in place with `\r`. */
export function lastProgressStates(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      const crlf = line.endsWith("\r");
      const body = crlf ? line.slice(0, -1) : line;
      const cut = body.lastIndexOf("\r");
      if (cut < 0) return line;
      // A line that ends by returning the cursor keeps what it last showed.
      let last = body.slice(cut + 1);
      if (!last) {
        const states = body.split("\r").filter((state) => state.length > 0);
        last = states.at(-1) ?? "";
      }
      return crlf ? `${last}\r` : last;
    })
    .join("\n");
}

/** Collapse runs of 3+ identical non-blank lines into one line with the count. */
export function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    if (count >= MIN_REPEATED_LINES && line.trim() !== "") {
      out.push(`${line} [repeated ${count} times]`);
      changed = true;
    } else {
      for (let copy = index; copy < end; copy += 1) out.push(line);
    }
    index = end;
  }
  return changed ? out.join("\n") : text;
}

/**
 * Remove the whitespace outside strings of a text that is one whole JSON
 * document spread over several lines, without re-serialising any value.
 * Anything else is returned unchanged.
 */
export function minifyJsonBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.includes("\n")) return text;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return text;
  try {
    JSON.parse(trimmed);
  } catch {
    return text;
  }
  let out = "";
  let inString = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      out += char;
      if (char === "\\" && index + 1 < trimmed.length) {
        index += 1;
        out += trimmed[index];
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      out += char;
    }
  }
  return text.endsWith("\n") ? `${out}\n` : out;
}

/** True when a segment of the command prints a file's own text. */
export function commandShowsFile(command: string | undefined): boolean {
  if (!command) return false;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/);
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
    if (words[index] === "sudo" || words[index] === "command") index += 1;
    const program = words[index]?.split("/").at(-1);
    if (program && FILE_VIEWERS.has(program)) return true;
  }
  return false;
}

/** Compact the body of one command output (see the module comment). */
export function compactCommandOutputBody(
  body: string,
  options: { command?: string | undefined } = {},
): CommandOutputCompaction {
  const applied: CommandOutputCompaction["applied"] = [];
  let text = body;
  const step = (kind: CommandOutputCompaction["applied"][number], next: string) => {
    if (next !== text) {
      applied.push(kind);
      text = next;
    }
  };
  step("ansi", stripAnsi(text));
  step("progress", lastProgressStates(text));
  step("repeats", collapseRepeatedLines(text));
  if (!commandShowsFile(options.command)) step("json", minifyJsonBody(text));
  return { text, applied };
}

/**
 * Compact an exec response: its banner is kept and its body after `Output:`
 * compacted. Text without the banner (a refusal, an error message) is left
 * unchanged.
 */
export function compactCommandOutput(
  output: string,
  options: { command?: string | undefined } = {},
): CommandOutputCompaction {
  const header = output.indexOf(OUTPUT_HEADER);
  if (header < 0) return { text: output, applied: [] };
  const start = header + OUTPUT_HEADER.length;
  const body = compactCommandOutputBody(output.slice(start), options);
  return body.applied.length
    ? { text: output.slice(0, start) + body.text, applied: body.applied }
    : { text: output, applied: [] };
}

const SHELL_OUTPUT_TOOLS = new Set(["exec_command", "write_stdin"]);

function commandOf(toolName: string, input: unknown): string | undefined {
  if (toolName !== "exec_command" || typeof input !== "string") return undefined;
  try {
    const parsed = JSON.parse(input) as { cmd?: unknown };
    return typeof parsed.cmd === "string" ? parsed.cmd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `exec_command` and `write_stdin` with their output compacted. Install it
 * outside the shell's other wrappers and before `then` is linked, so a `then`
 * command's output is compacted the same way.
 */
export function withCompactedCommandOutput(tools: Tool<unknown>[]): Tool<unknown>[] {
  return tools.map((candidate) => {
    if (candidate.type !== "function" || !SHELL_OUTPUT_TOOLS.has(candidate.name)) {
      return candidate;
    }
    const tool = candidate as FunctionTool;
    const invoke = tool.invoke;
    return {
      ...tool,
      invoke: async (runContext, input, details) => {
        const output = await invoke(runContext, input, details);
        if (typeof output !== "string") return output;
        const compacted = compactCommandOutput(output, { command: commandOf(tool.name, input) });
        if (compacted.applied.length) {
          console.info("opengeni.tool_efficiency", {
            part: "compaction",
            tool: tool.name,
            callId: details?.toolCall?.callId,
            applied: compacted.applied,
            savedBytes: Buffer.byteLength(output) - Buffer.byteLength(compacted.text),
          });
        }
        return compacted.text;
      },
    } as FunctionTool;
  });
}
