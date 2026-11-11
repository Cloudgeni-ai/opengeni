import { isModalTaskExecStartPreDispatchUnavailableError } from "./providers/modal";

/** The function tool whose one invocation starts exactly one sandbox command. */
export const COMMAND_START_TOOL_NAME = "exec_command";

const MAX_DEPTH = 8;
const MAX_NODES = 64;

/**
 * Call-scoped proof that one `exec_command` invocation never dispatched its
 * command. Only the runtime's own invocation wrapper creates it, and only around
 * the provider's typed pre-dispatch readiness proof, so the worker can settle
 * exactly this call as not started instead of unknown.
 */
export class ToolCallCommandNotStartedError extends Error {
  readonly callId: string;

  constructor(callId: string, cause: unknown) {
    super("The sandbox command was not started", { cause });
    this.name = "ToolCallCommandNotStartedError";
    this.callId = callId;
  }
}

type InvokableTool = {
  type: string;
  name: string;
  invoke?: (context: never, input: string, details?: never) => Promise<unknown>;
};

/**
 * Wrap `exec_command` so a proven pre-dispatch command-start failure carries
 * the exact call it belongs to. Every other outcome, including a rendered
 * error string or an ambiguous start, passes through unchanged.
 */
export function withCommandNotStartedCallProof<T extends InvokableTool>(tool: T): T {
  if (tool.type !== "function" || tool.name !== COMMAND_START_TOOL_NAME || !tool.invoke) {
    return tool;
  }
  const invoke = tool.invoke;
  return {
    ...tool,
    invoke: async (context: never, input: string, details?: never) => {
      try {
        return await invoke(context, input, details);
      } catch (error) {
        const callId = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall
          ?.callId;
        if (
          typeof callId === "string" &&
          callId.length > 0 &&
          isModalTaskExecStartPreDispatchUnavailableError(error)
        ) {
          throw new ToolCallCommandNotStartedError(callId, error);
        }
        throw error;
      }
    },
  };
}

/**
 * The call ids an error proves were never started. The whole error must still
 * satisfy the pre-dispatch proof: any retained or outcome-unknown boundary in
 * the same chain vetoes every call, and lookalike names never qualify.
 */
export function toolCallCommandNotStartedCallIds(error: unknown): string[] {
  if (!isModalTaskExecStartPreDispatchUnavailableError(error)) return [];
  const callIds = new Set<string>();
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: error }];
  const seen = new WeakSet<object>();
  let inspected = 0;
  while (pending.length > 0 && inspected < MAX_NODES) {
    const current = pending.shift()!;
    inspected += 1;
    if (!current.value || typeof current.value !== "object" || seen.has(current.value)) continue;
    if (current.depth > MAX_DEPTH) continue;
    seen.add(current.value);
    if (current.value instanceof ToolCallCommandNotStartedError) {
      if (isModalTaskExecStartPreDispatchUnavailableError(current.value.cause)) {
        callIds.add(current.value.callId);
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key of ["cause", "error"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor && "value" in descriptor) {
        pending.push({ depth: current.depth + 1, value: descriptor.value });
      }
    }
    const errors = Object.getOwnPropertyDescriptor(record, "errors");
    if (errors && "value" in errors && Array.isArray(errors.value)) {
      for (const nested of errors.value.slice(0, 32)) {
        pending.push({ depth: current.depth + 1, value: nested });
      }
    }
  }
  return [...callIds];
}
