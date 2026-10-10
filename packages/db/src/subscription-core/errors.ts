/**
 * Failures the shared core raises to its callers. Each provider binding
 * supplies the constructors (`SubscriptionCoreProvider.errors`), so a
 * provider can keep the error classes its callers already match; a new
 * provider can use `subscriptionCoreDefaultErrors`.
 */
export type SubscriptionCoreErrors = {
  /** The turn no longer holds its core lease; dispatch must stop. */
  leaseLost(): Error;
  /** The connection, or the caller's authority over it, is no longer usable. */
  accessLost(): Error;
  /** The source was disconnected before a physical request was admitted. */
  sourceDisconnected(): Error;
  /** An earlier request has an unresolved outcome; automatic replay is unsafe. */
  requestOutcomeUnknown(): Error;
  /** An operation lost its lease, its scope or the enabled cutover. */
  operationUnavailable(): Error;
};

export class SubscriptionCoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionCoreError";
  }
}

/** Provider-free errors with the core's stable codes, for providers without legacy classes. */
export function subscriptionCoreDefaultErrors(displayName: string): SubscriptionCoreErrors {
  return {
    leaseLost: () =>
      new SubscriptionCoreError(
        "subscription_core_lease_lost",
        `The core ${displayName} lease for this turn is no longer current`,
      ),
    accessLost: () =>
      new SubscriptionCoreError(
        "subscription_core_access_lost",
        `This turn can no longer use its ${displayName} subscription`,
      ),
    sourceDisconnected: () =>
      new SubscriptionCoreError(
        "subscription_core_source_disconnected",
        `The ${displayName} subscription source was disconnected before this request was admitted`,
      ),
    requestOutcomeUnknown: () =>
      new SubscriptionCoreError(
        "subscription_core_request_outcome_unknown",
        `An earlier ${displayName} request has an unresolved outcome; automatic replay is not safe`,
      ),
    operationUnavailable: () =>
      new SubscriptionCoreError(
        "subscription_core_operation_unavailable",
        `This ${displayName} operation can no longer use its subscription`,
      ),
  };
}
