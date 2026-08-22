import type { ErrorCode } from "@opengeni/contracts";
import { WorkspaceControlBusyError } from "@opengeni/db";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";

type ApiHttpErrorOptions = {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  details?: Record<string, unknown>;
};

/** A public, structured API failure whose message and details are safe for clients. */
export class ApiHttpError extends HTTPException {
  readonly code: ErrorCode;
  readonly retryable: boolean | undefined;
  readonly outcomeUnknown: boolean | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, options: ApiHttpErrorOptions) {
    super(status as ContentfulStatusCode, { message: options.message });
    this.name = "ApiHttpError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.outcomeUnknown = options.outcomeUnknown;
    this.details = options.details;
  }
}

/**
 * A request-scoped session/workspace mutation could not enter the workspace
 * control prefix within its bounded wait. The transaction rolled back before
 * any write, so the outcome is known and the client may retry. `app.onError`
 * applies this once for every route; Slack interactions keep the raw typed
 * error so their retry classifier treats it as transient.
 */
export function workspaceControlBusyHttpError(error: unknown): ApiHttpError | null {
  const busy =
    error instanceof WorkspaceControlBusyError
      ? error
      : error instanceof HTTPException && error.cause instanceof WorkspaceControlBusyError
        ? error.cause
        : null;
  if (!busy) return null;
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "The workspace is busy applying other session commands; retry shortly.",
    retryable: true,
    outcomeUnknown: false,
    details: { code: busy.code, lockTimeoutMs: busy.lockTimeoutMs },
  });
}
