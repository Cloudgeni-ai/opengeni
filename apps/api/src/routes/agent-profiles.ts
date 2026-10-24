import { z } from "zod";
import {
  AgentProfileStatus,
  CreateAgentProfileRequest,
  UpdateAgentProfileRequest,
} from "@opengeni/contracts";
import {
  AgentProfileArchivedError,
  AgentProfileLimitError,
  AgentProfileNameConflictError,
  AgentProfileVersionConflictError,
  createAgentProfile,
  getAgentProfile,
  listAgentProfileVersions,
  listAgentProfiles,
  setAgentProfileStatus,
  updateAgentProfile,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant, requireAgentProfilesEnabled } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { parseRequestJson } from "../http/request-body";

// Workspace-shared agent profiles: reusable named agents a chat can start from
// or switch to. Gated like channels on session permissions, not workspace
// admin: anyone who can read sessions can see the workspace's agents, and
// anyone who can create sessions can save and edit them. A profile is only a
// preset; applying it resolves through ordinary session authorization, so it
// never lets anyone run with more than their own grant allows.
// Every route answers 404 while the agent profiles flag is off.

function profileIdParam(value: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new HTTPException(404, { message: "agent profile not found" });
  }
  return value;
}

const ListQuery = z.object({
  status: z.union([AgentProfileStatus, z.literal("all")]).default("active"),
});

function mapProfileError(error: unknown): never {
  if (error instanceof AgentProfileNameConflictError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof AgentProfileVersionConflictError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof AgentProfileArchivedError) {
    throw new HTTPException(409, { message: error.message });
  }
  if (error instanceof AgentProfileLimitError) {
    throw new HTTPException(422, { message: error.message });
  }
  throw error;
}

export function registerAgentProfileRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;

  app.get("/v1/workspaces/:workspaceId/agent-profiles", async (c) => {
    requireAgentProfilesEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const query = ListQuery.safeParse({ status: c.req.query("status") ?? undefined });
    if (!query.success) {
      throw new HTTPException(422, { message: "status must be active, archived or all" });
    }
    return c.json({ profiles: await listAgentProfiles(db, workspaceId, query.data) });
  });

  app.post("/v1/workspaces/:workspaceId/agent-profiles", async (c) => {
    requireAgentProfilesEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const payload = await parseRequestJson(c, CreateAgentProfileRequest);
    try {
      const profile = await createAgentProfile(db, {
        accountId: grant.accountId,
        workspaceId,
        name: payload.name,
        role: payload.role ?? null,
        avatar: payload.avatar,
        config: payload.config,
        createdBy: grant.subjectId,
      });
      return c.json(profile, 201);
    } catch (error) {
      mapProfileError(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/agent-profiles/:profileId", async (c) => {
    requireAgentProfilesEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const profile = await getAgentProfile(
      db,
      workspaceId,
      profileIdParam(c.req.param("profileId")),
    );
    if (!profile) throw new HTTPException(404, { message: "agent profile not found" });
    return c.json(profile);
  });

  app.get("/v1/workspaces/:workspaceId/agent-profiles/:profileId/versions", async (c) => {
    requireAgentProfilesEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const profileId = profileIdParam(c.req.param("profileId"));
    const profile = await getAgentProfile(db, workspaceId, profileId);
    if (!profile) throw new HTTPException(404, { message: "agent profile not found" });
    return c.json({ versions: await listAgentProfileVersions(db, workspaceId, profileId) });
  });

  app.patch("/v1/workspaces/:workspaceId/agent-profiles/:profileId", async (c) => {
    requireAgentProfilesEnabled(deps.settings);
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const payload = await parseRequestJson(c, UpdateAgentProfileRequest);
    try {
      const profile = await updateAgentProfile(db, {
        workspaceId,
        profileId: profileIdParam(c.req.param("profileId")),
        expectedVersion: payload.expectedVersion,
        name: payload.name,
        role: payload.role,
        avatar: payload.avatar,
        config: payload.config,
        updatedBy: grant.subjectId,
      });
      if (!profile) throw new HTTPException(404, { message: "agent profile not found" });
      return c.json(profile);
    } catch (error) {
      mapProfileError(error);
    }
  });

  for (const [action, status] of [
    ["archive", "archived"],
    ["restore", "active"],
  ] as const) {
    app.post(`/v1/workspaces/:workspaceId/agent-profiles/:profileId/${action}`, async (c) => {
      requireAgentProfilesEnabled(deps.settings);
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
      try {
        const profile = await setAgentProfileStatus(db, {
          workspaceId,
          profileId: profileIdParam(c.req.param("profileId")),
          status,
          updatedBy: grant.subjectId,
        });
        if (!profile) throw new HTTPException(404, { message: "agent profile not found" });
        return c.json(profile);
      } catch (error) {
        mapProfileError(error);
      }
    });
  }
}
