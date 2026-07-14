import {
  AddWorkspaceMemberRequest,
  CreateWorkspaceRequest,
  ListWorkspaceMembersResponse,
  SetWorkspaceDefaultRigRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceModelPolicyRequest,
  UpdateWorkspaceRequest,
  UpdateWorkspaceSettingsRequest,
  WorkspaceInferenceControlRequest,
  Workspace,
  WorkspaceMember,
  type AccessContext,
  type Permission,
} from "@opengeni/contracts";
import {
  allWorkspacePermissions,
  countActiveSessionsForWorkspace,
  countWorkspacesForAccount,
  createWorkspace,
  deleteWorkspace,
  getManagedUserByEmail,
  getWorkspaceModelPolicy,
  grantWorkspaceAccess,
  listScheduledTasks,
  listWorkspaceMembers,
  listWorkspacesForSubject,
  removeWorkspaceMember,
  requireWorkspace,
  getRig,
  setWorkspaceDefaultRig,
  updateWorkspace,
  updateWorkspaceSettings,
  upsertWorkspaceModelPolicy,
  setWorkspaceInferenceControl,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requireAccessContext, requireAccessGrant } from "@opengeni/core";
import { requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  assertWorkspaceDeletable,
  assertWorkspaceMemberRemovable,
  resolveMemberSubjectId,
} from "@opengeni/core";

