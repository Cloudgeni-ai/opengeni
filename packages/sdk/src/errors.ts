/** Error for a non-2xx OpenGeni API response. */
export class OpenGeniApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: string;

  constructor(status: number, body: string) {
    const decoded = decodeApiErrorBody(body);
    super(`OpenGeni API ${status}: ${decoded.message ?? (body || "(empty body)")}`);
    this.name = "OpenGeniApiError";
    this.status = status;
    this.code = decoded.code;
    this.body = body;
  }
}

function decodeApiErrorBody(body: string): { code?: string; message?: string } {
  if (!body) return {};
  try {
    const decoded: unknown = JSON.parse(body);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};
    const record = decoded as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" && record.code ? { code: record.code } : {}),
      ...(typeof record.message === "string" && record.message ? { message: record.message } : {}),
    };
  } catch {
    return {};
  }
}

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
