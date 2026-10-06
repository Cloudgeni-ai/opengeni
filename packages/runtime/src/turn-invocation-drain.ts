import type { MCPServer, Tool } from "@openai/agents";

/** Local invocation ownership only. Draining these promises proves that their
 * host callbacks have stopped; it does not prove remote actions or native
 * processes have exited. The native journal/DB writer gate owns that evidence. */
export type TurnInvocationDrain = {
  assertOpen(): void;
  run<T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(reason?: unknown): void;
  waitForDrain(): Promise<void>;
};

export function createTurnInvocationDrain(signal?: AbortSignal): TurnInvocationDrain {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const assertOpen = () => {
    controller.signal.throwIfAborted();
    if (closed) throw new Error("Turn invocation admission is closed");
  };
  const cancel = (reason: unknown = new Error("TURN_ATTEMPT_FINALIZED")) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    controller.abort(reason);
  };
  const onAbort = () => cancel(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    assertOpen,
    run: <T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      try {
        assertOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      // Register before the callback can run, including synchronous reentry.
      // Closing admission in the same tick prevents this dispatch altogether.
      const operation = Promise.resolve().then(() => {
        assertOpen();
        return invoke(controller.signal);
      });
      pending.add(operation);
      return operation.finally(() => pending.delete(operation));
    },
    cancel,
    waitForDrain: async () => {
      if (!closed) throw new Error("Invocation drain requires closed admission");
      // No timeout, signal race or error renderer can detach an owned callback.
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}

export function invocationDrainedTools<T>(tools: Tool<T>[], drain: TurnInvocationDrain): Tool<T>[] {
  return tools.map((tool) => {
    if (tool.type !== "function") return tool;
    const invoke = tool.invoke;
    return {
      ...tool,
      invoke: (context, input, details) =>
        drain.run((signal) =>
          invoke(context, input, {
            ...details,
            signal: details?.signal ? AbortSignal.any([signal, details.signal]) : signal,
          }),
        ),
    };
  });
}

/** Keep the server's actual receiver, private fields, result metadata and
 * existing authorization/error policy. The proxy owns only invocation lifetime
 * and forwards cancellation through the SDK's documented call options. */
export function invocationDrainedMcpServer<T extends MCPServer>(
  server: T,
  drain: TurnInvocationDrain,
): T {
  const methods = new Map<PropertyKey, { original: Function; bound: Function }>();
  return new Proxy(server, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const prior = methods.get(key);
      if (prior?.original === value) return prior.bound;
      const bound =
        key === "callTool" || key === "callToolResult"
          ? (...args: unknown[]) =>
              drain.run(async (signal) => {
                const options = args[3] as { signal?: AbortSignal } | undefined;
                return await value.apply(target, [
                  args[0],
                  args[1],
                  args[2],
                  {
                    ...options,
                    signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
                  },
                ]);
              })
          : value.bind(target);
      methods.set(key, { original: value, bound });
      return bound;
    },
  });
}
