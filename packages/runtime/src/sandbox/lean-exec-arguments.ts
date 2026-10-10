/**
 * Experiment: lean model-facing `exec_command` arguments.
 *
 * Gated by `OPENGENI_EXPERIMENT_OUTPUT_COST=1` (worker environment, default
 * off).
 *
 * The SDK shell capability declares `exec_command` through `tool()`, which
 * defaults to strict mode. Strict mode turns every optional field into a
 * required nullable one, so every model has to write all seven arguments on
 * every call: `workdir`, `shell`, `login`, `tty`, `yield_time_ms` and
 * `max_output_tokens` next to `cmd`. Recorded traffic shows those values are
 * nearly always the same (`login:false`, `tty:false`, `yield_time_ms:10000`,
 * `shell:"bash"`/`"/bin/bash"`/null, `workdir:"/workspace"`). On Claude each
 * argument costs about ten output tokens of tool-call framing on top of its
 * value. In the ab7 DeepSWE arm (Sonnet 5.5) a call with all six optional
 * arguments cost about 100 more output tokens than one with only `cmd`, about
 * 7% of all output tokens.
 *
 * When on, the model-facing schema is non-strict and requires only `cmd` and
 * `max_output_tokens` (a meaningful per-call choice that bounds tool output, so
 * it stays required). The others are optional with documented defaults. The
 * same shape is what Codex's own unified exec tool uses.
 *
 * Execution parity: before the inner (SDK, cancellation and routing) layers
 * see the arguments, an omitted `login`, `tty` or `yield_time_ms` is filled
 * with the value models choose today (`false`, `false`, `10000`). This matters:
 * the SDK defaults `login` to true, and the turn-cancellation layer treats an
 * absent `tty` as interactive. Explicitly supplied values, including `null`,
 * pass through unchanged, so every argument object that is valid today runs
 * exactly as before. `shell` and `workdir` keep their existing absent/null
 * meaning (default shell, turn cwd).
 */
import type { Tool } from "@openai/agents";

export const OUTPUT_COST_EXPERIMENT_ENV = "OPENGENI_EXPERIMENT_OUTPUT_COST";

export function outputCostExperimentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OUTPUT_COST_EXPERIMENT_ENV] === "1";
}

/** Values filled in for omitted arguments; the dominant explicit choices today. */
export const LEAN_EXEC_COMMAND_DEFAULTS = {
  login: false,
  tty: false,
  yield_time_ms: 10_000,
} as const;

export const LEAN_EXEC_COMMAND_PARAMETERS = {
  type: "object",
  properties: {
    cmd: { type: "string", minLength: 1, description: "Shell command to execute." },
    max_output_tokens: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of tokens to return. Excess output will be truncated.",
    },
    yield_time_ms: {
      type: "integer",
      minimum: 0,
      description:
        "How long to wait (in milliseconds) for output before yielding. Omit for the default of 10000.",
    },
    workdir: {
      type: "string",
      description: "Working directory for the command. Omit to use the turn cwd.",
    },
    tty: {
      type: "boolean",
      description:
        "Allocate a TTY (needed to interrupt the process later with Ctrl-C through write_stdin). Omit for the default of false.",
    },
    login: {
      type: "boolean",
      description: "Run the shell with -l/-i (login) semantics. Omit for the default of false.",
    },
    shell: {
      type: "string",
      description: "Shell binary to launch. Omit to use the default shell.",
    },
  },
  required: ["cmd", "max_output_tokens"],
  additionalProperties: false,
} as const;

const LEAN_EXEC_COMMAND_DESCRIPTION =
  "Runs a command in a PTY, returning output or a session ID for ongoing interaction. Pass only `cmd`, `max_output_tokens` and any argument whose value differs from its default.";

/**
 * Fill omitted `login`, `tty` and `yield_time_ms` with today's canonical
 * values. Anything that is not a JSON object, or already has the field (even as
 * `null`), is returned unchanged.
 */
export function canonicalizeLeanExecCommandInput(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return input;
  const args = parsed as Record<string, unknown>;
  let changed = false;
  const filled: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(LEAN_EXEC_COMMAND_DEFAULTS)) {
    if (!Object.hasOwn(args, key)) {
      filled[key] = value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(filled) : input;
}

/**
 * Replace the model-facing `exec_command` schema with the lean one and
 * canonicalize its arguments before every inner layer. Apply it outermost so
 * the turn-cancellation and routing wrappers see canonical arguments.
 */
export function withLeanExecCommandArguments(tools: Tool<unknown>[]): Tool<unknown>[] {
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || capabilityTool.name !== "exec_command") {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    return {
      ...capabilityTool,
      description: LEAN_EXEC_COMMAND_DESCRIPTION,
      parameters: LEAN_EXEC_COMMAND_PARAMETERS as unknown as typeof capabilityTool.parameters,
      strict: false,
      invoke: (runContext, input, details) =>
        invoke(
          runContext,
          typeof input === "string" ? canonicalizeLeanExecCommandInput(input) : input,
          details,
        ),
    };
  });
}
