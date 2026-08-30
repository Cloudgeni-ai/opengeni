import {
  CanonicalToolResult,
  type CanonicalToolResult as CanonicalToolResultValue,
} from "@opengeni/contracts";
import { serializedJsonBytes } from "./catalog";

export type CanonicalToolError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type CanonicalToolResultInspection =
  | Readonly<{ kind: "result"; result: CanonicalToolResultValue }>
  | Readonly<{ kind: "structured"; value: Record<string, unknown> }>
  | Readonly<{
      kind: "error";
      result: CanonicalToolResultValue;
      error: CanonicalToolError;
    }>
  | Readonly<{ kind: "missing_structured"; result: CanonicalToolResultValue }>;

export type CanonicalToolInvocationContext<Caller = unknown> = Readonly<{
  operationId: string;
  caller: Caller;
  transportMeta?: Record<string, unknown> | null;
  signal?: AbortSignal;
}>;

export type CanonicalToolInvoker<Caller = unknown> = (
  argumentsValue: Record<string, unknown>,
  context: CanonicalToolInvocationContext<Caller>,
) => Promise<CanonicalToolResultValue> | CanonicalToolResultValue;

export type InvokeCanonicalToolOptions = Readonly<{
  timeoutMs?: number;
  maxArgumentsBytes?: number;
  maxResultBytes?: number;
}>;

export class CanonicalToolArgumentsTooLargeError extends Error {
  readonly code = "tool_arguments_too_large";

  constructor(
    readonly actualBytes: number,
    readonly maximumBytes: number,
  ) {
    super(`Canonical tool arguments exceed the maximum size: ${actualBytes} > ${maximumBytes}`);
    this.name = "CanonicalToolArgumentsTooLargeError";
  }
}

export class CanonicalToolResultTooLargeError extends Error {
  readonly code = "tool_result_too_large";

  constructor(
    readonly actualBytes: number,
    readonly maximumBytes: number,
  ) {
    super(`Canonical tool result exceeds the maximum size: ${actualBytes} > ${maximumBytes}`);
    this.name = "CanonicalToolResultTooLargeError";
  }
}

export class CanonicalToolInvocationTimeoutError extends Error {
  readonly code = "tool_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Canonical tool invocation exceeded its ${timeoutMs}ms timeout`);
    this.name = "CanonicalToolInvocationTimeoutError";
  }
}

/** Parse and retain the exact MCP-shaped result without fabricating output. */
export function normalizeCanonicalToolResult(input: unknown): CanonicalToolResultValue {
  return CanonicalToolResult.parse(input);
}

export function assertCanonicalToolResultSize(
  result: CanonicalToolResultValue,
  maximumBytes: number,
): void {
  const actualBytes = serializedJsonBytes(result);
  if (actualBytes > maximumBytes) {
    throw new CanonicalToolResultTooLargeError(actualBytes, maximumBytes);
  }
}

export function canonicalToolResultError(
  result: CanonicalToolResultValue,
  fallbackMessage = "Tool failed",
): CanonicalToolError {
  const structured = result.structuredContent as
    | { error?: { code?: unknown; message?: unknown; retryable?: unknown } }
    | undefined;
  const error = structured?.error;
  return {
    code: typeof error?.code === "string" ? error.code : "tool_error",
    message: typeof error?.message === "string" ? error.message : fallbackMessage,
    retryable: error?.retryable === true,
  };
}

/**
 * Interpret a normalized result for a surface that either returns full MCP
 * results or requires declared structured output. Error throwing stays with
 * the caller so public error classes remain surface-specific.
 */
export function inspectCanonicalToolResult(
  result: CanonicalToolResultValue,
  options: Readonly<{
    expectsStructured: boolean;
    errorFallbackMessage?: string;
  }>,
): CanonicalToolResultInspection {
  if (result.isError) {
    return {
      kind: "error",
      result,
      error: canonicalToolResultError(result, options.errorFallbackMessage),
    };
  }
  if (!options.expectsStructured) return { kind: "result", result };
  if (!result.structuredContent) return { kind: "missing_structured", result };
  return { kind: "structured", value: result.structuredContent };
}

/** Invoke one caller-owned canonical executor with optional abort and hard bounds. */
export async function invokeCanonicalTool<Caller>(
  invoker: CanonicalToolInvoker<Caller>,
  argumentsValue: Record<string, unknown>,
  context: CanonicalToolInvocationContext<Caller>,
  options: InvokeCanonicalToolOptions = {},
): Promise<CanonicalToolResultValue> {
  if (options.maxArgumentsBytes !== undefined) {
    const actualBytes = serializedJsonBytes(argumentsValue);
    if (actualBytes > options.maxArgumentsBytes) {
      throw new CanonicalToolArgumentsTooLargeError(actualBytes, options.maxArgumentsBytes);
    }
  }

  const controller = new AbortController();
  const externalSignal = context.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) throw externalSignal.reason ?? abortError();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeoutMs = options.timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      throw new RangeError("Canonical tool timeoutMs must be a positive finite number");
    }
    timeout = setTimeout(
      () => controller.abort(new CanonicalToolInvocationTimeoutError(timeoutMs)),
      timeoutMs,
    );
  }

  try {
    const invocation = Promise.resolve().then(
      async () =>
        await invoker(argumentsValue, {
          operationId: context.operationId,
          caller: context.caller,
          ...(context.transportMeta === undefined ? {} : { transportMeta: context.transportMeta }),
          signal: controller.signal,
        }),
    );
    const rawResult = await raceAbort(invocation, controller.signal);
    const result = normalizeCanonicalToolResult(rawResult);
    if (options.maxResultBytes !== undefined) {
      assertCanonicalToolResultSize(result, options.maxResultBytes);
    }
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}
