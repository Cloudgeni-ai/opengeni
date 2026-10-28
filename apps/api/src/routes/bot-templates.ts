import {
  BotTemplateResponse,
  CreateBotTemplateRequest,
  ListBotTemplatesResponse,
  UpdateBotTemplateRequest,
} from "@opengeni/contracts";
import {
  botTemplateViewerForGrant,
  createBotTemplateForViewer,
  deleteBotTemplateForViewer,
  getBotTemplateForViewer,
  listBotTemplatesForViewer,
  requireAccessGrant,
  updateBotTemplateForViewer,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestJson } from "../http/request-body";
import { requireUsableSessionAvatar } from "./session-avatar";

/**
 * Bot templates a workspace keeps: where a new bot chat starts. Reading needs
 * what reading chats needs; saving, changing and deleting need what starting a
 * chat needs, and changing or deleting someone else's needs an admin.
 */
export function registerBotTemplateRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;
  const path = "/v1/workspaces/:workspaceId/bot-templates";

  async function viewerFor(c: Context, permission: "sessions:read" | "sessions:create") {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    const viewer = await botTemplateViewerForGrant(db, grant);
    return { grant, viewer, workspaceId };
  }

  function templateIdParam(c: Context): string {
    const templateId = c.req.param("templateId") ?? "";
    if (!z.string().uuid().safeParse(templateId).success) {
      throw new HTTPException(404, { message: "bot template not found" });
    }
    return templateId;
  }

  app.get(path, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "sessions:read");
    const templates = await listBotTemplatesForViewer(db, workspaceId, viewer);
    return c.json(ListBotTemplatesResponse.parse({ templates }));
  });

  app.get(`${path}/:templateId`, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "sessions:read");
    const template = await getBotTemplateForViewer(db, workspaceId, templateIdParam(c), viewer);
    return c.json(BotTemplateResponse.parse({ template }));
  });

  app.post(path, async (c) => {
    const { grant, viewer, workspaceId } = await viewerFor(c, "sessions:create");
    const request = await parseRequestJson(c, CreateBotTemplateRequest);
    if (request.avatar?.kind === "image") {
      await requireUsableSessionAvatar(deps, grant, request.avatar, { sharedWithWorkspace: true });
    }
    const template = await createBotTemplateForViewer({
      db,
      accountId: grant.accountId,
      workspaceId,
      viewer,
      request,
    });
    return c.json(BotTemplateResponse.parse({ template }), 201);
  });

  app.patch(`${path}/:templateId`, async (c) => {
    const { grant, viewer, workspaceId } = await viewerFor(c, "sessions:create");
    const templateId = templateIdParam(c);
    const request = await parseRequestJson(c, UpdateBotTemplateRequest);
    if (request.avatar?.kind === "image") {
      await requireUsableSessionAvatar(deps, grant, request.avatar, { sharedWithWorkspace: true });
    }
    const template = await updateBotTemplateForViewer({
      db,
      workspaceId,
      templateId,
      viewer,
      request,
    });
    return c.json(BotTemplateResponse.parse({ template }));
  });

  app.delete(`${path}/:templateId`, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "sessions:create");
    const templateId = templateIdParam(c);
    await deleteBotTemplateForViewer({ db, workspaceId, templateId, viewer });
    return c.json({ ok: true });
  });
}
