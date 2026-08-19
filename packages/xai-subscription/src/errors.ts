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
