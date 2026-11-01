/**
 * Lean model-facing `exec_command` arguments.
 *
 * Gated by settings.experimentOutputCost (on by default; kill switch
 * `OPENGENI_EXPERIMENT_OUTPUT_COST=false` in the worker environment).
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
 *
 * The `tty` hint names `write_stdin` only when the same tool list offers it.
 * Sessions whose backend runs commands without stdin (Connected Machines and
 * several cloud providers) get no `write_stdin`, so the hint there must not
 * point at a tool the model cannot call. Both variants are fixed strings and
 * depend only on whether `write_stdin` is in the list, which is stable for a
 * session's placement, so the tool block changes only when the placement does.
 *
 * With the turn-cancellation finish floor (cut polling, see
 * COMMAND_FINISH_FLOOR_MS), the `yield_time_ms` description states that a
 * command without a TTY waits at least 60 s for its exit, and an optional
 * `background` flag keeps the requested short wait for servers, watchers and
 * deliberate parallel runs. The turn-cancellation layer reads and removes
 * `background`; the SDK never sees it. Both are fixed strings chosen once per
 * worker setting, so they do not change the tool block between calls.
 */
import type { Tool } from "@openai/agents";

/** Values filled in for omitted arguments; the dominant explicit choices today. */
export const LEAN_EXEC_COMMAND_DEFAULTS = {
  login: false,
  tty: false,
  yield_time_ms: 10_000,
} as const;

const YIELD_TIME_DESCRIPTION =
  "How long to wait (in milliseconds) for output before yielding. Omit for the default of 10000.";
const FINISH_FLOOR_YIELD_TIME_DESCRIPTION =
  "How long to wait (in milliseconds) for the command to finish. It returns as soon as the command exits, or with a session ID if it is still running. Without `tty` or `background` the wait is at least 60000. Omit for the default of 10000.";
const BACKGROUND_DESCRIPTION =
  "Return after yield_time_ms even if the command is still running, and keep it running in the background: for servers, watchers and commands you run in parallel. Omit for the default of false.";

function leanExecCommandParameters(ttyDescription: string, finishFloor: boolean) {
  return {
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
        description: finishFloor ? FINISH_FLOOR_YIELD_TIME_DESCRIPTION : YIELD_TIME_DESCRIPTION,
      },
      ...(finishFloor
        ? { background: { type: "boolean", description: BACKGROUND_DESCRIPTION } }
        : {}),
      workdir: {
        type: "string",
        description: "Working directory for the command. Omit to use the turn cwd.",
      },
      tty: { type: "boolean", description: ttyDescription },
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
}

const TTY_WITH_WRITE_STDIN_DESCRIPTION =
  "Allocate a TTY (needed to interrupt the process later with Ctrl-C through write_stdin). Omit for the default of false.";
const TTY_DESCRIPTION = "Allocate a TTY. Omit for the default of false.";

/** The lean schema when the same tool list offers `write_stdin`. */
export const LEAN_EXEC_COMMAND_PARAMETERS = leanExecCommandParameters(
  TTY_WITH_WRITE_STDIN_DESCRIPTION,
  true,
);

/** The lean schema when the session runs commands without stdin. */
export const LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN = leanExecCommandParameters(
  TTY_DESCRIPTION,
  true,
);

/** The two lean schemas when the finish floor is off (cut polling disabled). */
export const LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_FINISH_FLOOR = leanExecCommandParameters(
  TTY_WITH_WRITE_STDIN_DESCRIPTION,
  false,
);
export const LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN_OR_FINISH_FLOOR =
  leanExecCommandParameters(TTY_DESCRIPTION, false);

const LEAN_EXEC_COMMAND_DESCRIPTION =
  "Runs a shell command, returning output or a session ID for ongoing interaction. Pass only `cmd`, `max_output_tokens` and any argument whose value differs from its default.";

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
export function withLeanExecCommandArguments(
  tools: Tool<unknown>[],
  options: { finishFloor?: boolean } = {},
): Tool<unknown>[] {
  const writeStdin = tools.some((tool) => tool.name === "write_stdin");
  const parameters =
    options.finishFloor === false
      ? writeStdin
        ? LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_FINISH_FLOOR
        : LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN_OR_FINISH_FLOOR
      : writeStdin
        ? LEAN_EXEC_COMMAND_PARAMETERS
        : LEAN_EXEC_COMMAND_PARAMETERS_WITHOUT_WRITE_STDIN;
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || capabilityTool.name !== "exec_command") {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    return {
      ...capabilityTool,
      description: LEAN_EXEC_COMMAND_DESCRIPTION,
      parameters: parameters as unknown as typeof capabilityTool.parameters,
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
