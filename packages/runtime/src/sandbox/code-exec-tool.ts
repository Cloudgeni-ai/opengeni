/**
 * EXPERIMENT (benchmark prototype, not production): a Codex-style `exec` tool.
 *
 * Codex-family models are trained on a single orchestration tool whose input is
 * JavaScript that calls the other tools (`await tools.exec_command(...)`), batching
 * independent calls with `Promise.allSettled` and returning selected output with
 * `text(...)`. OpenGeni exposes the primitives directly, so the same model spends a
 * model round trip per primitive. This prototype nests the turn's sandbox tools
 * under one `exec` tool to measure the round-trip and latency difference.
 *
 * The script runs in a QuickJS WebAssembly isolate: no host filesystem, network,
 * process, or worker objects are reachable. Nested calls go through the exact same
 * wrapped tool objects (cancellation fences, sandbox session) as direct calls.
 */
import type { FunctionTool } from "@openai/agents-core";
import { newQuickJSWASMModule, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { parseExecResponseBanner } from "./exec-banner";

type Invoke = FunctionTool["invoke"];
type NestedTool = { name: string; description: string; parameters: unknown; invoke: Invoke };

/** Result budget for one `exec` call, in approximate tokens (4 chars each). Sized
 * like the larger direct `exec_command` outputs, so moving work into a script
 * never grows the context faster than the direct tools would. */
const DEFAULT_EXEC_RESULT_TOKENS = 6_000;
/** Budget for one drained nested shell command when the call sets none. */
const DEFAULT_NESTED_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const CPU_INTERRUPT_MS = 60_000;

let quickjs: ReturnType<typeof newQuickJSWASMModule> | null = null;
const loadQuickJs = () => (quickjs ??= newQuickJSWASMModule());

export function codeExecExperimentEnabled(): boolean {
  return process.env.OPENGENI_EXPERIMENT_CODE_EXEC === "1";
}

function identifier(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function declaration(tool: NestedTool): string {
  const params = JSON.stringify(tool.parameters ?? {});
  return [
    `### \`${tool.name}\``,
    tool.description,
    "",
    "exec tool declaration:",
    "```ts",
    `declare const tools: { ${identifier(tool.name)}(args: /* JSON schema: */ ${params} | string): Promise<string | object>; };`,
    "```",
  ].join("\n");
}

function describe(nested: NestedTool[]): string {
  return [
    "Run JavaScript code to orchestrate/compose tool calls",
    "- Evaluates the provided JavaScript code in a fresh isolate as an async function body.",
    "- All nested tools are available on the global `tools` object, for example `await tools.exec_command({cmd: \"ls\"})`.",
    "- Nested tool methods take either an object (the tool's JSON arguments) or a string.",
    "- Nested tools return the tool's output (usually a string).",
    "- Nested `exec_command` and `write_stdin` wait until the command exits and return its output and exit code; you never need to poll. Their stdin is closed (reads see EOF) unless you pass `tty: true`, so a command that would read input finishes instead of waiting. If a command prints nothing for 5 minutes, the call returns its running session ID instead of blocking; continue with `tools.write_stdin({session_id, chars: \"\"})`. Pass `background: true` to get the running session handle back after `yield_time_ms` (for servers or watchers you will interact with).",
    `- Nested shell output is cleaned of terminal control codes and progress redraws, and long output keeps its beginning and end within \`max_output_tokens\` (default ${DEFAULT_NESTED_OUTPUT_TOKENS}). The whole \`exec\` result keeps its beginning and end within about ${DEFAULT_EXEC_RESULT_TOKENS} tokens, so filter large output in the script and \`text(...)\` only what you need.`,
    "- Runs raw JavaScript -- no Node, no file system, no network access, no console. Use nested tools for side effects.",
    "- Run independent calls concurrently with `await Promise.allSettled([...])`; chain dependent steps in one script instead of separate exec calls when the next step does not need your judgment.",
    "- Only output you pass to `text(...)` is returned to you; return just what you need to see.",
    "- When the script finishes, unawaited promises are discarded.",
    "",
    "- Global helpers:",
    "- `text(value)`: Appends a text item to the result. Non-string values are JSON-stringified.",
    "- `exit()`: Ends the script successfully.",
    "- `store(key, value)` / `load(key)`: keep a JSON-serializable value for later `exec` calls in this turn.",
    "- `ALL_TOOLS`: `{ name, description }` entries for the nested tools.",
    "",
    ...nested.map(declaration),
  ].join("\n");
}

const WAIT_SLICE_MS = 30_000;
const WAIT_CEILING_MS = 60 * 60 * 1000;
const SILENCE_RETURN_MS = 5 * 60 * 1000;

// CSI/OSC/two-byte escape sequences emitted by progress bars and colored logs.
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;

/** Remove terminal control codes and collapse carriage-return redraws to the
 * final state of each line, the text a person would see in the terminal. */
export function cleanTerminalOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!body.includes("\r")) return line;
      const frames = body.split("\r").filter((frame) => frame.length > 0);
      return frames.at(-1) ?? "";
    })
    .join("\n");
}

