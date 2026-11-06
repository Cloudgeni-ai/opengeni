import { parseXaiClientVersionRejection } from "./client-version";

export type XaiSubscriptionErrorKind =
  | "invalid_response"
  | "not_enabled"
  | "authorization_denied"
  | "device_code_expired"
  | "relogin_required"
  | "transient"
  | "provider_rejected"
  | "timeout";

export class XaiSubscriptionError extends Error {
  constructor(
    readonly kind: XaiSubscriptionErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XaiSubscriptionError";
  }
}

export class XaiSubscriptionReloginRequired extends XaiSubscriptionError {
  constructor(message = "The SuperGrok connection is no longer valid. Reconnect the account.") {
    super("relogin_required", message);
    this.name = "XaiSubscriptionReloginRequired";
  }
}

export class XaiSubscriptionTransientError extends XaiSubscriptionError {
  constructor(message: string, status?: number) {
    super("transient", message, status);
    this.name = "XaiSubscriptionTransientError";
  }
}

export const XAI_SUBSCRIPTION_CLIENT_OUTDATED_CODE = "xai_client_outdated";

/**
 * xAI refused the Grok client version Opengeni presented, and adopting the
 * minimum it named did not help (it named none, or refused that too). This
 * is a platform release problem, never a fault of the connected account, so
 * it must not mark the account unauthorized or forbidden.
 */
export class XaiSubscriptionClientOutdatedError extends XaiSubscriptionError {
  readonly code = XAI_SUBSCRIPTION_CLIENT_OUTDATED_CODE;

  constructor(
    readonly sentVersion: string,
    readonly requiredVersion: string,
    status?: number,
  ) {
    super(
      "provider_rejected",
      `SuperGrok refused the Grok client version this Opengeni release presents (${sentVersion}); xAI requires ${requiredVersion} or newer. Grok models stay unavailable until Opengeni is updated.`,
      status,
    );
    this.name = "XaiSubscriptionClientOutdatedError";
  }

  static fromText(text: string | null | undefined, status?: number) {
    const rejection = parseXaiClientVersionRejection(text);
    return rejection
      ? new XaiSubscriptionClientOutdatedError(rejection.sent, rejection.required, status)
      : null;
  }
}

/**
 * Find an outdated-client refusal anywhere on an error chain: the typed error,
 * or the provider's refusal sentence carried by an SDK API error (its
 * message or parsed body) after the transport's one adopt-and-retry failed.
 */
export function classifyXaiSubscriptionClientOutdatedError(
  error: unknown,
): XaiSubscriptionClientOutdatedError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (current instanceof XaiSubscriptionClientOutdatedError) return current;
    const value = current as Record<string, unknown>;
    const status = typeof value.status === "number" ? value.status : undefined;
    const candidates: unknown[] = [value.message, value.error];
    if (value.error && typeof value.error === "object") {
      const body = value.error as Record<string, unknown>;
      candidates.push(body.message, body.error);
    }
    for (const candidate of candidates) {
      const outdated =
        typeof candidate === "string"
          ? XaiSubscriptionClientOutdatedError.fromText(candidate, status)
          : null;
      if (outdated) return outdated;
    }
    current = value.cause;
  }
  return null;
}

/** The first bytes of an error response body as text; never throws. */
export async function readBoundedXaiErrorText(
  response: Response,
  maxBytes = 16 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } catch {
    // A broken error body is still an error; the status decides.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.byteLength) break;
    const slice = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class XaiSubscriptionHostedToolContinuationError extends XaiSubscriptionError {
  readonly code = "xai_hosted_tool_continuation_stalled";

  constructor() {
    super(
      "timeout",
      "SuperGrok stopped responding after completing a hosted search. The partial response was preserved and was not replayed automatically.",
    );
    this.name = "XaiSubscriptionHostedToolContinuationError";
  }
}

export class XaiSubscriptionStreamingTerminalError extends XaiSubscriptionError {
  readonly code: string;
  readonly eventType: string;
  readonly requestId: string | null;
  readonly diagnosticTruncated: boolean;
  readonly headers: Headers;

  constructor(input: {
    message: string;
    code: string;
    eventType: string;
    requestId?: string | null;
    status?: number;
    diagnosticTruncated?: boolean;
    headers?: Headers;
  }) {
    super("provider_rejected", input.message, input.status);
    this.name = "XaiSubscriptionStreamingTerminalError";
    this.code = input.code;
    this.eventType = input.eventType;
    this.requestId = input.requestId ?? null;
    this.diagnosticTruncated = input.diagnosticTruncated === true;
    this.headers = input.headers ?? new Headers();
  }
}

export type XaiSubscriptionStreamingTerminalInfo = {
  message: string;
  code: string;
  eventType: string;
  requestId: string | null;
  status?: number;
  diagnosticTruncated: boolean;
};

const XAI_SUBSCRIPTION_RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "too_many_requests",
  "overloaded_error",
  "server_overloaded",
  "capacity_exceeded",
  "resource_exhausted",
]);

