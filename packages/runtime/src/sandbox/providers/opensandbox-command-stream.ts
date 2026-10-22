import { DefaultAdapterFactory, type AdapterFactory } from "@alibaba-group/opensandbox";
import { AsyncLocalStorage } from "node:async_hooks";

type Commands = ReturnType<AdapterFactory["createExecdStack"]>["commands"];
const defaultCreateExecdStack = DefaultAdapterFactory.prototype.createExecdStack;
const boundDefaultCommands = new WeakMap<Commands, Pick<Commands, "run" | "runStream">>();
const commandDispatch = new AsyncLocalStorage<{ attempted: boolean }>();

/** Local proof from the actual command invocation and its bound wire seam,
 * never inferred from provider status codes, error text or a missing init. */
export class OpenSandboxCommandDispatchError extends Error {
  constructor(
    readonly notDispatched: boolean,
    cause: unknown,
  ) {
    super(
      notDispatched
        ? "OpenSandbox command was not dispatched"
        : "OpenSandbox command dispatch is uncertain",
      { cause },
    );
    this.name = "OpenSandboxCommandDispatchError";
  }
}

export async function withOpenSandboxCommandDispatchProof<T>(
  commands: Commands,
  invoke: () => Promise<T>,
): Promise<T> {
  const bound = boundDefaultCommands.get(commands);
  const trusted =
    bound !== undefined && bound.run === commands.run && bound.runStream === commands.runStream;
  const state = { attempted: false };
  return await commandDispatch.run(state, async () => {
    try {
      return await invoke();
    } catch (cause) {
      // A custom adapter can bypass this fetch entirely. Its absence is never
      // no-dispatch proof; only an unchanged, genuinely bound default SDK path
      // that failed before invoking the command transport can grant that proof.
      throw new OpenSandboxCommandDispatchError(trusted && !state.attempted, cause);
    }
  });
}

/** A successful command HTTP response was accepted, but its event stream no
 * longer proves complete output or exit. It is not proof of an unstarted op. */
export class OpenSandboxCommandStreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`OpenSandbox command stream is uncertain: ${message}`, { cause });
    this.name = "OpenSandboxCommandStreamError";
  }
}

/** Decode complete wire lines, not whole transport chunks: a corrupt later
 * line must not erase an earlier authenticated init in the same HTTP chunk. */
async function* wireLines(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts: Uint8Array[] = [];
  let skipLf = false;
  let first = true;
  const decode = () => {
    let line = decoder.decode(Buffer.concat(parts));
    parts = [];
    if (first) line = line.replace(/^\uFEFF/u, "");
    first = false;
    return line;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
      const byte = value[index];
      if (skipLf) {
        skipLf = false;
        if (byte === 10) {
          start = index + 1;
          continue;
        }
      }
      if (byte !== 10 && byte !== 13) continue;
      parts.push(value.subarray(start, index));
      yield { line: decode(), terminated: true };
      skipLf = byte === 13;
      start = index + 1;
    }
    if (start < value.length) parts.push(value.subarray(start));
  }
  if (parts.length) yield { line: decode(), terminated: false };
}

/** The SDK coerces these fields with String(), which can turn an array value
 * into a successful exit code. Validate the wire DTO before that conversion.
 * Fields are optional in the provider schema; supplied aliases must agree. */
function assertCommandError(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid command error envelope");
  const error = value as Record<string, unknown>;
  let recognized = false;
  for (const [primary, alias] of [
    ["ename", "name"],
    ["evalue", "value"],
  ] as const) {
    for (const field of [primary, alias]) {
      if (error[field] === undefined) continue;
      recognized = true;
      if (typeof error[field] !== "string") throw new Error("invalid command error field");
    }
    if (
      error[primary] !== undefined &&
      error[alias] !== undefined &&
      error[primary] !== error[alias]
    )
      throw new Error("contradictory command error aliases");
  }
  if (error.traceback !== undefined) {
    recognized = true;
    if (!Array.isArray(error.traceback) || error.traceback.some((line) => typeof line !== "string"))
      throw new Error("invalid command error traceback");
  }
  if (!recognized) throw new Error("empty command error DTO");
}

