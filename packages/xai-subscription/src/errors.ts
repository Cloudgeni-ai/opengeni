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
