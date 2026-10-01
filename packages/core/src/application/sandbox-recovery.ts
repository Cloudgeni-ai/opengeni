import type { SandboxRecoveryRequest } from "@opengeni/contracts";
import { consentPublicSandboxRecovery, readPublicSandboxRecovery } from "@opengeni/db";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import type { AppDependencies } from "../dependencies";
import { requireSessionAuthorization } from "../session-authorization";
import { requireCanonicalManagedHuman } from "./session-tenancy";

type Dependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

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
  requireCanonicalManagedHuman(authorization, workspaceId);
}

async function authorize(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  intent: "preview" | "consent",
) {
  // Cookie-verification stamp, never principal-shape inference or an actor from
  // the body. The local human may only read; agents, API keys and delegated
  // humans cannot accept data loss or broaden the consent mutation.
  if (intent === "consent") requireCanonicalManagedHuman(authorization, workspaceId);
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
  const scope = await authorize(deps, authorization, workspaceId, sessionId, "consent");
  return consentPublicSandboxRecovery(deps.db, { ...scope, request });
}
