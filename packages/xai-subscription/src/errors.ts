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
