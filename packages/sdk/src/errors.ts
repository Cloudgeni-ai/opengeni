/** Error for a non-2xx OpenGeni API response. */
export class OpenGeniApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  /** True only when an uncontrolled transport failed after a mutation may have been accepted. */
  readonly outcomeUnknown: boolean;
  readonly body: string;

  constructor(
    status: number,
    body: string,
    options: {
      code?: string | undefined;
      retryable?: boolean | undefined;
      correlationId?: string | undefined;
      outcomeUnknown?: boolean | undefined;
      displayMessage?: string | undefined;
    } = {},
  ) {
    const decoded = decodeApiErrorBody(body);
    const correlationId = boundedCorrelationId(options.correlationId ?? decoded.requestId);
    const message = decoded.message ?? (body || "(empty body)");
    super(
      withCorrelation(
        options.displayMessage ?? `OpenGeni API ${status}: ${message}`,
        correlationId,
      ),
    );
    this.name = "OpenGeniApiError";
    this.status = status;
    this.code = options.code ?? decoded.code;
    this.retryable = options.retryable ?? retryableApiStatus(status);
    this.correlationId = correlationId;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.body = body;
  }
}

function decodeApiErrorBody(body: string): {
  code?: string;
  message?: string;
  requestId?: string;
} {
  if (!body) return {};
  try {
    const decoded: unknown = JSON.parse(body);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
    const record = decoded as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : record;
    return {
      ...(typeof nested.code === "string" && nested.code ? { code: nested.code } : {}),
      ...(typeof nested.message === "string" && nested.message ? { message: nested.message } : {}),
      ...(typeof nested.requestId === "string" && nested.requestId
        ? { requestId: nested.requestId }
        : {}),
    };
  } catch {
    return {};
  }
}

function retryableApiStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function boundedCorrelationId(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) return undefined;
  return value;
}

function withCorrelation(message: string, correlationId: string | undefined): string {
  return correlationId ? `${message} Reference: ${correlationId}.` : message;
}

/** A short-lived session-list snapshot cursor can no longer be continued. */
export class OpenGeniSessionListCursorError extends OpenGeniApiError {}

/** The browser bundle and API disagree about their state-changing wire contract. */
export class OpenGeniApiContractMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`OpenGeni API contract mismatch: client expects ${expected}, API serves ${actual}`);
    this.name = "OpenGeniApiContractMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Error for an unrecoverable event-stream condition (not a transient drop). */
export class OpenGeniStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenGeniStreamError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Transient conditions worth a reconnect: network-level failures (`fetch`
 * rejects with `TypeError`) and HTTP statuses that signal a temporary server
 * or contention condition. Auth/validation failures (401/403/404/...) are
 * permanent and surface to the caller instead.
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof OpenGeniApiError) {
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError;
}
