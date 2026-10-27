import { AsyncLocalStorage } from "node:async_hooks";
import type { CallModelInputFilter, ModelRequest } from "@openai/agents";
import { findCompactionNeededError } from "./context-compaction";

/** One owner per run; never share a prefix between sessions or rebuilt agents. */
const requests = new WeakMap<object, Omit<ModelRequest, "input">>();
/**
 * The history of the ordinary request that was prepared but withheld because
 * compaction became due at that model boundary. Only a withheld request is
 * kept: it is exactly what the provider would have received next, so it covers
 * every durable item at the moment compaction starts.
 */
const withheldInputs = new WeakMap<object, Array<Record<string, unknown>>>();
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
  if (!scope.pending) {
    withheldInputs.delete(scope.agent);
    return;
  }
  // History items are immutable once in the run; copying the array is enough.
  if (Array.isArray(request.input))
    withheldInputs.set(scope.agent, [...request.input] as Array<Record<string, unknown>>);
  else withheldInputs.delete(scope.agent);
  throw scope.pending;
}

export function preparedCompactionRequest(agent: object): Omit<ModelRequest, "input"> {
  const request = requests.get(agent);
  if (!request) throw new Error("Compaction requires a prepared model request");
  return request;
}

/**
 * Take the exact history of the ordinary request withheld at the latest model
 * boundary, after every model-input filter and lazy-tool restoration. A
 * checkpoint that sends this history plus its prompt extends the previous
 * ordinary request byte for byte, so it reads the warm prompt cache. Re-deriving
 * the history from durable items instead diverges wherever the ordinary path
 * inserts or rewrites request-local items (tool disclosures, restored search
 * results), and Claude then also drops every later signed thinking block.
 * Returns undefined when no request was withheld; one compaction consumes it.
 */
export function takeWithheldCompactionInput(
  agent: object,
): Array<Record<string, unknown>> | undefined {
  const input = withheldInputs.get(agent);
  withheldInputs.delete(agent);
  return input;
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
