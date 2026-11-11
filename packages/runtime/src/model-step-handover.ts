import { MaxTurnsExceededError, type RunErrorHandlers } from "@openai/agents";

/**
 * A host's model-call admission throws this to end the run at a model-step
 * boundary: the previous step (its response, tool calls and tool results) is
 * complete and the next request has not left the worker.
 *
 * The SDK routes it through its run error handlers like a turn cap, so the
 * run finishes normally with an empty, history-excluded final output. Every
 * event the SDK already queued for the finished step still reaches the
 * stream consumer; a plain thrown error would error the stream and drop them.
 * The host recognizes the yield by its own flag, never by this output.
 */
export class ModelStepHandover extends MaxTurnsExceededError {
  constructor(reason: string) {
    super(`Model step handover: ${reason}`);
    this.name = "ModelStepHandover";
  }
}

/** Run error handlers that finish a run cleanly on a {@link ModelStepHandover}. */
export function withModelStepHandover(
  handlers?: RunErrorHandlers<any, any>,
): RunErrorHandlers<any, any> {
  const delegate = handlers?.maxTurns ?? handlers?.default;
  return {
    ...handlers,
    maxTurns: async (args) => {
      if (args.error instanceof ModelStepHandover) {
        return { finalOutput: "", includeInHistory: false };
      }
      return await delegate?.(args);
    },
  };
}
