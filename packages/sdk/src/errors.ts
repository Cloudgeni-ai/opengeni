/** Error for a non-2xx OpenGeni API response. */
export class OpenGeniApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: string) {
    const parsed = parseErrorEnvelope(body);
    // Preserve the historical message/body surface for all existing callers;
    // typed envelope fields are additive and must not rewrite unrelated errors.
    super(`OpenGeni API ${status}: ${body || "(empty body)"}`);
    this.name = "OpenGeniApiError";
    this.status = status;
    this.body = body;
    this.code = parsed?.code ?? null;
    this.details = parsed?.details ?? null;
  }
}

function parseErrorEnvelope(
  body: string,
): { code: string; message: string; details: Record<string, unknown> | null } | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object") return null;
    const error = (value as Record<string, unknown>)["error"];
    if (!error || typeof error !== "object") return null;
    const record = error as Record<string, unknown>;
    if (typeof record["code"] !== "string" || typeof record["message"] !== "string") return null;
    const details = record["details"];
    return {
      code: record["code"],
      message: record["message"],
      details: details && typeof details === "object" ? (details as Record<string, unknown>) : null,
    };
  } catch {
    return null;
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
