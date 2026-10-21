import type { SandboxRecoveryRequest } from "@opengeni/contracts";
import { consentPublicSandboxRecovery, readPublicSandboxRecovery } from "@opengeni/db";
import {
  externalAttributionForAuthorization,
  requirePermission,
  type AccessGrantAuthorization,
} from "../access";
import type { AppDependencies } from "../dependencies";
import { requireSessionAuthorization } from "../session-authorization";
import { requireCanonicalManagedHuman } from "./session-tenancy";

type Dependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

/** A human the request itself proves: the canonical managed cookie session, or
 * an organization key acting as one verified external user on that user's own
 * behalf (asUser). The external proof is request-local, so a copied grant
 * never qualifies, and admission already refuses it beside a service
 * initiator. Delegated OAuth bearers, agents and bare keys act for something
 * other than the person and never accept data loss. */
export function requireSandboxRecoveryConsentHuman(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): void {
  if (
    authorization.contextIntegrity &&
    authorization.authenticatedSubjectId === authorization.grant.subjectId &&
    authorization.grant.workspaceId === workspaceId &&
    externalAttributionForAuthorization(authorization, authorization.grant) !== null
  )
    return;
  requireCanonicalManagedHuman(authorization, workspaceId);
}

/** The read-only projection also serves the exact built-in local human. Its
 * provenance stamp is set only by the local resolver, never a bearer claim. */
export function requireSandboxRecoveryPreviewHuman(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): void {
  if (
    authorization.canonicalLocalHumanSession &&
    authorization.contextIntegrity &&
    authorization.authenticatedSubjectId === authorization.grant.subjectId &&
    authorization.grant.workspaceId === workspaceId &&
    authorization.grant.subjectId === "dev" &&
    authorization.grant.principalKind === "human_session" &&
    authorization.grant.metadata?.delegated !== true &&
    !authorization.grant.serviceInitiator
  )
    return;
  requireSandboxRecoveryConsentHuman(authorization, workspaceId);
}

async function authorize(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  intent: "preview" | "consent" | "workspace",
) {
  // Request-verified human proof, never principal-shape inference or an actor
  // from the body. The exact local human may retry or explicitly continue
  // empty; historical checkpoint consent needs the managed cookie human or a
  // verified external user acting as themselves. Agents, bare API keys,
  // services and delegated bearers cannot accept data loss or broaden either
  // mutation.
  if (intent === "consent") requireSandboxRecoveryConsentHuman(authorization, workspaceId);
  else requireSandboxRecoveryPreviewHuman(authorization, workspaceId);
  requirePermission(authorization.grant, "sessions:read");
  requirePermission(authorization.grant, "sessions:control");
  await requireSessionAuthorization(deps, authorization.grant, {
    sessionId,
    operation: "session.control",
    surface: "core",
  });
  return {
    accountId: authorization.grant.accountId,
    workspaceId,
    sessionId,
    subjectId: authorization.grant.subjectId,
    canControlMember: async (tx: Dependencies["db"], memberSessionId: string) => {
      try {
        await requireSessionAuthorization({ ...deps, db: tx }, authorization.grant, {
          sessionId: memberSessionId,
          operation: "session.control",
          // Unlike a standalone core read, a hidden/missing member must refuse
          // control rather than return the legacy null/no-host-port result.
          surface: "http",
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function getManagedHumanSandboxRecovery(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
) {
  return readPublicSandboxRecovery(
    deps.db,
    await authorize(deps, authorization, workspaceId, sessionId, "preview"),
  );
}

export async function consentManagedHumanSandboxRecovery(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  request: SandboxRecoveryRequest,
) {
  const scope = await authorize(
    deps,
    authorization,
    workspaceId,
    sessionId,
    "action" in request ? "workspace" : "consent",
  );
  return consentPublicSandboxRecovery(deps.db, { ...scope, request });
}
