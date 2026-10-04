import {
  AgentConfigError,
  AllowanceExhaustedRefusal,
  ModelUnavailableError,
  ScheduledTaskTargetAccessChange,
  type ErrorCode,
} from "@opengeni/contracts";
import { isDatabaseConnectionLoss, WorkspaceControlBusyError } from "@opengeni/db";
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

export function scheduledTaskTargetAccessHttpError(error: unknown): ApiHttpError | null {
  if (!(error instanceof HTTPException) || error.status !== 409) return null;
  const result = ScheduledTaskTargetAccessChange.safeParse(error.cause);
  return result.success
    ? new ApiHttpError(409, {
        code: "conflict",
        message: error.message,
        retryable: false,
        outcomeUnknown: false,
        details: result.data,
      })
    : null;
}

/** Preserve typed admission details through the common public error envelope. */
export function allowanceExhaustedHttpError(error: unknown): ApiHttpError | null {
  if (!(error instanceof HTTPException) || error.status !== 402) return null;
  const parsed = AllowanceExhaustedRefusal.safeParse(
    error.cause && typeof error.cause === "object"
      ? Object.fromEntries(Object.entries(error.cause).filter(([key]) => key !== "allowed"))
      : error.cause,
  );
  if (!parsed.success) return null;
  const { code, message, ...details } = parsed.data;
  return new ApiHttpError(402, {
    code,
    message,
    retryable: false,
    outcomeUnknown: false,
    details,
  });
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

/** `details.code` of the retryable 503 for a request whose database connection was lost. */
export const DATABASE_UNAVAILABLE_ERROR_DETAIL_CODE = "DATABASE_UNAVAILABLE";

/**
 * The request's database connection went away (an operator drain, failover,
 * restart, or socket loss) rather than the statement being rejected. That is a
 * brief, retryable outage, not an internal error. A read is safe to repeat. A
 * mutation's outcome is unknown: the connection may have dropped after COMMIT,
 * or after an earlier transaction of the same request committed, so the client
 * must reconcile by its own idempotency key before resending.
 */
export function databaseUnavailableHttpError(error: unknown, method: string): ApiHttpError | null {
  if (error instanceof ApiHttpError) return null;
  if (error instanceof HTTPException && error.status < 500) return null;
  if (!isDatabaseConnectionLoss(error)) return null;
  const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "Opengeni is temporarily unavailable. Retry shortly.",
    retryable: true,
    outcomeUnknown: !safeMethod,
    details: { code: DATABASE_UNAVAILABLE_ERROR_DETAIL_CODE },
  });
}

/**
 * A typed agent-configuration failure (capability unavailable, conflict,
 * widening, not enabled). Rendered as 422 validation_failed with the specific
 * code in `details.code` so clients can branch without parsing messages.
 */
export function agentConfigHttpError(error: unknown): ApiHttpError | null {
  const cause =
    error instanceof AgentConfigError
      ? error
      : error instanceof HTTPException && error.cause instanceof AgentConfigError
        ? error.cause
        : null;
  if (!cause) return null;
  return new ApiHttpError(422, {
    code: "validation_failed",
    message: cause.message,
    retryable: false,
    details: {
      code: cause.code,
      ...(cause.capability ? { capability: cause.capability } : {}),
    },
  });
}

/**
 * The requested or stored model is not in the live catalog. Rendered as the
 * same 422 `validation_failed` with its historical message, plus
 * `details.code: "model_unavailable"` and the model id so clients can ask for
 * another model rather than offer a retry that cannot succeed.
 */
export function modelUnavailableHttpError(error: unknown): ApiHttpError | null {
  const cause =
    error instanceof ModelUnavailableError
      ? error
      : error instanceof HTTPException && error.cause instanceof ModelUnavailableError
        ? error.cause
        : null;
  if (!cause) return null;
  return new ApiHttpError(422, {
    code: "validation_failed",
    message: cause.message,
    retryable: false,
    outcomeUnknown: false,
    details: { code: cause.code, modelId: cause.modelId },
  });
}
