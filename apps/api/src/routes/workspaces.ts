import {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  Workspace,
  type AccessContext,
  type Permission,
} from "@opengeni/contracts";
import {
  allWorkspacePermissions,
  createWorkspace,
  grantWorkspaceAccess,
  listWorkspacesForSubject,
  requireWorkspace,
  updateWorkspace,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requireAccessContext, requireAccessGrant } from "../access";
import { requireLimit } from "../billing/limits";
import type { ApiRouteDeps } from "../dependencies";

export function registerWorkspaceRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/access/me", async (c) => {
    return c.json(await requireAccessContext(c, deps));
  });

  app.get("/v1/workspaces", async (c) => {
    const context = await requireAccessContext(c, deps);
    const readableWorkspaceIds = [...new Set(context.workspaceGrants
      .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
      .map((grant) => grant.workspaceId))];
    if (readableWorkspaceIds.length > 0) {
      const workspaces = await Promise.all(readableWorkspaceIds.map((workspaceId) => requireWorkspace(deps.db, workspaceId)));
      return c.json(workspaces.map((workspace) => Workspace.parse(workspace)));
    }
    return c.json((await listWorkspacesForSubject(deps.db, context.subjectId)).map((workspace) => Workspace.parse(workspace)));
  });

  app.post("/v1/workspaces", async (c) => {
    const context = await requireAccessContext(c, deps);
    const payload = CreateWorkspaceRequest.parse(await c.req.json());
    const accountId = payload.accountId ?? context.defaultAccountId;
    if (!accountId) {
      throw new HTTPException(409, { message: "account selection is required" });
    }
    requireAccountPermission(context, accountId, "workspace:create");
    await requireLimit(deps, { accountId, action: "workspace:create", quantity: 1 });
    const workspace = await createWorkspace(deps.db, {
      accountId,
      name: payload.name.trim(),
      slug: payload.slug?.trim() || null,
      externalSource: payload.externalSource ?? null,
      externalId: payload.externalId ?? null,
    });
    await grantWorkspaceAccess(deps.db, {
      accountId,
      workspaceId: workspace.id,
      subjectId: context.subjectId,
      role: "owner",
      permissions: allWorkspacePermissions,
      ...(context.subjectLabel ? { subjectLabel: context.subjectLabel } : {}),
    });
    return c.json(Workspace.parse(workspace), 201);
  });

  app.get("/v1/workspaces/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    return c.json(Workspace.parse(await requireWorkspace(deps.db, workspaceId)));
  });

  app.patch("/v1/workspaces/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = UpdateWorkspaceRequest.parse(await c.req.json());
    const workspace = await updateWorkspace(deps.db, workspaceId, {
      ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
      ...(payload.slug !== undefined ? { slug: payload.slug?.trim() || null } : {}),
    });
    return c.json(Workspace.parse(workspace));
  });
}

function requireAccountPermission(context: AccessContext, accountId: string, permission: Permission): void {
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (!grant || (!grant.permissions.includes(permission) && !grant.permissions.includes("account:admin"))) {
    throw new HTTPException(403, { message: `missing permission: ${permission}` });
  }
}