export function registerWorkspaceRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/access/me", async (c) => {
    return c.json(await requireAccessContext(c, deps));
  });

  app.get("/v1/workspaces", async (c) => {
    const context = await requireAccessContext(c, deps);
    const readableWorkspaceIds = [
      ...new Set(
        context.workspaceGrants
          .filter((grant) => hasPermission(grant.permissions, "workspace:read"))
          .map((grant) => grant.workspaceId),
      ),
    ];
    if (readableWorkspaceIds.length > 0) {
      const workspaces = await Promise.all(
        readableWorkspaceIds.map((workspaceId) => requireWorkspace(deps.db, workspaceId)),
      );
      return c.json(workspaces.map((workspace) => Workspace.parse(workspace)));
    }
    return c.json(
      (await listWorkspacesForSubject(deps.db, context.subjectId)).map((workspace) =>
        Workspace.parse(workspace),
      ),
    );
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
      ...(payload.agentInstructions !== undefined
        ? { agentInstructions: normalizeAgentInstructions(payload.agentInstructions) }
        : {}),
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
      ...(payload.agentInstructions !== undefined
        ? { agentInstructions: normalizeAgentInstructions(payload.agentInstructions) }
        : {}),
    });
    return c.json(Workspace.parse(workspace));
  });

  // Read is via GET /v1/workspaces/:workspaceId (Workspace.settings). This PATCH
  // deep-merges (top-level) a settings patch, preserving unknown/future keys.
  app.patch("/v1/workspaces/:workspaceId/settings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const parsed = UpdateWorkspaceSettingsRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid workspace settings patch" });
    }
    const workspace = await updateWorkspaceSettings(deps.db, workspaceId, parsed.data);
    return c.json(Workspace.parse(workspace));
  });

  // Per-workspace model/provider availability policy (the HARD blocker over
  // which providers/models may serve a turn at all). Absent row reads as
  // unrestricted {null, null}.
  app.get("/v1/workspaces/:workspaceId/model-policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const policy = await getWorkspaceModelPolicy(deps.db, workspaceId);
    return c.json({
      allowedProviders: policy?.allowedProviders ?? null,
      allowedModels: policy?.allowedModels ?? null,
    });
  });

  // Full replace (PUT, not merge): null/omitted = unrestricted for that
  // dimension; an empty array is a valid explicit total block. Admin access —
  // this decides whether turns can reach paid providers, so it is the same
  // trust level as billing-affecting workspace settings.
  app.put("/v1/workspaces/:workspaceId/model-policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = UpdateWorkspaceModelPolicyRequest.parse(await c.req.json());
    const policy = await upsertWorkspaceModelPolicy(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      allowedProviders: payload.allowedProviders ?? null,
      allowedModels: payload.allowedModels ?? null,
    });
    return c.json(policy);
  });

  app.post("/v1/workspaces/:workspaceId/inference-control", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = WorkspaceInferenceControlRequest.parse(await c.req.json());
    const result = await setWorkspaceInferenceControl(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      actor: grant.subjectId,
      state: payload.state,
      reason: payload.reason,
      clientEventId: payload.clientEventId,
      expectedState: payload.expectedState,
      expectedGeneration: payload.expectedGeneration,
      exceptSessionIds: payload.exceptSessionIds,
    });
    for (const broadcast of result.broadcasts) {
      await deps.bus.publish(workspaceId, broadcast.sessionId, broadcast.events);
    }
    for (const control of result.controls) {
      await deps.workflowClient.signalSessionControl({
        accountId: control.accountId,
        workspaceId,
        sessionId: control.sessionId,
        eventId: control.eventId,
        workflowId: control.workflowId,
      });
    }
    for (const sessionId of result.wakeSessionIds) {
      await deps.workflowClient.wakeSessionWorkflow({
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        workflowId: `session-${sessionId}`,
      });
    }
    return c.json(
      {
        operationId: result.operationId,
        state: result.state,
        generation: result.generation,
        affectedSessionIds: result.affectedSessionIds,
        controlSessionIds: result.controls.map((entry) => entry.sessionId),
        exceptionSessionIds: result.exceptionSessionIds,
      },
      202,
    );
  });

  app.put("/v1/workspaces/:workspaceId/default-rig", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "rigs:manage");
    const payload = SetWorkspaceDefaultRigRequest.parse(await c.req.json());
    if (payload.rigId) {
      const rig = await getRig(deps.db, workspaceId, payload.rigId);
      if (!rig) {
        throw new HTTPException(422, { message: `unknown rigId: ${payload.rigId}` });
      }
    }
    const workspace = await setWorkspaceDefaultRig(deps.db, workspaceId, payload.rigId);
    return c.json(Workspace.parse(workspace));
  });

  app.delete("/v1/workspaces/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    // Refuse before any external/DB mutation: never delete the account's only
    // workspace, and never delete while a session could still be running in
    // Temporal (there is no clean per-session terminate to call, so deleting
    // the row would orphan the workflow — the operator must stop them first).
    const [workspaceCountForAccount, activeSessionCount] = await Promise.all([
      countWorkspacesForAccount(deps.db, grant.accountId),
      countActiveSessionsForWorkspace(deps.db, workspaceId),
    ]);
    assertWorkspaceDeletable({ workspaceCountForAccount, activeSessionCount });
    // Clean external Temporal state the FK cascade can't reach: every scheduled
    // task's schedule (best-effort, mirroring the scheduled-task delete path).
    const tasks = await listScheduledTasks(deps.db, workspaceId, 1000);
    await Promise.all(
      tasks.map((task) =>
        deps.workflowClient
          .deleteScheduledTaskSchedule({ temporalScheduleId: task.temporalScheduleId })
          .catch(() => undefined),
      ),
    );
    await deleteWorkspace(deps.db, workspaceId);
    return c.body(null, 204);
  });

  // --- Members ("People with access") ---------------------------------------

  app.get("/v1/workspaces/:workspaceId/members", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const members = await listWorkspaceMembers(deps.db, workspaceId);
    return c.json(ListWorkspaceMembersResponse.parse({ members }));
  });

  app.post("/v1/workspaces/:workspaceId/members", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "members:manage");
    const payload = AddWorkspaceMemberRequest.parse(await c.req.json());
    const email = payload.email.trim();
    // Email invites for not-yet-registered users are deferred: an unknown email
    // resolves to null, which resolveMemberSubjectId turns into a 404.
    const subjectId = resolveMemberSubjectId(await getManagedUserByEmail(deps.db, email));
    await grantWorkspaceAccess(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId,
      subjectLabel: email,
      ...(payload.role !== undefined ? { role: payload.role } : {}),
      permissions: payload.permissions,
    });
    const members = await listWorkspaceMembers(deps.db, workspaceId);
    const member = members.find((candidate) => candidate.subjectId === subjectId);
    if (!member) {
      throw new HTTPException(500, { message: "failed to add member" });
    }
    return c.json(WorkspaceMember.parse(member), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/members/:subjectId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "members:manage");
    const subjectId = decodeURIComponent(c.req.param("subjectId"));
    const payload = UpdateWorkspaceMemberRequest.parse(await c.req.json());
    const existing = await listWorkspaceMembers(deps.db, workspaceId);
    const current = existing.find((member) => member.subjectId === subjectId);
    if (!current) {
      throw new HTTPException(404, { message: "member not found" });
    }
    await grantWorkspaceAccess(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId,
      ...(current.subjectLabel ? { subjectLabel: current.subjectLabel } : {}),
      role: payload.role ?? current.role,
      permissions: payload.permissions,
    });
    const members = await listWorkspaceMembers(deps.db, workspaceId);
    const member = members.find((candidate) => candidate.subjectId === subjectId);
    if (!member) {
      throw new HTTPException(500, { message: "failed to update member" });
    }
    return c.json(WorkspaceMember.parse(member));
  });

  app.delete("/v1/workspaces/:workspaceId/members/:subjectId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "members:manage");
    const subjectId = decodeURIComponent(c.req.param("subjectId"));
    const members = await listWorkspaceMembers(deps.db, workspaceId);
    // Never remove yourself, and never remove the last administering member.
    assertWorkspaceMemberRemovable({ members, subjectId, callerSubjectId: grant.subjectId });
    await removeWorkspaceMember(deps.db, workspaceId, subjectId);
    return c.body(null, 204);
  });
}

// A persona override that is null or trims to empty collapses to null (use the
// deployment default). Otherwise the template is stored verbatim so the runtime
// can substitute the non-bypassable CORE at its {{core}} marker.
function normalizeAgentInstructions(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireAccountPermission(
  context: AccessContext,
  accountId: string,
  permission: Permission,
): void {
  const grant = context.accountGrants.find((candidate) => candidate.accountId === accountId);
  if (
    !grant ||
    (!grant.permissions.includes(permission) && !grant.permissions.includes("account:admin"))
  ) {
    throw new HTTPException(403, { message: `missing permission: ${permission}` });
  }
}
