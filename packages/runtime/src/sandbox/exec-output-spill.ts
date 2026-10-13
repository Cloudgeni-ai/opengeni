/**
 * Spill large `exec_command` / `write_stdin` output to a sandbox file.
 *
 * Gated by settings.experimentExecOutputSpill (off by default;
 * `OPENGENI_EXPERIMENT_EXEC_OUTPUT_SPILL=true` in the worker environment).
 *
 * A large command output stays in the model's context for the rest of the
 * run and is re-sent on every later request. When the output body of one
 * returned chunk exceeds EXEC_OUTPUT_SPILL_THRESHOLD_BYTES, the full body is
 * written to `tool-results/exec-<callId>.txt` (beside the existing tool-result
 * spill files, cwd-relative so it also works on a Connected Machine) and the
 * model receives the unchanged SDK banner, a one-line notice, the first and
 * last lines of the output and an elision marker. The model can search or page
 * the file with ordinary shell commands.
 *
 * Only the model's view changes:
 * - The full response string still reaches the session timeline: it rides on
 *   the SDK run item's `customData` (see EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY),
 *   which `normalizeSdkEvent` prefers for `agent.toolCall.output`, and the
 *   worker strips after the event is durable.
 * - The projection is computed once, at execution, and becomes the SDK tool
 *   output. It is therefore exactly what is persisted in session history and
 *   replayed, so later prompt-cache prefixes match.
 * - Outputs at or under the threshold, responses without a valid SDK banner
 *   (errors), non-string outputs and calls without a call id are returned
 *   untouched. The banner (exit code or running session id) is never changed.
 *   A running command spills only the returned chunk; later `write_stdin`
 *   polls are handled independently.
 * - The model's own `max_output_tokens` is applied first by the inner tool, so
 *   a request for less than the threshold never spills, and a spilled file
 *   holds what the inner tool returned.
 * - If the file cannot be written, the original output is returned.
 *
 * The file is written through the sandbox editor (`create_file` with exact
 * content), the same primitive internal writers use, so routed sessions keep
 * their mutation admission. Line endings are normalized to `\n` by that
 * primitive. A `.gitignore` containing `*` is created in the directory once per
 * session so spill files never show up in a repository rooted at the cwd.
 */
import { randomBytes } from "node:crypto";
import type { Tool } from "@openai/agents";
import { TOOL_RESULT_SPILL_MOUNT_PATH } from "@opengeni/contracts";
import { splitExecResponse } from "./exec-banner";

/** Output bodies larger than this (~2,500 tokens at 4 bytes/token) are spilled. */
export const EXEC_OUTPUT_SPILL_THRESHOLD_BYTES = 10_000;
export const EXEC_OUTPUT_SPILL_HEAD_LINES = 60;
export const EXEC_OUTPUT_SPILL_TAIL_LINES = 25;
/** Character budgets keep the whole preview near 1,100 tokens even for long lines. */
export const EXEC_OUTPUT_SPILL_HEAD_MAX_CHARS = 3_000;
export const EXEC_OUTPUT_SPILL_TAIL_MAX_CHARS = 1_500;
export const EXEC_OUTPUT_SPILL_LINE_MAX_CHARS = 400;

/** customData key carrying the full response string for the timeline event. */
export const EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY = "__opengeniExecFullOutputV1" as const;

const SPILLED_TOOL_NAMES = new Set(["exec_command", "write_stdin"]);
const APPROX_BYTES_PER_TOKEN = 4;

type ExecSpillEditor = {
  createFile(operation: { type: "create_file"; path: string; diff: string }): Promise<unknown>;
};

export type ExecOutputSpillTarget = {
  /** Stable per-session identity (the bound sandbox session). */
  session: object;
  editor: ExecSpillEditor;
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function boundedLine(line: string): string {
  if (line.length <= EXEC_OUTPUT_SPILL_LINE_MAX_CHARS) return line;
  let kept = line.slice(0, EXEC_OUTPUT_SPILL_LINE_MAX_CHARS);
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(kept)) kept = kept.slice(0, -1);
  return `${kept} [... ${formatCount(line.length - kept.length)} more chars]`;
}

