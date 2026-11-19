/**
 * `then` on the model-facing function `apply_patch`.
 *
 * An edit is almost always followed by a check (tests, a build, a type check)
 * in the next model step, and edits are rarely batched with other calls. `then`
 * lets the model name that command in the edit call itself: it runs once,
 * after the patch applied, and its result follows the patch result in the
 * same tool output. That saves the round trip (and the re-sent context) of a
 * separate step.
 *
 * Execution parity: the command goes through this capability set's own final
 * `exec_command` tool, so it gets exactly what `exec_command` gets: the lean
 * argument defaults, turn cancellation and Steer handling, the finish floor,
 * secret references and the git leak guard (#7784), routed-call containment,
 * the provider and its output truncation, and the tool's approval policy. It
 * runs inside the `apply_patch` call, which the runner executes exclusively and
 * in model order (#4672), so nothing from the same response overlaps it.
 *
 * Safety rules:
 * - It runs only when every patch operation reported "Patch applied.". Any
 *   other patch result (a parse error, a failed hunk, a refused secret
 *   reference) leaves it unrun and says so.
 * - The command gets its own call id (`<callId>:then`). A failure the shell
 *   path reports by throwing (for example a provider's pre-dispatch refusal)
 *   is rendered into this call's result instead of propagating, because the
 *   patch has already changed files: the edit call must never be settled as
 *   "not started" and replayed. A turn cancellation still propagates.
 * - The hosted `apply_patch` tool type has no extra arguments; only the
 *   function variant offers `then`.
 */
import type { Tool } from "@openai/agents";
import { TurnSandboxCommandCancelledError } from "./sandbox/turn-tool-cancellation";

type FunctionTool = Extract<Tool<unknown>, { type: "function" }>;
type Invoke = FunctionTool["invoke"];
type InvokeDetails = Parameters<Invoke>[2];

/** Model-facing description of the `then` argument. */
export const APPLY_PATCH_THEN_DESCRIPTION =
  "Optional shell command, run like exec_command after the patch applies, such as the test or build you'd run right after this edit. Leave it out if you'll keep editing first. Its exit code, wall time and output are returned with the patch result. It doesn't run if the patch fails.";

export const APPLY_PATCH_THEN_PARAMETER = {
  type: "string",
  description: APPLY_PATCH_THEN_DESCRIPTION,
} as const;

/** Separates the patch result from the command result in one tool output. */
const THEN_HEADER = "then:";

export type ApplyPatchThenInput = {
  /** The arguments to forward to the patch tool, without `then`. */
  patchInput: string;
  /** The command to run after a successful patch. */
  command: string | null;
  /** Set when `then` was supplied but is not a usable command. */
  invalid: string | null;
};

/**
 * Split `then` from the apply_patch arguments. Anything that is not a JSON
 * object, or has no `then`, is returned unchanged. A null or blank `then` is
 * treated as absent.
 */
export function splitApplyPatchThenInput(input: string): ApplyPatchThenInput {
  const unchanged = { patchInput: input, command: null, invalid: null };
  if (!input.includes('"then"')) return unchanged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return unchanged;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unchanged;
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, "then")) return unchanged;
  const { then, ...rest } = record;
  const patchInput = JSON.stringify(rest);
  if (then === null || then === undefined || (typeof then === "string" && !then.trim())) {
    return { patchInput, command: null, invalid: null };
  }
  if (typeof then !== "string") {
    return { patchInput, command: null, invalid: "`then` must be a string command" };
  }
  return { patchInput, command: then, invalid: null };
}

/** True only when every patch operation reported success. */
export function applyPatchSucceeded(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === "Patch applied.");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function withThenNote(patchOutput: unknown, note: string): string {
  return `${outputText(patchOutput)}\n\n${THEN_HEADER} ${note}`;
}

function thenDetails(details: InvokeDetails, execInput: string): InvokeDetails {
  const toolCall = details?.toolCall;
  if (!details || !toolCall) return details;
  return {
    ...details,
    toolCall: {
      ...toolCall,
      callId: `${toolCall.callId}:then`,
      ...("id" in toolCall && typeof toolCall.id === "string" ? { id: `${toolCall.id}:then` } : {}),
      name: "exec_command",
      arguments: execInput,
    },
  } as InvokeDetails;
}

