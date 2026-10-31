import { z } from "zod";
import {
  CreateChannelRequest,
  ReorderChannelsRequest,
  UpdateChannelRequest,
} from "@opengeni/contracts";
import {
  ChannelNameConflictError,
  createChannel,
  deleteChannel,
  listChannels,
  reorderChannels,
  updateChannel,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  projectSourceSessionId,
  requireAccessGrant,
  requireProjectAudienceChangeByPerson,
  resolveNewProjectAudience,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { parseRequestJson } from "../http/request-body";
import { requireUsableSessionAvatar } from "./session-avatar";

// Channels ("projects") organize root sessions ("workstreams") by work type in
// the rail. Deliberately session-permission-gated (not workspace:admin):
// anyone who can read sessions can see how shared projects are organized, and
// anyone who can create sessions can organize them. A project is shared with
// the workspace or Only me, like a chat; row-level security shows an Only me
// project to its owner alone. A project's profile (description and avatar)
// changes under the same rule as its name; an image avatar must be one
// everyone can open, so sharing a project later never exposes a private image.
// Reject malformed ids before they reach UUID-typed persistence queries,
// preserving the non-enumerating 404 contract over a driver-level 500.
function channelIdParam(value: string): string {
  if (!z.string().uuid().safeParse(value).success) {
    throw new HTTPException(404, { message: "channel not found" });
  }
  return value;
}

export function registerChannelRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;

  app.get("/v1/workspaces/:workspaceId/channels", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(await listChannels(db, workspaceId));
  });

  app.post("/v1/workspaces/:workspaceId/channels", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const payload = await parseRequestJson(c, CreateChannelRequest);
    await requireUsableSessionAvatar(deps, grant, payload.avatar, { sharedWithWorkspace: true });
    const audience = await resolveNewProjectAudience({
      db,
      settings: deps.settings,
      grant,
      requested: payload.visibility,
      sourceSessionId: projectSourceSessionId(grant),
    });
    try {
      const channel = await createChannel(db, {
        accountId: grant.accountId,
        workspaceId,
        name: payload.name,
        description: payload.description ?? null,
        avatar: payload.avatar ?? null,
        createdBy: grant.subjectId,
        audience,
      });
      return c.json(channel, 201);
    } catch (error) {
      if (error instanceof ChannelNameConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.patch("/v1/workspaces/:workspaceId/channels/:channelId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const payload = await parseRequestJson(c, UpdateChannelRequest);
    await requireUsableSessionAvatar(deps, grant, payload.avatar, { sharedWithWorkspace: true });
    if (payload.visibility !== undefined) requireProjectAudienceChangeByPerson(grant);
    try {
      const channel = await updateChannel(
        db,
        workspaceId,
        channelIdParam(c.req.param("channelId")),
        {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}),
          ...(payload.pinned !== undefined ? { pinned: payload.pinned } : {}),
          ...(payload.visibility !== undefined ? { visibility: "workspace_shared" as const } : {}),
        },
      );
      if (!channel) {
        throw new HTTPException(404, { message: "channel not found" });
      }
      return c.json(channel);
    } catch (error) {
      if (error instanceof ChannelNameConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.put("/v1/workspaces/:workspaceId/channels/order", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const payload = await parseRequestJson(c, ReorderChannelsRequest);
    const channels = await reorderChannels(db, workspaceId, payload.channelIds);
    if (!channels) {
      throw new HTTPException(409, { message: "projects changed; refresh and try again" });
    }
    return c.json(channels);
  });

  app.delete("/v1/workspaces/:workspaceId/channels/:channelId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const deleted = await deleteChannel(db, workspaceId, channelIdParam(c.req.param("channelId")));
    if (!deleted) {
      throw new HTTPException(404, { message: "channel not found" });
    }
    return c.json({ ok: true });
  });
}