// Message fallback is the observed Grok HTTP-200 SSE capacity sentence only.
// Isolated "high demand" / "overloaded" / "rate limit" text is not enough: a
// false-positive arms the durable same-turn waiter with no give-up.
const XAI_SUBSCRIPTION_RATE_LIMIT_MESSAGE =
  /the model is currently at capacity due to high demand/i;

export function isXaiSubscriptionRateLimitDiagnostic(input: {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}): boolean {
  if (input.status === 429) return true;
  const code = (input.code ?? "").trim().toLowerCase();
  if (XAI_SUBSCRIPTION_RATE_LIMIT_CODES.has(code)) return true;
  return XAI_SUBSCRIPTION_RATE_LIMIT_MESSAGE.test(input.message ?? "");
}

export function classifyXaiSubscriptionStreamingTerminalError(
  error: unknown,
): XaiSubscriptionStreamingTerminalInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    if (
      current instanceof XaiSubscriptionStreamingTerminalError ||
      value.name === "XaiSubscriptionStreamingTerminalError"
    ) {
      const code = typeof value.code === "string" && value.code.length > 0 ? value.code : null;
      const eventType =
        typeof value.eventType === "string" && value.eventType.length > 0 ? value.eventType : null;
      const message = typeof value.message === "string" ? value.message : "";
      if (!code || !eventType || message.length === 0) return null;
      const status = Number(value.status);
      return {
        message,
        code,
        eventType,
        requestId: typeof value.requestId === "string" ? value.requestId : null,
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
        diagnosticTruncated: value.diagnosticTruncated === true,
      };
    }
    current = value.cause;
  }
  return null;
}

export class XaiSubscriptionStreamIdleTimeoutError extends XaiSubscriptionError {
  readonly code = "xai_response_stream_idle_timeout";

  constructor(
    readonly requestId: string,
    readonly responseObserved: boolean,
    readonly eventCount: number,
    readonly lastEventType: string | null,
    readonly silenceDurationMs: number,
  ) {
    super(
      "timeout",
      "SuperGrok stopped sending valid response events. The partial response was preserved and was not replayed automatically.",
    );
    this.name = "XaiSubscriptionStreamIdleTimeoutError";
  }
}

export type XaiSubscriptionStreamIdleTimeoutInfo = {
  requestId: string | null;
  responseObserved: boolean;
  eventCount: number;
  lastEventType: string | null;
  silenceDurationMs: number;
};

export function classifyXaiSubscriptionStreamIdleTimeoutError(
  error: unknown,
): XaiSubscriptionStreamIdleTimeoutInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    if (
      current instanceof XaiSubscriptionStreamIdleTimeoutError ||
      value.code === "xai_response_stream_idle_timeout"
    ) {
      return {
        requestId: typeof value.requestId === "string" ? value.requestId : null,
        responseObserved: value.responseObserved === true,
        eventCount:
          typeof value.eventCount === "number" && Number.isSafeInteger(value.eventCount)
            ? value.eventCount
            : 0,
        lastEventType: typeof value.lastEventType === "string" ? value.lastEventType : null,
        silenceDurationMs:
          typeof value.silenceDurationMs === "number" && Number.isFinite(value.silenceDurationMs)
            ? Math.max(0, value.silenceDurationMs)
            : 0,
      };
    }
    current = value.cause;
  }
  return null;
}

export function isXaiSubscriptionHostedToolContinuationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (current instanceof XaiSubscriptionHostedToolContinuationError) return true;
    if ((current as { code?: unknown }).code === "xai_hosted_tool_continuation_stalled") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
