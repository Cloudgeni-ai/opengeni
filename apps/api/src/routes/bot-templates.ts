import {
  AcceptBotTemplateProposalRequest,
  AcceptBotTemplateProposalResponse,
  BotTemplateProposalResponse,
  BotTemplateProposalStatus,
  BotTemplateResponse,
  CreateBotTemplateRequest,
  ListBotTemplateProposalsResponse,
  ListBotTemplatesResponse,
  UpdateBotTemplateRequest,
} from "@opengeni/contracts";
import {
  acceptBotTemplateProposalForGrant,
  botTemplateViewerForGrant,
  dismissBotTemplateProposalForGrant,
  listBotTemplateProposalsForGrant,
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

  // Setup-instruction updates bot chats proposed for their templates. Reading
  // shows only proposals from chats the reader can see; accepting or
  // dismissing one needs what changing its template needs.
  const proposals = "/v1/workspaces/:workspaceId/bot-template-proposals";
  const ProposalQuery = z.object({
    templateId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    status: z.union([BotTemplateProposalStatus, z.literal("all")]).default("pending"),
  });

  function proposalIdParam(c: Context): string {
    const proposalId = c.req.param("proposalId") ?? "";
    if (!z.string().uuid().safeParse(proposalId).success) {
      throw new HTTPException(404, { message: "proposal not found" });
    }
    return proposalId;
  }

  app.get(proposals, async (c) => {
    const { grant } = await viewerFor(c, "sessions:read");
    const query = ProposalQuery.safeParse({
      templateId: c.req.query("templateId") ?? undefined,
      sessionId: c.req.query("sessionId") ?? undefined,
      status: c.req.query("status") ?? undefined,
    });
    if (!query.success) throw new HTTPException(422, { message: "invalid proposal query" });
    const list = await listBotTemplateProposalsForGrant(db, grant, query.data);
    return c.json(ListBotTemplateProposalsResponse.parse({ proposals: list }));
  });

  app.post(`${proposals}/:proposalId/accept`, async (c) => {
    const { grant } = await viewerFor(c, "sessions:create");
    const proposalId = proposalIdParam(c);
    const request = await parseRequestJson(c, AcceptBotTemplateProposalRequest);
    const accepted = await acceptBotTemplateProposalForGrant(
      db,
      grant,
      proposalId,
      request.expectedUpdatedAt,
    );
    return c.json(AcceptBotTemplateProposalResponse.parse(accepted));
  });

  app.post(`${proposals}/:proposalId/dismiss`, async (c) => {
    const { grant } = await viewerFor(c, "sessions:create");
    const proposal = await dismissBotTemplateProposalForGrant(db, grant, proposalIdParam(c));
    return c.json(BotTemplateProposalResponse.parse({ proposal }));
  });
}
