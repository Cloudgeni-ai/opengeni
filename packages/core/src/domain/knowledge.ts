import type { AccessGrant, KnowledgeEntryScope, Permission } from "@opengeni/contracts";
import type { KnowledgeContext } from "@opengeni/db";
import { hasPermission, type AccessGrantAuthorization } from "../access";
import { requireLiveAgentAttemptAuthorization } from "../session-authorization";
import type { ApiRouteDeps } from "../dependencies";
import { HTTPException } from "hono/http-exception";

/** A delegated MCP gateway can retrieve shared Knowledge. Its subject label
 * does not establish personal ownership or human review authority. */
export async function knowledgeContextForGateway(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<KnowledgeContext> {
  if (!hasPermission(grant.permissions, "documents:search"))
    throw new HTTPException(403, { message: "Missing permission: documents:search" });
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "service",
      principalKind: "mcp_gateway",
      subjectId: grant.subjectId,
      writeScopes: [],
      review: false,
      settingsScopes: [],
    },
  };
}

/** One host boundary for HTTP, SDK-through-HTTP and first-party Knowledge tools. */
export async function knowledgeContextForAccess(
  deps: Pick<ApiRouteDeps, "db">,
  access: AccessGrantAuthorization,
  permission: Permission,
): Promise<KnowledgeContext> {
  const { grant } = access;
  if (!hasPermission(grant.permissions, permission)) {
    throw new HTTPException(403, { message: `Missing permission: ${permission}` });
  }
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  if (
    grant.principalKind === "service" ||
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key"
  ) {
    const writeScopes: Array<"workspace" | "organization"> = hasPermission(
      grant.permissions,
      "documents:manage",
    )
      ? ["workspace"]
      : [];
    if (writeScopes.length && access.accountGrant?.permissions.includes("account:admin"))
      writeScopes.push("organization");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "service",
        principalKind: grant.principalKind,
        subjectId: grant.subjectId,
        writeScopes,
        review: false,
        settingsScopes: [],
      },
    };
  }
  if (
    grant.principalKind !== "human_session" ||
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== grant.subjectId ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.metadata?.attemptId !== undefined ||
    grant.metadata?.turnId !== undefined
  ) {
    throw new HTTPException(403, {
      message: "Knowledge management requires an authenticated human or agent attempt",
    });
  }
  const canWrite = hasPermission(grant.permissions, "documents:manage");
  const writeScopes: KnowledgeEntryScope[] = canWrite ? ["workspace", "personal"] : [];
  // Organization authority does not follow from the workspace-admin wildcard.
  if (canWrite && access.accountGrant?.permissions.includes("account:admin"))
    writeScopes.push("organization");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: access.authenticatedSubjectId,
      writeScopes,
      review: canWrite,
      settingsScopes: [
        "personal",
        ...(hasPermission(grant.permissions, "workspace:admin") ? ["workspace" as const] : []),
      ],
    },
  };
}