async function* commandFrames(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new OpenSandboxCommandStreamError("missing response body");
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  let data: string[] = [];
  let executionId: string | null = null;
  let completed = false;
  let eof = false;
  // The SDK supports SSE and NDJSON independently of the response MIME type.
  let mode: "sse" | "ndjson" | null = null;
  const frame = (json: string) => {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid command event envelope");
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string") throw new Error("missing command event type");
    if (event.type === "init") {
      if (typeof event.text !== "string" || !event.text.trim())
        throw new Error("missing execution identity");
      if (executionId !== null && event.text !== executionId)
        throw new Error("contradictory execution identity");
      executionId = event.text;
    }
    for (const field of ["id", "execution_id", "executionId"] as const) {
      if (event[field] !== undefined && event[field] !== executionId)
        throw new Error("contradictory event identity");
    }
    if ((event.type === "stdout" || event.type === "stderr") && typeof event.text !== "string")
      throw new Error("invalid command output");
    if (event.type === "error") assertCommandError(event.error);
    if (event.type === "execution_complete") {
      if (executionId === null) throw new Error("completion without execution identity");
      completed = true;
    }
    // The pinned SDK accepts one JSON value per data line, but not legal SSE
    // multiline JSON. Canonicalizing only framing preserves every text value.
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    for await (const { line, terminated } of wireLines(reader)) {
      if (mode === null && line && !line.startsWith(":"))
        mode = line.trimStart().startsWith("{") ? "ndjson" : "sse";
      if (mode === "ndjson") {
        if (line.trim()) yield frame(line);
        continue;
      }
      if (!terminated && line && !line.startsWith(":")) throw new Error("truncated SSE line");
      if (line === "") {
        if (data.length) {
          const json = data.join("\n");
          data = [];
          yield frame(json);
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
      if (field === "data") data.push(value);
      // Other legal SSE fields (event/id/retry/extensions) do not alter data.
    }
    eof = true;
    if (data.length) throw new Error("truncated SSE frame");
    if (!completed) throw new Error("EOF without command completion");
  } catch (error) {
    throw error instanceof OpenSandboxCommandStreamError
      ? error
      : new OpenSandboxCommandStreamError("invalid or incomplete events", error);
  } finally {
    if (!eof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function strictCommandFetch(original: typeof fetch): typeof fetch {
  const wrapped = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const isCommand =
      (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() ===
        "POST" && new URL(url).pathname.endsWith("/command");
    // Mark BEFORE the original transport. Header loss and a non-2xx response
    // do not prove that the provider refused the original mutation.
    const dispatch = commandDispatch.getStore();
    if (isCommand && dispatch) dispatch.attempted = true;
    const response = await original(input, init);
    if (!response.ok || !isCommand) return response;
    if (!response.body) throw new OpenSandboxCommandStreamError("missing response body");
    const frames = commandFrames(response);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await frames.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await frames.return(undefined);
        },
      },
      // Do not observe later errors ahead of the SDK consuming a valid page.
      { highWaterMark: 0 },
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "text/event-stream");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }) as typeof fetch;
  return wrapped;
}

/** Public factory/config seams only. The SDK still owns request construction,
 * headers, dispatch, HTTP errors and event callbacks. No start is repeated. */
export function withOpenSandboxCommandStreamProof(factory: AdapterFactory): AdapterFactory {
  return {
    createLifecycleStack: (options) => factory.createLifecycleStack(options),
    createEgressStack: (options) => factory.createEgressStack(options),
    createExecdStack(options) {
      const sseFetch = strictCommandFetch(options.connectionConfig.sseFetch);
      const createExecdStack = factory.createExecdStack;
      const stack = createExecdStack.call(factory, {
        ...options,
        connectionConfig: new Proxy(options.connectionConfig, {
          get(target, property) {
            return property === "sseFetch" ? sseFetch : Reflect.get(target, property, target);
          },
        }),
      });
      if (createExecdStack === defaultCreateExecdStack) {
        // The public default constructor binds THIS sseFetch to its commands.
        // Delegating/custom factory methods are not assumed to do the same.
        boundDefaultCommands.set(stack.commands, {
          run: stack.commands.run,
          runStream: stack.commands.runStream,
        });
      }
      return stack;
    },
  };
}
