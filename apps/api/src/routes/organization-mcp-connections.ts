import { OrganizationAccessPolicy, type AccessContext } from "@opengeni/contracts";
import {
  getManagedUserProfilesByIds,
  getWorkspace,
  listOrganizationMcpConnections,
  revokeOrganizationMcpConnection,
  updateOrganizationMcpConnectionAccess,
  type OrganizationMcpConnection,
} from "@opengeni/db";
import { hasPermission, requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireNotAgent } from "../http/acting-person";
import { z } from "zod";

import { requireSameOriginBrowserMutation } from "./codex";

/* ----------------------------------------------------------------------------
   Connected agents: outside MCP clients people signed in to the organization
   server with. Everyone sees and manages their own; owners and admins see and
   can disconnect everyone's. Only the person who connected an agent changes
   what it can do, and only from the browser: an agent can never widen its own
   access through these routes.
   -------------------------------------------------------------------------- */

const UpdateBody = z.object({ access: OrganizationAccessPolicy }).strict();

export function registerOrganizationMcpConnectionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/organizations/:organizationId/mcp-connections", async (c) => {
    const { context, organizationId, admin } = await requireOrganizationPerson(c, deps);
    const connections = await listOrganizationMcpConnections(deps.db, {
      accountId: organizationId,
      ...(admin ? {} : { subjectId: context.subjectId }),
    });
    c.header("cache-control", "no-store");
    return c.json({
      connections: await projectConnections(deps, connections),
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
    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid access setting" });
    const access = parsed.data.access;
    if (access.workspaceScope.kind === "selected") {
      for (const workspaceId of access.workspaceScope.workspaceIds) {
        const workspace = await getWorkspace(deps.db, workspaceId);
        if (workspace?.accountId !== organizationId) {
          throw new HTTPException(400, {
            message: "a selected workspace is not in this organization",
          });
        }
      }
    }
    await updateOrganizationMcpConnectionAccess(deps.db, {
      accountId: organizationId,
      connectionId: connection.id,
      organizationAccess: access,
    });
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
    await revokeOrganizationMcpConnection(deps.db, {
      accountId: organizationId,
      connectionId: connection.id,
    });
    return c.body(null, 204);
  });
}

/** A member of the organization, signed in in this browser. Keys and agents are refused. */
async function requireOrganizationPerson(
  c: Context,
  deps: ApiRouteDeps,
): Promise<{ context: AccessContext; organizationId: string; admin: boolean }> {
  requireNotAgent(c, "Managing connected agents");
  if (
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
  return { context, organizationId, admin: hasPermission(grant.permissions, "account:admin") };
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
  return connections.map((connection) => {
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