/** Keeps the first and last halves of a stream within a character budget, so
 * draining a long command never holds or returns more than the budget. */
export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalChars = 0;
  private newlines = 0;
  private endsWithNewline = false;
  constructor(private readonly budgetChars: number) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.totalChars += chunk.length;
    for (const ch of chunk) if (ch === "\n") this.newlines += 1;
    this.endsWithNewline = chunk.endsWith("\n");
    const headRoom = Math.floor(this.budgetChars / 2) - this.head.length;
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom);
      chunk = chunk.slice(headRoom);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-(this.budgetChars - Math.floor(this.budgetChars / 2)));
  }

  get size(): number {
    return this.totalChars;
  }

  text(): string {
    const kept = this.head.length + this.tail.length;
    if (kept >= this.totalChars) return this.head + this.tail;
    const omittedTokens = Math.ceil((this.totalChars - kept) / CHARS_PER_TOKEN);
    const lines = this.newlines + (this.endsWithNewline ? 0 : 1);
    return `Total output lines: ${lines}\n\n${this.head}...${omittedTokens} tokens truncated...${this.tail}`;
  }
}

function argObject(arg: unknown): Record<string, unknown> | null {
  return typeof arg === "object" && arg !== null && !Array.isArray(arg) ? (arg as Record<string, unknown>) : null;
}

const POSIX_SHELL = /(?:^|\/)(?:sh|bash|dash|zsh|ksh|ash)$/u;

/** Run-to-completion has nobody to answer a prompt, so a non-tty command gets
 * EOF on stdin (as Codex runs non-tty commands) instead of waiting forever:
 * `rg pattern` with no path otherwise blocks reading stdin until the ceiling. */
function withClosedStdin(arg: Record<string, unknown>): Record<string, unknown> {
  const cmd = arg.cmd;
  const shell = arg.shell;
  if (typeof cmd !== "string" || arg.tty === true) return arg;
  if (typeof shell === "string" && !POSIX_SHELL.test(shell)) return arg;
  return { ...arg, cmd: `exec </dev/null\n${cmd}` };
}

