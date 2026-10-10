/**
 * The errors the shared subscription core raises for Codex, under the class
 * names and codes M3 shipped (callers match them with `instanceof`). The
 * Codex binding supplies them to the core (`SubscriptionCoreProvider.errors`).
 */

/** Raised when the turn no longer holds its core lease; dispatch must stop. */
export class SubscriptionCoreCodexLeaseLostError extends Error {
  readonly code = "codex_credential_lease_lost";
  constructor() {
    super("The core Codex lease for this turn is no longer current");
    this.name = "SubscriptionCoreCodexLeaseLostError";
  }
}

/**
 * The turn lost access to its leased connection mid-turn (the connection, or
 * the turn's authority over it, is no longer visible, enabled or usable).
 * Distinct from a revoked sign-in, which is `CodexReloginRequired`.
 */
export class SubscriptionCoreCodexAccessLostError extends Error {
  readonly code = "subscription_core_access_lost";
  constructor() {
    super("This turn can no longer use its Codex subscription");
    this.name = "SubscriptionCoreCodexAccessLostError";
  }
}

export class SubscriptionCoreCodexSourceDisconnectedError extends Error {
  readonly code = "subscription_core_source_disconnected";
  constructor() {
    super("The Codex subscription source was disconnected before this request was admitted");
    this.name = "SubscriptionCoreCodexSourceDisconnectedError";
  }
}

/** A crashed/replaced attempt has no durable response or definitive refusal.
 * This is not a retryable transport error or a new placement request.
 */
export class SubscriptionCoreCodexRequestOutcomeUnknownError extends Error {
  readonly code = "subscription_core_request_outcome_unknown";
  constructor() {
    super("An earlier Codex request has an unresolved outcome; automatic replay is not safe");
    this.name = "SubscriptionCoreCodexRequestOutcomeUnknownError";
  }
}

/** The operation lost its lease, its scope or the enabled cutover. */
export class SubscriptionCoreCodexOperationUnavailableError extends Error {
  readonly code = "subscription_core_operation_unavailable";
  constructor() {
    super("This Codex operation can no longer use its subscription");
    this.name = "SubscriptionCoreCodexOperationUnavailableError";
  }
}
