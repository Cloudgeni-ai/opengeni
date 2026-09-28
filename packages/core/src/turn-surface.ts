import type { AccessGrant, SessionTurnSurface } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "./access";
import { currentSiteSessionOrigin } from "./site-session-origin";

/**
 * Resolve the content-free product surface a request entered through.
 *
 * The result is an analytics label frozen on the accepted turn. It never
 * authorizes anything, so it reads trusted provenance only where it already
 * exists: an explicit entry-point choice (Slack, automations, maintenance), the
 * API-validated Site scope, and the access path the grant was resolved from.
 * A grant whose path this function cannot place yields null rather than a
 * guess.
 */
export function resolveTurnSurface(input: {
  grant: AccessGrant;
  authorization?: AccessGrantAuthorization | null | undefined;
  /** An entry point that knows its surface (for example Slack) passes it here. */
  requested?: SessionTurnSurface | null | undefined;
}): SessionTurnSurface | null {
  if (input.requested) return input.requested;
  if (currentSiteSessionOrigin()) return "site";
  const { grant } = input;
  const metadata = grant.metadata ?? {};
  if (
    grant.principalKind === "agent_attempt" ||
    metadata.turnId !== undefined ||
    metadata.attemptId !== undefined
  ) {
    return "agent";
  }
  if (metadata.externalActor !== undefined) return "embedded";
  if (metadata.mcpOAuth === true) return "mcp";
  if (grant.principalKind === "api_key" || grant.principalKind === "configured_key") {
    return "api_key";
  }
  if (metadata.delegated === true || grant.serviceInitiator) return "embedded";
  if (
    input.authorization?.canonicalManagedHumanSession ||
    input.authorization?.canonicalLocalHumanSession
  ) {
    return "web";
  }
  return grant.principalKind === "human_session" ? "web" : null;
}
