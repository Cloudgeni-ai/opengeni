import {
  hasPermission,
  requireExternalContinuationAuthority,
  requireSessionAuthorization,
  type ApiRouteDeps,
  type OpenEditableArtifactLiveInput,
} from "@opengeni/core";
import { hasEditableArtifactSessionLink, withRlsContext } from "@opengeni/db";
import { withAccessGrantSessionRlsContext } from "./access-grant-rls";

/** Supplied by the API adapter, so mounted hosts use their canonical live port. */
export function editableArtifactSourceSessionAuthorizer(
  deps: ApiRouteDeps,
): NonNullable<OpenEditableArtifactLiveInput["authorizeSourceSession"]> {
  return async (ticket, permission) => {
    const authority = ticket.sourceSessionAuthority;
    if (!authority) return true;
    const { grant } = authority;
    const required = permission === "edit" ? "artifacts:publish" : "artifacts:read";
    if (
      !hasPermission(grant.permissions, required) ||
      !hasPermission(grant.permissions, "sessions:read")
    ) {
      return false;
    }
    // An external audit shape without the verified continuation is not authority.
    if (grant.metadata?.externalActor && !authority.externalContinuation) return false;
    try {
      return await withAccessGrantSessionRlsContext(deps, grant, async () => {
        if (authority.externalContinuation) {
          await withRlsContext(deps.db, ticket.scope, (tx) =>
            requireExternalContinuationAuthority(
              tx,
              authority.externalContinuation,
              { ...ticket.scope, subjectId: grant.subjectId },
              ["sessions:read", required],
            ),
          );
        }
        await requireSessionAuthorization(deps, grant, {
          sessionId: authority.sessionId,
          operation: "session.read",
          surface: "http",
        });
        return await hasEditableArtifactSessionLink(
          deps.db,
          ticket.scope,
          authority.sessionId,
          ticket.artifactId,
        );
      });
    } catch {
      // Denial or an unavailable authority must stop data/writes, never fall
      // back to artifact-only scope. The live loop closes denied readers.
      return false;
    }
  };
}