/** Lines of an output body; a final newline does not start another line. */
function outputLines(body: string): string[] {
  const lines = body.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** Model-visible path of a spill file (cwd-relative, like tool-result spills). */
export function execOutputSpillPath(callId: string, suffix = ""): string {
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "call";
  return `${TOOL_RESULT_SPILL_MOUNT_PATH}/exec-${safe}${suffix}.txt`;
}

/**
 * Deterministic model projection of one spilled response: the unchanged
 * banner, a notice line, the first and last lines and an elision marker.
 */
export function execOutputSpillProjection(header: string, body: string, path: string): string {
  const lines = outputLines(body);
  const head: string[] = [];
  let headChars = 0;
  for (const line of lines) {
    if (head.length >= EXEC_OUTPUT_SPILL_HEAD_LINES) break;
    const shown = boundedLine(line);
    if (head.length > 0 && headChars + shown.length > EXEC_OUTPUT_SPILL_HEAD_MAX_CHARS) break;
    head.push(shown);
    headChars += shown.length;
  }
  const tail: string[] = [];
  let tailChars = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    if (tail.length >= EXEC_OUTPUT_SPILL_TAIL_LINES) break;
    const shown = boundedLine(lines[index]!);
    if (tail.length > 0 && tailChars + shown.length > EXEC_OUTPUT_SPILL_TAIL_MAX_CHARS) break;
    tail.unshift(shown);
    tailChars += shown.length;
  }
  const omittedLines = lines.length - head.length - tail.length;
  const tokens = Math.ceil(Buffer.byteLength(body, "utf8") / APPROX_BYTES_PER_TOKEN);
  const notice =
    `Output was ${plural(lines.length, "line")} (~${formatCount(tokens)} tokens); ` +
    `showing the first ${formatCount(head.length)} and last ${formatCount(tail.length)}. ` +
    `Full output: ${path}. Search it with rg or page it with sed -n.`;
  const out = [notice, ...head];
  if (omittedLines > 0) {
    out.push(`[... ${plural(omittedLines, "line")} omitted; full output in ${path} ...]`);
  }
  out.push(...tail);
  return `${header}${out.join("\n")}`;
}

/** Headerless V4A create diff whose SDK `create` application yields `content`. */
export function exactContentCreateDiff(content: string): string {
  return content
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
}

const gitignoreAttempted = new WeakSet<object>();

async function writeSpillFile(
  target: ExecOutputSpillTarget,
  callId: string,
  body: string,
): Promise<string | null> {
  if (!gitignoreAttempted.has(target.session)) {
    gitignoreAttempted.add(target.session);
    try {
      await target.editor.createFile({
        type: "create_file",
        path: `${TOOL_RESULT_SPILL_MOUNT_PATH}/.gitignore`,
        diff: exactContentCreateDiff("*\n"),
      });
    } catch {
      // Usually it already exists. Spilling does not depend on it.
    }
  }
  const diff = exactContentCreateDiff(body);
  // A re-executed call (same call id) finds its earlier file; use a fresh name.
  for (const path of [
    execOutputSpillPath(callId),
    execOutputSpillPath(callId, `-${randomBytes(4).toString("hex")}`),
  ]) {
    try {
      await target.editor.createFile({ type: "create_file", path, diff });
      return path;
    } catch {
      // Try the next name, then fall back to the unchanged output.
    }
  }
  return null;
}

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;
type CustomDataExtractor = NonNullable<FunctionTool["customDataExtractor"]>;

/**
 * Wrap the model-facing `exec_command` and `write_stdin` tools so large output
 * bodies spill to a file. Apply it outermost so every inner layer (turn
 * cancellation, routing fences, banner parsing) sees the full response.
 */
export function withExecOutputSpill(
  tools: Tool<unknown>[],
  resolveTarget: () => ExecOutputSpillTarget | null,
): Tool<unknown>[] {
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || !SPILLED_TOOL_NAMES.has(capabilityTool.name)) {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    const innerExtractor = capabilityTool.customDataExtractor;
    const fullOutputs = new Map<string, string>();
    const customDataExtractor: CustomDataExtractor = async (context) => {
      const inner = innerExtractor ? await innerExtractor(context) : undefined;
      const callId = context.toolCall?.callId;
      const full = callId ? fullOutputs.get(callId) : undefined;
      if (full === undefined) return inner;
      fullOutputs.delete(callId!);
      return { ...(inner ?? {}), [EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY]: full };
    };
    return {
      ...capabilityTool,
      customDataExtractor,
      invoke: async (runContext, input, details) => {
        const output = await invoke(runContext, input, details);
        const callId = details?.toolCall?.callId;
        if (typeof output !== "string" || !callId) return output;
        const parts = splitExecResponse(output);
        if (!parts || Buffer.byteLength(parts.body, "utf8") <= EXEC_OUTPUT_SPILL_THRESHOLD_BYTES) {
          return output;
        }
        const target = resolveTarget();
        if (!target) return output;
        const path = await writeSpillFile(target, callId, parts.body);
        if (!path) return output;
        fullOutputs.set(callId, output);
        return execOutputSpillProjection(parts.header, parts.body, path);
      },
    } as FunctionTool;
  });
}

/** Full response string carried for the timeline, or null. */
export function execFullOutputFromCustomData(customData: unknown): string | null {
  if (!customData || typeof customData !== "object" || Array.isArray(customData)) return null;
  const full = (customData as Record<string, unknown>)[EXEC_OUTPUT_SPILL_CUSTOM_DATA_KEY];
  return typeof full === "string" ? full : null;
}
