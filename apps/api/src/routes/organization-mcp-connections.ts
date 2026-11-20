import { UpdateOrganizationMcpConnectionRequest, type AccessContext } from "@opengeni/contracts";
import {
  getManagedUserProfilesByIds,
  getOrganizationMcpConnectionSettings,
  getWorkspace,
  listOrganizationMcpConnections,
  updateOrganizationMcpConnectionSettings,
  revokeOrganizationMcpConnection,
  updateOrganizationMcpConnectionAccess,
  type OrganizationMcpConnection,
} from "@opengeni/db";
import {
  holdsOrganizationAdministration,
  requireAccessContext,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isAgentActingAsPerson, requireFullAccessIfAgent } from "../http/acting-person";
import { z } from "zod";

import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { othersAnAdministratorMayManage } from "../http/organization-owner-protection";
import { parseRequestBody } from "../http/request-body";
import { disconnectAuditActor } from "../http/disconnect-audit-actor";

/* ----------------------------------------------------------------------------
   Connected agents: outside MCP clients people signed in to the organization
   server with. Everyone sees and manages their own; owners and admins see and
   can disconnect everyone's, except that only an owner disconnects an owner's.
   Only the person who connected an agent changes
   what it can do. An agent with the person's full access can do this as them;
   an agent with less can't use these routes, so it can never widen its own
   access.
   -------------------------------------------------------------------------- */

export function registerOrganizationMcpConnectionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organizations/:organizationId/mcp-connections", async (c) => {
    const { context, organizationId, admin } = await requireOrganizationPerson(c, deps);
    const connections = await listOrganizationMcpConnections(deps.db, {
      accountId: organizationId,
      ...(admin ? {} : { subjectId: context.subjectId }),
    });
    const mayManage = admin
      ? await othersAnAdministratorMayManage(deps, context, organizationId)
      : () => false;
    c.header("cache-control", "no-store");
    return c.json({
      connections: (await projectConnections(deps, connections)).map((connection) => ({
        ...connection,
        canDisconnect:
          connection.connectedBy.subjectId === context.subjectId ||
          mayManage(connection.connectedBy.subjectId),
      })),
      canManageAll: admin,
    });
  });

  app.patch("/v1/organizations/:organizationId/mcp-connections/:connectionId", async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const { context, organizationId } = await requireOrganizationPerson(c, deps);
    const connection = await requireConnection(deps, organizationId, c.req.param("connectionId"));
    if (connection.subjectId !== context.subjectId) {
      throw new HTTPException(403, {
        message: "Only the person who connected this agent can change what it can do.",
      });
    }
    const parsed = parseRequestBody(
      UpdateOrganizationMcpConnectionRequest,
      await c.req.json().catch(() => null),
      { status: 400, message: "invalid access setting" },
    );
    const access = parsed.access;
    if (access && connection.autoConnect) {
      throw new HTTPException(409, {
        message:
          "This agent connected automatically. An admin changes what it can do in Auto-connect.",
      });
    }
    // Letting a connected agent manage app data is the person's choice, made
    // in the browser: an agent never widens its own reach.
    if (parsed.appDataAccess === "manager" && isAgentActingAsPerson(c)) {
      throw new HTTPException(403, {
        message: "Let a connected agent manage app data in the Opengeni app in your browser.",
      });
    }
    const workspaceIds = [
      ...(access?.workspaceScope.kind === "selected" ? access.workspaceScope.workspaceIds : []),
      ...(parsed.defaultWorkspaceId ? [parsed.defaultWorkspaceId] : []),
    ];
    for (const workspaceId of workspaceIds) {
      const workspace = await getWorkspace(deps.db, workspaceId);
      if (workspace?.accountId !== organizationId) {
        throw new HTTPException(400, {
          message: "a selected workspace is not in this organization",
        });
      }
    }
    if (access) {
      await updateOrganizationMcpConnectionAccess(deps.db, {
        accountId: organizationId,
        connectionId: connection.id,
        organizationAccess: access,
      });
    }
    if (parsed.appDataAccess !== undefined || parsed.defaultWorkspaceId !== undefined) {
      await updateOrganizationMcpConnectionSettings(deps.db, {
        accountId: organizationId,
        connectionId: connection.id,
        subjectId: connection.subjectId,
        ...(parsed.appDataAccess !== undefined ? { appDataAccess: parsed.appDataAccess } : {}),
        ...(parsed.defaultWorkspaceId !== undefined
          ? { defaultWorkspaceId: parsed.defaultWorkspaceId }
          : {}),
      });
    }
    const [updated] = await projectConnections(
      deps,
      await listOrganizationMcpConnections(deps.db, {
        accountId: organizationId,
        connectionId: connection.id,
      }),
    );
    if (!updated) throw new HTTPException(404, { message: "connected agent not found" });
    return c.json(updated);
  });

  app.delete("/v1/organizations/:organizationId/mcp-connections/:connectionId", async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const { context, organizationId, admin } = await requireOrganizationPerson(c, deps);
    const connection = await requireConnection(deps, organizationId, c.req.param("connectionId"));
    if (connection.subjectId !== context.subjectId && !admin) {
      throw new HTTPException(403, {
        message: "Only the person who connected this agent, or an admin, can disconnect it.",
      });
    }
    if (
      connection.subjectId !== context.subjectId &&
      !(await othersAnAdministratorMayManage(deps, context, organizationId))(connection.subjectId)
    ) {
      throw new HTTPException(403, {
        message: "Only the organization owner can disconnect the owner's agents.",
      });
    }
    await revokeOrganizationMcpConnection(deps.db, {
      accountId: organizationId,
      connectionId: connection.id,
      audit: disconnectAuditActor(c, { subjectId: context.subjectId }),
    });
    return c.body(null, 204);
  });
}

