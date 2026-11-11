import { FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/**
 * A first-party tool refusing the caller's arguments before doing any work:
 * a bad combination of fields, a malformed cursor, an ID that names nothing.
 * The message is exactly what the caller sees, as for any thrown error. It is
 * recorded as a `rejected` tool call, not as a tool failure.
 */
export class ToolArgumentError extends Error {
  override name = "ToolArgumentError";
}

/** HTTP statuses that mean the request itself was invalid. */
const ARGUMENT_REJECTION_STATUSES = new Set([400, 422]);

/**
 * Whether a tool's error is a refusal of the caller's arguments: a
 * {@link ToolArgumentError}, or an API 400/422 (also when re-thrown as the
 * cause of a plain error that keeps its message).
 */
export function isToolArgumentRejection(error: unknown): boolean {
  if (error instanceof ToolArgumentError) return true;
  if (error instanceof HTTPException) return ARGUMENT_REJECTION_STATUSES.has(error.status);
  return (
    error instanceof Error &&
    error.cause instanceof HTTPException &&
    error.cause.message === error.message &&
    ARGUMENT_REJECTION_STATUSES.has(error.cause.status)
  );
}

/**
 * The MCP SDK refuses arguments that do not match a tool's input schema before
 * the tool runs, and turns that into an error result carrying only this
 * message (`McpServer.validateToolInput`, an InvalidParams McpError). An
 * unknown or disabled tool is refused with the same code but is not matched.
 */
const SDK_ARGUMENT_REJECTION =
  /^(?:MCP error -32602: )?(?:Input validation error: )?Invalid arguments for tool /u;

export function isSdkToolArgumentRejectionMessage(message: string): boolean {
  return SDK_ARGUMENT_REJECTION.test(message);
}

/** Mark an error result as an argument rejection. Its content, the only part
 * the model sees, stays exactly as it was. */
export function markToolArgumentRejection<T extends object>(
  result: T,
): T & { _meta: Record<string, unknown> } {
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  return { ...result, _meta: { ...meta, [FIRST_PARTY_TOOL_ARGUMENT_REJECTED_META_KEY]: true } };
}

/** The error result the MCP SDK makes from a thrown error, marked as an
 * argument rejection. */
export function toolArgumentRejectionResult(error: Error) {
  return markToolArgumentRejection({
    content: [{ type: "text" as const, text: error.message }],
    isError: true as const,
  });
}
