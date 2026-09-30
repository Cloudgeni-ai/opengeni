import {
  hasPermission,
  requireExternalContinuationAuthority,
  requireSessionAuthorization,
  type ApiRouteDeps,
  type OpenEditableArtifactLiveInput,
} from "@opengeni/core";
import {
  findActiveWorkspaceApiKeyById,
  getSession,
  getWorkspaceGrant,
  hasEditableArtifactSessionLink,
  lockExternalWorkspaceMembershipLifecycle,
  withRlsContext,
} from "@opengeni/db";
import { withAccessGrantSessionRlsContext } from "./access-grant-rls";
import { sql } from "drizzle-orm";

/** Supplied by the API adapter, so mounted hosts use their canonical live port. */
export function editableArtifactSourceSessionAuthorizer(
  deps: ApiRouteDeps,
): NonNullable<OpenEditableArtifactLiveInput["authorizeSourceSession"]> {
  return async (ticket, permission, transaction, signal) => {
    signal?.throwIfAborted();
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
      const scopedDeps = transaction ? { ...deps, db: transaction } : deps;
      // Source-bound stores invoke us before their tenancy/aggregate locks.
      // Match lifecycle writers' organization -> tenancy -> session prefix.
      if (transaction) {
        await lockExternalWorkspaceMembershipLifecycle(transaction, ticket.scope.accountId);
        signal?.throwIfAborted();
        // Tenancy writers acquire this fence before source session rows.
        await transaction.execute(sql`select pg_advisory_xact_lock_shared(
          hashtextextended(${`session-tenancy:${ticket.scope.workspaceId}`}, 0))`);
        signal?.throwIfAborted();
      }
      return await withAccessGrantSessionRlsContext(scopedDeps, grant, async () => {
        return await withRlsContext(scopedDeps.db, ticket.scope, async (tx) => {
          if (authority.externalContinuation) {
            await requireExternalContinuationAuthority(
              tx,
              authority.externalContinuation,
              { ...ticket.scope, subjectId: grant.subjectId },
              ["sessions:read", required],
            );
            signal?.throwIfAborted();
          } else if (transaction) {
            // The authenticated ticket grant is a ceiling, not proof that
            // source-read permission still exists at the commit boundary.
            const actor = ticket.actor;
            if (
              actor.kind === "human" ||
              (actor.kind === "service" && actor.service === "configured_key")
            ) {
              await tx.execute(sql`select subject_id from workspace_memberships
                where account_id = ${ticket.scope.accountId}::uuid
                  and workspace_id = ${ticket.scope.workspaceId}::uuid
                  and subject_id = ${grant.subjectId} for share`);
              const live = await getWorkspaceGrant(tx, grant.subjectId, ticket.scope.workspaceId);
              if (!live || !hasPermission(live.permissions, "sessions:read")) return false;
            } else if (actor.kind === "service" && actor.service === "api_key") {
              await tx.execute(sql`select id from api_keys
                where account_id = ${ticket.scope.accountId}::uuid
                  and id::text = ${grant.subjectId.slice("api_key:".length)}
                for share`);
              const live = await findActiveWorkspaceApiKeyById(tx, {
                ...ticket.scope,
                apiKeyId: grant.subjectId.slice("api_key:".length),
              });
              if (!live || !hasPermission(live.permissions, "sessions:read")) return false;
            } else if (actor.kind === "agent") {
              const live = await getSession(tx, ticket.scope.workspaceId, actor.sessionId);
              if (
                !live ||
                (live.firstPartyMcpPermissions !== null &&
                  !hasPermission(live.firstPartyMcpPermissions, "sessions:read"))
              ) {
                return false;
              }
            } else {
              return false;
            }
            signal?.throwIfAborted();
          }
          // Locks protect visibility and removal of the exact association
          // until the enclosing mutation transaction commits.
          const linked = await hasEditableArtifactSessionLink(
            tx,
            ticket.scope,
            authority.sessionId,
            ticket.artifactId,
            { lockForCommit: transaction !== undefined },
          );
          signal?.throwIfAborted();
          if (!linked) return false;
          await requireSessionAuthorization({ ...scopedDeps, db: tx }, grant, {
            sessionId: authority.sessionId,
            operation: "session.read",
            surface: "http",
          });
          signal?.throwIfAborted();
          return true;
        });
      });
    } catch {
      // Denial or an unavailable authority must stop data/writes, never fall
      // back to artifact-only scope. The live loop closes denied readers.
      return false;
    }
  };
}
