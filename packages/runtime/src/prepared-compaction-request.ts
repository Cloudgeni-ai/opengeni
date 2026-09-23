import { AsyncLocalStorage } from "node:async_hooks";
import type { CallModelInputFilter, ModelRequest } from "@openai/agents";
import { findCompactionNeededError } from "./context-compaction";

/** One owner per run; never share a prefix between sessions or rebuilt agents. */
const requests = new WeakMap<object, Omit<ModelRequest, "input">>();
const dispatch = new AsyncLocalStorage<{ agent: object; pending?: unknown }>();
const queued = new WeakMap<object, unknown>();

export function queuePreparedCompaction(agent: object, error: unknown): void {
  queued.set(agent, error);
}

export function withPreparedCompactionRequest<T>(agent: object, run: () => T): T {
  const pending = queued.get(agent);
  queued.delete(agent);
  return dispatch.run({ agent, pending }, run);
}

/** Called after SDK sandbox preparation AND lazy-tool filtering, before transport. */
export function rememberPreparedModelRequest(request: ModelRequest): void {
  const scope = dispatch.getStore();
  if (!scope) return;
  const { input: _input, ...prefix } = request;
  requests.set(scope.agent, {
    ...prefix,
    tools: structuredClone(request.tools),
    modelSettings: structuredClone(request.modelSettings),
  });
  if (scope.pending) throw scope.pending;
}

export function preparedCompactionRequest(agent: object): Omit<ModelRequest, "input"> {
  const request = requests.get(agent);
  if (!request) throw new Error("Compaction requires a prepared model request");
  return request;
}

/** Finish normal preparation, but never send ordinary inference once compaction is due. */
export function deferCompactionToModelBoundary(filter: CallModelInputFilter): CallModelInputFilter {
  return async (args) => {
    try {
      return await filter(args);
    } catch (error) {
      const scope = dispatch.getStore();
      if (!scope || !findCompactionNeededError(error)) throw error;
      scope.pending = error;
      return args.modelData;
    }
  };
}