/**
 * A member of the organization, signed in in this browser, or an agent with
 * their full access. Keys and limited agents are refused. `admin` is the
 * organization's owner or one of its admins, who see and can disconnect
 * everyone's agents.
 */
async function requireOrganizationPerson(
  c: Context,
  deps: ApiRouteDeps,
): Promise<{ context: AccessContext; organizationId: string; admin: boolean }> {
  const agent = isAgentActingAsPerson(c);
  if (agent) requireFullAccessIfAgent(c, "Managing connected agents");
  else if (
    deps.settings.productAccessMode !== "managed" ||
    !c.req.header("cookie") ||
    c.req.header("authorization")
  ) {
    throw new HTTPException(403, {
      message: "Manage connected agents in the Opengeni app in your browser.",
    });
  }
  const context = await requireAccessContext(c, deps);
  const organizationId = c.req.param("organizationId") ?? "";
  const grant = context.accountGrants.find((each) => each.accountId === organizationId);
  if (context.mode !== "managed" || !context.subjectId.startsWith("user:") || !grant) {
    throw new HTTPException(404, { message: "organization not found" });
  }
  return {
    context,
    organizationId,
    admin: holdsOrganizationAdministration(context, organizationId),
  };
}

async function requireConnection(
  deps: ApiRouteDeps,
  organizationId: string,
  connectionId: string,
): Promise<OrganizationMcpConnection> {
  if (!z.string().uuid().safeParse(connectionId).success) {
    throw new HTTPException(404, { message: "connected agent not found" });
  }
  const [connection] = await listOrganizationMcpConnections(deps.db, {
    accountId: organizationId,
    connectionId,
  });
  if (!connection) throw new HTTPException(404, { message: "connected agent not found" });
  return connection;
}

async function projectConnections(deps: ApiRouteDeps, connections: OrganizationMcpConnection[]) {
  const settings = await Promise.all(
    connections.map((connection) =>
      getOrganizationMcpConnectionSettings(deps.db, {
        accountId: connection.accountId,
        connectionId: connection.id,
        subjectId: connection.subjectId,
      }),
    ),
  );
  const userIds = connections
    .map((connection) => connection.subjectId)
    .filter((subjectId) => subjectId.startsWith("user:"))
    .map((subjectId) => subjectId.slice("user:".length));
  const profiles = new Map(
    (await getManagedUserProfilesByIds(deps.db, userIds)).map((profile) => [
      `user:${profile.id}`,
      profile,
    ]),
  );
  return connections.map((connection, index) => {
    const profile = profiles.get(connection.subjectId);
    return {
      id: connection.id,
      clientName: connection.clientName ?? "MCP client",
      clientHost: clientHost(connection.redirectUris),
      actor: "user" as const,
      connectedBy: {
        subjectId: connection.subjectId,
        name: profile?.name?.trim() || profile?.email || "Someone",
      },
      policy: connection.organizationAccess,
      appDataAccess: settings[index]!.appDataAccess,
      defaultWorkspaceId: settings[index]!.defaultWorkspaceId,
      autoConnect: connection.autoConnect
        ? {
            trustedIssuerId: connection.autoConnect.trustedIssuerId,
            issuerName: connection.autoConnect.issuerName ?? "Trusted issuer",
          }
        : null,
      createdAt: connection.connectedAt.toISOString(),
      lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
      expiresAt: connection.expiresAt.toISOString(),
      revokedAt: null,
    };
  });
}

function clientHost(redirectUris: string[]): string | null {
  for (const value of redirectUris) {
    try {
      const url = new URL(value);
      return url.host || url.protocol.replace(/:$/u, "");
    } catch {
      continue;
    }
  }
  return null;
}
