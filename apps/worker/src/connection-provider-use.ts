import {
  ConnectionUseAuthorizationResult,
  ConnectionUseAuthoritySnapshot,
  type ConnectionUseAttribution,
  type ConnectionUseDenialReason,
} from "@opengeni/contracts/connection-authority";

export class ConnectionProviderUseDeniedError extends Error {
  constructor(readonly reason: ConnectionUseDenialReason) {
    super(`connection provider use denied: ${reason}`);
    this.name = "ConnectionProviderUseDeniedError";
  }
}

/**
 * Performs one uncached authority resolution immediately before one provider
 * request. It never decrypts credentials, retries provider effects, or replaces
 * the frozen connection with another active connection.
 */
export async function runAuthorizedConnectionProviderUse<T>(input: {
  snapshot: unknown;
  resolveAuthority: (
    snapshot: ConnectionUseAuthoritySnapshot,
  ) => Promise<ConnectionUseAuthorizationResult>;
  invokeProvider: (attribution: ConnectionUseAttribution) => Promise<T>;
}): Promise<{ value: T; attribution: ConnectionUseAttribution }> {
  const snapshot = ConnectionUseAuthoritySnapshot.parse(input.snapshot);
  const authorization = ConnectionUseAuthorizationResult.parse(
    await input.resolveAuthority(snapshot),
  );
  if (authorization.status === "denied") {
    throw new ConnectionProviderUseDeniedError(authorization.reason);
  }
  const value = await input.invokeProvider(authorization.attribution);
  return { value, attribution: authorization.attribution };
}
