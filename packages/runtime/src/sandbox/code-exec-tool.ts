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

type Invoke = FunctionTool["invoke"];
type NestedTool = { name: string; description: string; parameters: unknown; invoke: Invoke };

const DEFAULT_MAX_OUTPUT_CHARS = 40_000;
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
    const out: string[] = [];
    let outChars = 0;
    let truncated = false;
    let exited = false;
    const pending = new Set<Promise<void>>();
    const append = (value: string) => {
      if (outChars >= DEFAULT_MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      const room = DEFAULT_MAX_OUTPUT_CHARS - outChars;
      const piece = value.length > room ? value.slice(0, room) : value;
      if (piece.length < value.length) truncated = true;
      out.push(piece);
      outChars += piece.length;
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
              const result = await tool.invoke(
                runContext as never,
                toInputString(tool, arg),
                details as never,
              );
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
      const body = out.join("\n");
      const parts = [body];
      if (truncated) parts.push(`[exec output truncated at ${DEFAULT_MAX_OUTPUT_CHARS} characters]`);
      if (error) parts.push(error);
      const text = parts.filter((p) => p.length > 0).join("\n");
      return text.length > 0 ? text : "(exec completed with no text output)";
    }
  }
}
