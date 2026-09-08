import type { AccessGrant } from "@opengeni/contracts";
import {
  grantHasAgentAttemptAuthority,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  type ApiRouteDeps,
} from "@opengeni/core";

type AssociatedInteractionSession = {
  associations: ReadonlyArray<{ sessionId: string }>;
};

/**
 * Narrow a workspace-wide BrowserSession/ComputerSession inventory to the
 * entries a live agent attempt may reach. Every attach-by-id route already
 * authorizes the exact source session through the core seam; the list is the
 * discovery surface behind `interaction_discover scope=workspace`, so it must
 * apply the same seam (private sessions, Slack ownership, and the 0423
 * agent-access scope) to each associated session instead of exposing every
 * peer's identity. Humans, API keys, and service principals keep the complete
 * workspace inventory exactly as before.
 */
export async function filterInteractionSessionsForGrant<T extends AssociatedInteractionSession>(
  deps: Pick<ApiRouteDeps, "db" | "sessionAuthorization">,
  grant: AccessGrant,
  sessions: readonly T[],
): Promise<T[]> {
  if (!grantHasAgentAttemptAuthority(grant)) return [...sessions];
  const decisions = new Map<string, Promise<boolean>>();
  const authorized = (sessionId: string): Promise<boolean> => {
    let decision = decisions.get(sessionId);
    if (!decision) {
      decision = requireSessionAuthorization(deps, grant, {
        sessionId,
        operation: "session.read",
        surface: "http",
      })
        .then(() => true)
        .catch((error: unknown) => {
          if (error instanceof SessionAuthorizationDeniedError) return false;
          throw error;
        });
      decisions.set(sessionId, decision);
    }
    return decision;
  };
  const kept: T[] = [];
  for (const session of sessions) {
    const associated = [...new Set(session.associations.map((entry) => entry.sessionId))];
    let visible = false;
    for (const sessionId of associated) {
      if (await authorized(sessionId)) {
        visible = true;
        break;
      }
    }
    if (visible) kept.push(session);
  }
  return kept;
}
