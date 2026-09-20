import type { SandboxRecoveryRequest } from "@opengeni/contracts";
import { consentPublicSandboxRecovery, readPublicSandboxRecovery } from "@opengeni/db";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import type { AppDependencies } from "../dependencies";
import { requireSessionAuthorization } from "../session-authorization";
import { requireCanonicalManagedHuman } from "./session-tenancy";

type Dependencies = Pick<AppDependencies, "db" | "sessionAuthorization">;

async function authorize(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
) {
  // Cookie-verification stamp, never principal-shape inference or an actor from
  // the body. Agents, API keys and delegated humans cannot accept data loss.
  requireCanonicalManagedHuman(authorization, workspaceId);
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
    await authorize(deps, authorization, workspaceId, sessionId),
  );
}

export async function consentManagedHumanSandboxRecovery(
  deps: Dependencies,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  sessionId: string,
  request: SandboxRecoveryRequest,
) {
  const scope = await authorize(deps, authorization, workspaceId, sessionId);
  return consentPublicSandboxRecovery(deps.db, { ...scope, request });
}