function splitExecResponse(raw: string): { header: string; body: string } {
  const match = /\r?\nOutput:\r?\n/u.exec(raw);
  if (!match) return { header: "", body: raw };
  return { header: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

/** Nested shell calls run to completion: a script is the place to wait, so a
 * yielded command is drained here instead of costing the model a poll request. */
async function invokeToCompletion(
  tool: NestedTool,
  tools: Map<string, NestedTool>,
  runContext: unknown,
  arg: unknown,
  details: unknown,
): Promise<unknown> {
  const shellCall = tool.name === "exec_command" || tool.name === "write_stdin";
  const object = argObject(typeof arg === "string" && tool.name === "exec_command" ? { cmd: arg } : arg);
  const background = object?.background === true;
  let cleaned: unknown = object
    ? Object.fromEntries(Object.entries(object).filter(([k]) => k !== "background"))
    : arg;
  if (!shellCall || background) return await tool.invoke(runContext as never, toInputString(tool, cleaned), details as never);

  const maxTokens =
    typeof object?.max_output_tokens === "number" && object.max_output_tokens > 0
      ? Math.trunc(object.max_output_tokens)
      : DEFAULT_NESTED_OUTPUT_TOKENS;
  if (tool.name === "exec_command" && object) cleaned = withClosedStdin(cleaned as Record<string, unknown>);
  let result = await tool.invoke(runContext as never, toInputString(tool, cleaned), details as never);
  const poller = tools.get("write_stdin");
  const output = new HeadTailBuffer(maxTokens * CHARS_PER_TOKEN);
  const deadline = Date.now() + WAIT_CEILING_MS;
  let lastOutputAt = Date.now();
  for (;;) {
    if (typeof result !== "string") return result;
    const banner = parseExecResponseBanner(result);
    const { header, body } = splitExecResponse(result);
    const fresh = cleanTerminalOutput(body);
    if (fresh.trim()) lastOutputAt = Date.now();
    output.push(fresh);
    if (banner.kind !== "running" || !poller) {
      return header ? `${header}\nOutput:\n${output.text()}` : output.text();
    }
    const now = Date.now();
    if (now > deadline || now - lastOutputAt >= SILENCE_RETURN_MS) {
      const why =
        now > deadline
          ? "still running after the wait ceiling"
          : `no output for ${Math.round((now - lastOutputAt) / 1000)}s`;
      return `${header}\nOutput:\n${output.text()}\n[exec: ${why}; returned the running session ${banner.sessionId}. Continue waiting with tools.write_stdin({session_id: ${banner.sessionId}, chars: ""}) or send it input.]`;
    }
    result = await poller.invoke(
      runContext as never,
      JSON.stringify({
        session_id: banner.sessionId,
        chars: "",
        yield_time_ms: WAIT_SLICE_MS,
        max_output_tokens: maxTokens,
      }),
      details as never,
    );
  }
}

function toInputString(tool: NestedTool, arg: unknown): string {
  if (typeof arg === "string") {
    if (tool.name === "exec_command") return JSON.stringify({ cmd: arg });
    return JSON.stringify(arg);
  }
  return JSON.stringify(arg ?? {});
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A per-turn registry. Each sandbox capability registers its wrapped tools; the
 * single `exec` tool resolves nested tools at call time.
 */
export class CodeExecRegistry {
  private readonly tools = new Map<string, NestedTool>();
  private readonly stored = new Map<string, string>();
  private execTool: FunctionTool | null = null;

  register(
    tools: Array<{ name: unknown; description?: unknown; parameters?: unknown; invoke: unknown }>,
  ): void {
    for (const tool of tools) {
      if (typeof tool.name !== "string") continue;
      this.tools.set(tool.name, {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters,
        invoke: tool.invoke as Invoke,
      });
    }
  }

  tool(): FunctionTool {
    if (this.execTool) return this.execTool;
    const registry = this;
    const execTool = {
      type: "function",
      name: "exec",
      get description() {
        return describe([...registry.tools.values()]);
      },
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript source (async function body)." } },
        required: ["code"],
        additionalProperties: false,
      },
      strict: true,
      deferLoading: false,
      needsApproval: async () => false,
      isEnabled: async () => true,
      invoke: async (runContext: unknown, input: string, details?: unknown) => {
        let code: string;
        try {
          code = (JSON.parse(input) as { code?: unknown }).code as string;
        } catch {
          return "exec failed: input must be JSON {\"code\": string}";
        }
        if (typeof code !== "string" || !code.trim()) return "exec failed: empty code";
        return await registry.run(code, runContext, details);
      },
    } as unknown as FunctionTool;
    this.execTool = execTool;
    return execTool;
  }

  private async run(code: string, runContext: unknown, details: unknown): Promise<string> {
    const QuickJS = await loadQuickJs();
    const runtime = QuickJS.newRuntime();
    let cpuStartedAt = Date.now();
    runtime.setInterruptHandler(() => Date.now() - cpuStartedAt > CPU_INTERRUPT_MS);
    const vm = runtime.newContext();
    const out = new HeadTailBuffer(DEFAULT_EXEC_RESULT_TOKENS * CHARS_PER_TOKEN);
    let exited = false;
    const pending = new Set<Promise<void>>();
    const append = (value: string) => {
      out.push(out.size > 0 ? `\n${value}` : value);
    };
    try {
      const fn = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | void) => {
        const handle = vm.newFunction(name, impl);
        vm.setProp(vm.global, name, handle);
        handle.dispose();
      };
      fn("text", (value) => {
        append(vm.typeof(value) === "string" ? vm.getString(value) : stringify(vm.dump(value)));
      });
      fn("exit", () => {
        exited = true;
        throw new Error("__opengeni_exec_exit__");
      });
      fn("store", (key, value) => {
        this.stored.set(vm.getString(key), JSON.stringify(vm.dump(value)));
      });
      fn("load", (key) => {
        const raw = this.stored.get(vm.getString(key));
        if (raw === undefined) return vm.undefined;
        const parsed = vm.evalCode(`(${raw})`);
        return vm.unwrapResult(parsed);
      });
      const all = [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }));
      const allHandle = vm.unwrapResult(vm.evalCode(`(${JSON.stringify(all)})`));
      vm.setProp(vm.global, "ALL_TOOLS", allHandle);
      allHandle.dispose();
      const toolsObj = vm.newObject();
      for (const tool of this.tools.values()) {
        const method = vm.newFunction(identifier(tool.name), (argHandle) => {
          const arg = argHandle === undefined ? undefined : vm.dump(argHandle);
          const deferred = vm.newPromise();
          const work = (async () => {
            try {
              const result = await invokeToCompletion(tool, this.tools, runContext, arg, details);
              if (!deferred.alive) return;
              const handle =
                typeof result === "string"
                  ? vm.newString(result)
                  : vm.unwrapResult(vm.evalCode(`(${JSON.stringify(result ?? null)})`));
              deferred.resolve(handle);
              handle.dispose();
            } catch (error) {
              if (!deferred.alive) return;
              const handle = vm.newError(error instanceof Error ? error.message : String(error));
              deferred.reject(handle);
              handle.dispose();
            } finally {
              cpuStartedAt = Date.now();
              runtime.executePendingJobs();
            }
          })();
          pending.add(work);
          void work.finally(() => pending.delete(work));
          return deferred.handle;
        });
        vm.setProp(toolsObj, identifier(tool.name), method);
        method.dispose();
      }
      vm.setProp(vm.global, "tools", toolsObj);
      toolsObj.dispose();

      cpuStartedAt = Date.now();
      const evaluated = vm.evalCode(`(async () => {\n${code}\n})()`);
      if (evaluated.error) {
        const err = vm.dump(evaluated.error);
        evaluated.error.dispose();
        return finish(`Script error: ${stringify(err)}`);
      }
      const promiseHandle = evaluated.value;
      const settled = vm.resolvePromise(promiseHandle);
      promiseHandle.dispose();
      runtime.executePendingJobs();
      const result = await settled;
      // Let any in-flight nested calls that the script did await finish their bookkeeping.
      await Promise.allSettled([...pending]);
      if (result.error) {
        const err = vm.dump(result.error);
        result.error.dispose();
        const message = typeof err === "object" && err ? (err as { message?: string }).message : err;
        if (exited || message === "__opengeni_exec_exit__") return finish(null);
        return finish(`Script error: ${stringify(err)}`);
      }
      result.value.dispose();
      return finish(null);
    } finally {
      await Promise.allSettled([...pending]);
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // A leaked handle must never fail the tool result.
      }
    }

    function finish(error: string | null): string {
      const parts = [out.text()];
      if (error) parts.push(error);
      const text = parts.filter((p) => p.length > 0).join("\n");
      return text.length > 0 ? text : "(exec completed with no text output)";
    }
  }
}