/**
 * Wrap the function `apply_patch` so a `then` command runs after a successful
 * patch through `resolveExec()`, the session's final `exec_command` tool.
 */
export function withApplyPatchThen(
  tools: Tool<unknown>[],
  resolveExec: () => FunctionTool | null,
): Tool<unknown>[] {
  return tools.map((capabilityTool) => {
    if (capabilityTool.type !== "function" || capabilityTool.name !== "apply_patch") {
      return capabilityTool;
    }
    const invoke = capabilityTool.invoke;
    return {
      ...capabilityTool,
      invoke: async (runContext, input, details) => {
        if (typeof input !== "string") return await invoke(runContext, input, details);
        const split = splitApplyPatchThenInput(input);
        if (split.command === null && split.invalid === null && split.patchInput === input) {
          return await invoke(runContext, input, details);
        }
        const patchOutput = await invoke(runContext, split.patchInput, details);
        if (split.invalid) return withThenNote(patchOutput, `not run: ${split.invalid}.`);
        if (split.command === null) return patchOutput;
        if (!applyPatchSucceeded(patchOutput)) {
          return withThenNote(patchOutput, "not run because the patch did not apply.");
        }
        const exec = resolveExec();
        if (!exec) {
          return withThenNote(
            patchOutput,
            "not run because shell commands are unavailable in this session.",
          );
        }
        const execArguments = { cmd: split.command, login: false, tty: false };
        const execInput = JSON.stringify(execArguments);
        const callDetails = thenDetails(details, execInput);
        try {
          if (
            await exec.needsApproval(
              runContext,
              execArguments as never,
              callDetails?.toolCall?.callId,
            )
          ) {
            return withThenNote(
              patchOutput,
              "not run because this command needs approval; run it with exec_command.",
            );
          }
          const result = await exec.invoke(runContext, execInput, callDetails);
          return `${outputText(patchOutput)}\n\n${THEN_HEADER}\n${outputText(result)}`;
        } catch (error) {
          if (error instanceof TurnSandboxCommandCancelledError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return withThenNote(
            patchOutput,
            `the command could not be run (${message}). The patch was applied; check the workspace before running the command again with exec_command.`,
          );
        }
      },
    };
  });
}

type CapabilityLike = {
  bind(session: unknown): unknown;
  tools(): Tool<unknown>[];
};

/**
 * Connect a filesystem capability's `apply_patch` to the `exec_command` of the
 * shell capability bound to the same session. Call it after every other tool
 * wrapper is installed, so `then` uses the outermost `exec_command` and
 * `apply_patch` strips `then` before any inner layer parses the patch.
 *
 * The SDK binds per-run clones of each capability; `clone()` copies these
 * own-property overrides. Filesystem may bind a view of the session (HEIF
 * images), so the session it was bound with is recorded per clone here.
 */
export function linkApplyPatchThen(filesystem: CapabilityLike, shell: CapabilityLike): void {
  const boundSessions = new WeakMap<object, object>();
  const execBySession = new WeakMap<object, FunctionTool>();

  const shellTools = shell.tools;
  shell.tools = function (this: CapabilityLike & { _session?: unknown }) {
    const tools = shellTools.call(this);
    const exec = tools.find(
      (candidate): candidate is FunctionTool =>
        candidate.type === "function" && candidate.name === "exec_command",
    );
    if (exec && this._session && typeof this._session === "object") {
      execBySession.set(this._session, exec);
    }
    return tools;
  };

  const filesystemBind = filesystem.bind;
  filesystem.bind = function (this: CapabilityLike, session: unknown) {
    if (session && typeof session === "object") boundSessions.set(this, session);
    return filesystemBind.call(this, session);
  };

  const filesystemTools = filesystem.tools;
  filesystem.tools = function (this: CapabilityLike) {
    const session = boundSessions.get(this);
    return withApplyPatchThen(filesystemTools.call(this), () =>
      session ? (execBySession.get(session) ?? null) : null,
    );
  };
}
