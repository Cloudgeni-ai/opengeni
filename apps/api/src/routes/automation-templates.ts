import {
  AutomationTemplateResponse,
  CreateAutomationTemplateRequest,
  ListAutomationTemplatesResponse,
  UpdateAutomationTemplateRequest,
} from "@opengeni/contracts";
import {
  createAutomationTemplateForViewer,
  deleteAutomationTemplateForViewer,
  listAutomationTemplatesForViewer,
  requireAccessGrant,
  scheduledTaskViewerForGrant,
  updateAutomationTemplateForViewer,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestJson } from "../http/request-body";

/**
 * Automation templates a workspace keeps: saved from an automation, for
 * anyone in the workspace to start one from. Reading needs what running an
 * automation needs; saving, changing and deleting need what managing one
 * needs, and changing or deleting someone else's needs an admin.
 */
export function registerAutomationTemplateRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;
  const path = "/v1/workspaces/:workspaceId/automation-templates";

  async function viewerFor(
    c: Context,
    permission: "scheduled_tasks:run" | "scheduled_tasks:manage",
  ) {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    const viewer = await scheduledTaskViewerForGrant(db, grant, deps.settings);
    return { grant, viewer, workspaceId };
  }

  function templateIdParam(c: Context): string {
    const templateId = c.req.param("templateId") ?? "";
    if (!z.string().uuid().safeParse(templateId).success) {
      throw new HTTPException(404, { message: "automation template not found" });
    }
    return templateId;
  }

  app.get(path, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:run");
    const templates = await listAutomationTemplatesForViewer(db, workspaceId, viewer);
    return c.json(ListAutomationTemplatesResponse.parse({ templates }));
  });

  app.post(path, async (c) => {
    const { grant, viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const request = await parseRequestJson(c, CreateAutomationTemplateRequest);
    const template = await createAutomationTemplateForViewer({
      db,
      accountId: grant.accountId,
      workspaceId,
      viewer,
      request,
    });
    return c.json(AutomationTemplateResponse.parse({ template }), 201);
  });

  app.patch(`${path}/:templateId`, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const templateId = templateIdParam(c);
    const request = await parseRequestJson(c, UpdateAutomationTemplateRequest);
    const template = await updateAutomationTemplateForViewer({
      db,
      workspaceId,
      templateId,
      viewer,
      request,
    });
    return c.json(AutomationTemplateResponse.parse({ template }));
  });

  app.delete(`${path}/:templateId`, async (c) => {
    const { viewer, workspaceId } = await viewerFor(c, "scheduled_tasks:manage");
    const templateId = templateIdParam(c);
    await deleteAutomationTemplateForViewer({ db, workspaceId, templateId, viewer });
    return c.json({ ok: true });
  });
}
