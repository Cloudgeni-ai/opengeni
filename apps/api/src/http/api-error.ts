import {
  AgentConfigError,
  AllowanceExhaustedRefusal,
  ModelUnavailableError,
  ScheduledTaskTargetAccessChange,
  type ErrorCode,
} from "@opengeni/contracts";
import {
  isDatabaseConnectionLoss,
  SessionUsageLimitUnavailableError,
  nestedPostgresSqlState,
  WorkspaceControlBusyError,
} from "@opengeni/db";
import { SessionUsageLimitHttpError, sessionUsageLimitRefusalFromError } from "@opengeni/core";
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

const SESSION_USAGE_LIMIT_ERROR_CODES: Record<SessionUsageLimitHttpError["code"], ErrorCode> = {
  session_usage_limit_conflict: "conflict",
  session_usage_limit_not_root: "conflict",
  session_usage_limit_preparing: "conflict",
  session_usage_limit_disabled: "validation_failed",
  session_usage_limit_forbidden: "forbidden",
  session_usage_limit_unavailable: "upstream_unavailable",
  session_not_found: "not_found",
};

/**
 * Per-task usage limits (OPE-798). A reached root limit is a non-retryable 402
 * `session_usage_limit_reached` whose details carry only the public refusal
 * fields; it is never `allowance_exhausted`, `payment_required` or a purchase
 * prompt. Limit writes map to stable `details.code` values. Unreadable usage
 * state is a retryable 503 that was not applied (never unlimited).
 */
export function sessionUsageLimitHttpError(error: unknown): ApiHttpError | null {
  const refusal = sessionUsageLimitRefusalFromError(error);
  if (refusal) {
    return new ApiHttpError(402, {
      code: "session_usage_limit_reached",
      message: refusal.message,
      retryable: false,
      outcomeUnknown: false,
      details: {
        basis: refusal.basis,
        rootSessionId: refusal.rootSessionId,
        limitMicros: refusal.limitMicros,
        usedMicros: refusal.usedMicros,
      },
    });
  }
  if (error instanceof SessionUsageLimitHttpError) {
    return new ApiHttpError(error.status, {
      code: SESSION_USAGE_LIMIT_ERROR_CODES[error.code],
      message: error.message,
      retryable: error.code === "session_usage_limit_unavailable",
      outcomeUnknown: false,
      details: { ...error.details, code: error.code },
    });
  }
  const unavailable =
    error instanceof SessionUsageLimitUnavailableError
      ? error
      : error instanceof HTTPException && error.cause instanceof SessionUsageLimitUnavailableError
        ? error.cause
        : null;
  if (unavailable) {
    return new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: "Usage for this task is temporarily unavailable. Try again shortly.",
      retryable: true,
      outcomeUnknown: false,
      details: { code: "session_usage_limit_unavailable" },
    });
  }
  return null;
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

/** `details.code` of the retryable 503 for a deadlock/serialization victim. */
export const DATABASE_CONTENTION_ERROR_DETAIL_CODE = "DATABASE_CONTENTION";

/**
 * PostgreSQL aborted the request's transaction as a deadlock (40P01) or
 * serialization (40001) victim after any in-process retry was exhausted. The
 * aborted transaction committed nothing, so this is transient contention, not
 * an internal error. A read is safe to repeat. For a mutation the default is
 * `outcomeUnknown` because an earlier transaction of the same request may have
 * committed; a route whose only write is the aborted idempotent transaction
 * passes `outcomeUnknown: false`.
 */
export function databaseContentionHttpError(
  error: unknown,
  method: string,
  options: { outcomeUnknown?: boolean } = {},
): ApiHttpError | null {
  if (error instanceof ApiHttpError) return null;
  if (error instanceof HTTPException && error.status < 500) return null;
  const sqlState = nestedPostgresSqlState(error);
  if (sqlState !== "40P01" && sqlState !== "40001") return null;
  const safeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "Opengeni hit transient database contention. Retry shortly.",
    retryable: true,
    outcomeUnknown: options.outcomeUnknown ?? !safeMethod,
    details: { code: DATABASE_CONTENTION_ERROR_DETAIL_CODE, sqlState },
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
