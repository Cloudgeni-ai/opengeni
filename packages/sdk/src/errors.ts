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

/** Deployment or organization setup must be completed before private chats can be created. */
export class OpenGeniSetupError extends OpenGeniApiError {
  constructor(error: OpenGeniApiError) {
    super(error.status, error.body, {
      code: "OPENGENI_SETUP_REQUIRED",
      retryable: false,
      correlationId: error.correlationId,
      displayMessage:
        "Private chats require organization_private_session_settings.enabled (migration 0323). " +
        "An organization owner or admin can enable Only me chats in the web app under Organization settings > Security & data, " +
        "or use updateOrganizationPrivateSessionSettings from @opengeni/sdk/organization-private-session-settings " +
        "with enabled: true, the current expectedVersion and a stable operationId " +
        "(PATCH /v1/organizations/:organizationId/private-session-settings; an organization key needs workspace:admin). " +
        "If platform readiness is unavailable, ask the deployment operator to activate session tenancy first.",
    });
    this.name = "OpenGeniSetupError";
  }
}

/** A settled usage ceiling refuses the next call; retry after reset or an authorized grant. */
export class OpenGeniAllowanceExhaustedError extends OpenGeniApiError {
  readonly scope: "workspace" | "member";
  readonly resetsAt: string | null;
  readonly subjectId: string | undefined;

  constructor(
    status: number,
    body: string,
    options: ConstructorParameters<typeof OpenGeniApiError>[2] = {},
  ) {
    super(status, body, {
      ...options,
      code: "allowance_exhausted",
      retryable: false,
      outcomeUnknown: false,
    });
    this.name = "OpenGeniAllowanceExhaustedError";
    const refusal = allowanceExhaustedFields(body);
    this.scope = refusal?.scope ?? "workspace";
    this.resetsAt = refusal?.resetsAt ?? null;
    this.subjectId = refusal?.subjectId;
  }
}

/** Accept both the API error envelope and the standalone admission refusal. */
export function allowanceExhaustedFields(body: string): {
  scope: "workspace" | "member";
  resetsAt: string | null;
  subjectId?: string;
} | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const error =
      root.error && typeof root.error === "object" && !Array.isArray(root.error)
        ? (root.error as Record<string, unknown>)
        : root;
    if (error.code !== "allowance_exhausted") return null;
    const fields =
      error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : error;
    if (fields.scope !== "workspace" && fields.scope !== "member") return null;
    if (fields.resetsAt !== null && typeof fields.resetsAt !== "string") return null;
    return {
      scope: fields.scope,
      resetsAt: fields.resetsAt,
      ...(typeof fields.subjectId === "string" ? { subjectId: fields.subjectId } : {}),
    };
  } catch {
    return null;
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

/**
 * Brand-neutral end-user copy for a failed SDK operation. Error.message, body,
 * details and typed fields remain unchanged for diagnostics and host policy.
 * Never use this to rewrite user, assistant or tool content.
 */
export function formatErrorMessage(
  error: unknown,
  fallback = "The request could not be completed.",
): string {
  if (error instanceof OpenGeniApiError) {
    let message: string;
    if (error.outcomeUnknown) {
      message = "The request could not be confirmed. Check its status before retrying.";
    } else if (
      error instanceof OpenGeniSetupError ||
      error.code === "OPENGENI_SETUP_REQUIRED" ||
      error.code === "SESSION_TENANCY_NOT_ACTIVATED"
    ) {
      message = "Private conversations are unavailable. Ask an administrator to enable them.";
    } else if (error.code === "allowance_exhausted") {
      message = "Usage limit reached. Wait for the reset or ask an administrator for more usage.";
    } else if (error instanceof OpenGeniSessionListCursorError) {
      message = "The conversation list changed. Refresh and try again.";
    } else if (error.status === 401) {
      message = "Sign in to continue.";
    } else if (error.status === 403) {
      message = "You don’t have permission to do that.";
    } else if (error.status === 404) {
      message = "The requested item is unavailable.";
    } else if (error.status === 402 || error.code === "payment_required") {
      message = "There are not enough credits to continue.";
    } else if (error.status === 429 || error.code === "rate_limited") {
      message = error.retryable
        ? "Too many requests. Wait a moment and try again."
        : "This request is unavailable. Ask an administrator for help.";
    } else if (error.status === 409) {
      message = "The request conflicts with the current state. Refresh and try again.";
    } else if (error.status === 400 || error.status === 422) {
      message = "The request could not be accepted. Check your input and try again.";
    } else if (error.status === 408 || error.status === 425 || error.status === 0) {
      message = error.retryable
        ? "The connection could not be completed. Try again later."
        : fallback;
    } else if (error.status >= 500) {
      message = error.retryable
        ? "The service is temporarily unavailable. Try again later."
        : "The service is unavailable. Ask an administrator for help.";
    } else {
      message = fallback;
    }
    return error.correlationId ? `${message} Reference: ${error.correlationId}.` : message;
  }
  if (
    error instanceof OpenGeniSecureContextRequiredError ||
    (error instanceof Error && "code" in error && error.code === "secure_context_required")
  ) {
    return "reason" in error && error.reason === "insecure_context"
      ? "Attachments require HTTPS. Open this page over a secure connection."
      : "Attachments require secure browser cryptography. Use a supported browser over HTTPS.";
  }
  if (error instanceof OpenGeniApiContractMismatchError) {
    return "This page is out of date. Reload it before trying again.";
  }
  if (error instanceof OpenGeniStreamError) {
    return "The live connection could not be restored. Refresh to check the latest state.";
  }
  return fallback;
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
