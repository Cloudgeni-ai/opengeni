import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  readTurnExecutionPolicyV1,
  resolveAgentToolFamilies,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ConnectAttempt } from "@opengeni/contracts/connect";
import {
  getActiveSessionTurnForExecution,
  getAttemptToolCatalog,
  getSession,
  lockTurnAttemptWriteFenceTx,
  resolveInitiatingHuman,
  type Database,
} from "@opengeni/db";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";
import {
  externalActorContinuationForAuthorization,
  hasPermission,
  isDeveloperSetupGrant,
  requireSessionAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { requireConnectOwnerAuthority } from "./integrations/connect-authority";
import {
  isPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerSubject,
} from "./connection-ownership";
import { codemodeAuthorityForGrant, requireMatchingCodemodeCatalog } from "./codemode";
import { PREPARED_MCP_PERMISSIONS, preparedMcpProxyPermissions } from "./prepared-mcp-permissions";
import { allowedFirstPartyMcpToolsForSession } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";

/** The normal browser and the exact agent attempt share Connect storage and
 * verification. This adapter is ONLY for prepared MCP keys, never interactive
 * OAuth, arbitrary native connections, or a caller-supplied owner identity. */
export async function connectRequestActor(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
) {
  if (!authorization.contextIntegrity)
    throw new HTTPException(403, { message: "Verified Connect authority required" });
  const grant = authorization.grant;
  const continuation = externalActorContinuationForAuthorization(authorization);
  const ordinary = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
    ...(continuation ? { externalContinuation: continuation } : {}),
  };
  if (grant.principalKind !== "agent_attempt")
    return {
      scope: ordinary,
      grant,
      beforeOperation: undefined,
      preparedOnly: false,
    };
  const authority = codemodeAuthorityForGrant(grant);
  if (
    !authority ||
    isDeveloperSetupGrant(grant) ||
    PREPARED_MCP_PERMISSIONS.some((permission) => !hasPermission(grant.permissions, permission))
  )
    throw new HTTPException(403, { message: "Prepared MCP setup authority required" });
  await requireSessionAuthorization(deps, grant, {
    sessionId: authority.sessionId,
    operation: "session.first_party_mcp.call",
    surface: "first_party_mcp",
  });
  const turn = await getActiveSessionTurnForExecution(
    deps.db,
    authority.workspaceId,
    authority.sessionId,
  );
  // No creator, current browser user, raw metadata, or historical fallback.
  const owner = turn?.initiatingHumanSubjectId;
  if (
    !turn ||
    turn.id !== authority.turnId ||
    turn.activeAttemptId !== authority.attemptId ||
    turn.executionGeneration !== authority.executionGeneration ||
    !owner ||
    !isPersonalConnectionOwnerSubject(owner)
  )
    throw new HTTPException(403, { message: "Prepared MCP setup requires an exact causal owner" });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: owner,
    personalOwnerVerified: true,
  };
  const beforeOperation = async (tx: Database) => {
    // Organization policy is already locked by the caller. Live membership
    // precedes workspace/session/turn locks and remains held through commit.
    for (const permission of PREPARED_MCP_PERMISSIONS)
      await requireConnectOwnerAuthority(tx, scope, permission);
    const fence = await lockTurnAttemptWriteFenceTx(tx, authority);
    if (
      !fence.allowed ||
      fence.turn.initiatingHumanSubjectId !== owner ||
      fence.turn.accountId !== grant.accountId
    )
      throw new HTTPException(403, { message: "The setup execution attempt is no longer active" });
    for (const metadata of [fence.turn.metadata, fence.session.metadata]) {
      const policy = readTurnExecutionPolicyV1(metadata);
      if (policy.kind === "valid" && policy.policy.credentialRestriction)
        throw new HTTPException(403, { message: "This execution cannot configure credentials" });
    }
    const session = await getSession(tx, authority.workspaceId, authority.sessionId);
    const catalog = requireMatchingCodemodeCatalog(
      authority,
      await getAttemptToolCatalog(tx, authority),
    );
    const selected =
      session && allowedFirstPartyMcpToolsForSession(deps.settings, session.firstPartyMcpTools);
    const admitted =
      session &&
      preparedMcpProxyPermissions(
        catalog,
        session.firstPartyMcpPermissions ?? [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      );
    if (
      !selected?.includes("custom_mcp_setup_request") ||
      !resolveAgentToolFamilies(session?.agent).allowsFirstPartyTool("custom_mcp_setup_request") ||
      !admitted ||
      PREPARED_MCP_PERMISSIONS.some((permission) => !admitted.includes(permission)) ||
      !(await resolveInitiatingHuman(tx, scope, owner, authority.turnId))
    )
      throw new HTTPException(403, {
        message: "Prepared MCP setup is not allowed by this attempt",
      });
  };
  await withOrganizationIntegrationPolicyFence(deps.db, scope, (tx) => beforeOperation(tx));
  // Internal resource lookup only. The authenticated principal stays an agent;
  // no human_session token or ambient personal-connection delegation is minted.
  const ownerGrant: AccessGrant = { ...grant, subjectId: owner };
  return { scope, grant: ownerGrant, beforeOperation, preparedOnly: true };
}

export function assertAgentPreparedConnect(
  actor: { preparedOnly: boolean },
  attempt: Pick<ConnectAttempt, "providerId" | "mcpSetup">,
): void {
  if (actor.preparedOnly && (attempt.providerId !== "mcp-headers" || !attempt.mcpSetup))
    throw new HTTPException(403, { message: "Agent setup is limited to prepared MCP credentials" });
}
