/** Error for a non-2xx OpenGeni API response. */
export class OpenGeniApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;
  /** True only when an uncontrolled transport failed after a mutation may have been accepted. */
  readonly outcomeUnknown: boolean;
  readonly body: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    body: string,
    options: {
      code?: string | undefined;
      retryable?: boolean | undefined;
      correlationId?: string | undefined;
      outcomeUnknown?: boolean | undefined;
      displayMessage?: string | undefined;
      mutation?: boolean | undefined;
    } = {},
  ) {
    const decoded = decodeApiErrorBody(body);
    const correlationId = decoded?.requestId ?? boundedCorrelationId(options.correlationId);
    const gatewayFailure = status >= 502 && status <= 504;
    const fromResponse = options.mutation !== undefined;
    const message = decoded?.message ?? (fromResponse ? "Request failed." : body || "(empty body)");
    const displayMessage =
      options.displayMessage ??
      (gatewayFailure && fromResponse
        ? (decoded?.message ?? "OpenGeni is temporarily unavailable — retry.")
        : `OpenGeni API ${status}: ${message}`);
    super(correlationId ? `${displayMessage} Reference: ${correlationId}.` : displayMessage);
    this.name = "OpenGeniApiError";
    this.status = status;
    this.code =
      options.code ??
      decoded?.code ??
      (gatewayFailure && fromResponse ? "upstream_unavailable" : undefined);
    this.retryable = options.retryable ?? decoded?.retryable ?? retryableApiStatus(status);
    this.correlationId = correlationId;
    this.outcomeUnknown =
      options.outcomeUnknown ??
      decoded?.outcomeUnknown ??
      (gatewayFailure && !!options.mutation && !decoded);
    this.body = !fromResponse || decoded ? body : "";
    this.details = decoded?.details;
  }
}

export type OpenGeniSecureContextRequiredReason = "insecure_context" | "web_crypto_unavailable";

/**
 * A browser operation requires secure-context-only platform capabilities.
 * Callers may key UI behavior on the stable `secure_context_required` code;
 * `reason` exists only to keep the human guidance truthful.
 */
export class OpenGeniSecureContextRequiredError extends Error {
  readonly code = "secure_context_required" as const;
  readonly retryable = false;
  readonly reason: OpenGeniSecureContextRequiredReason;

  constructor(reason: OpenGeniSecureContextRequiredReason) {
    super(
      reason === "insecure_context"
        ? "Couldn’t attach this file because OpenGeni is open over HTTP. Attachments require a secure HTTPS connection. Open the secure site or configure HTTPS for this deployment."
        : "Couldn’t attach this file because secure browser cryptography is unavailable. Attachments require HTTPS and Web Crypto support. Open a secure site in a supported browser or configure HTTPS for this deployment.",
    );
    this.name = "OpenGeniSecureContextRequiredError";
    this.reason = reason;
  }
}

function decodeApiErrorBody(body: string): {
  code: string | undefined;
  message: string | undefined;
  requestId: string | undefined;
  retryable: boolean | undefined;
  outcomeUnknown: boolean | undefined;
  details: Record<string, unknown> | undefined;
} | null {
  if (!body) return null;
  try {
    const decoded: unknown = JSON.parse(body);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : record;
    const code = boundedApiField(nested.code);
    const message = boundedApiField(nested.message);
    const requestId = boundedCorrelationId(nested.requestId);
    const retryable = typeof nested.retryable === "boolean" ? nested.retryable : undefined;
    const outcomeUnknown =
      typeof nested.outcomeUnknown === "boolean" ? nested.outcomeUnknown : undefined;
    const details = boundedApiDetails(nested.details);
    if (
      !code &&
      !message &&
      !requestId &&
      retryable === undefined &&
      outcomeUnknown === undefined &&
      !details
    )
      return null;
    return {
      code,
      message,
      requestId,
      retryable,
      outcomeUnknown,
      details,
    };
  } catch {
    return null;
  }
}

function boundedApiDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
  const details: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (!/^[a-zA-Z][\w.-]{0,63}$/.test(key)) continue;
    if (typeof entry === "string") {
      const bounded = boundedApiField(entry);
      if (bounded !== undefined) details[key] = bounded;
    } else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) {
      details[key] = entry;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function boundedApiField(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= 512 ? value : new TextDecoder().decode(bytes.slice(0, 512));
}

function retryableApiStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function boundedCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128 || !/^[\w.:-]+$/.test(value)) {
    return;
  }
  return value;
}

/** A legacy short-lived session-list snapshot cursor can no longer be continued. */
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
  if (error instanceof OpenGeniApiError) return error.retryable;
  return error instanceof TypeError;
}
