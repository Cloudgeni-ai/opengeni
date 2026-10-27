import {
  SessionAvatar,
  type ParsedCreateBotTemplateRequest,
  type ParsedUpdateBotTemplateRequest,
  type WorkspaceBotTemplate,
} from "@opengeni/contracts";
import {
  BotTemplateLimitError,
  createBotTemplate,
  deleteBotTemplate,
  getBotTemplate,
  listBotTemplates,
  updateBotTemplate,
  type BotTemplateRecord,
  type Database,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { scheduledTaskViewerSubjectForGrant } from "./scheduled-task-audience";

/**
 * Bot templates saved in a workspace: everyone in it may start a bot from
 * one; whoever saved it, an admin, or a workspace-level caller may change or
 * delete it. The server stores templates and never starts a chat from one:
 * the client opens a new chat with the template's setup instructions as its
 * first message and gives it the template's name, description and avatar.
 */

export type BotTemplateViewer = { subjectId: string | null; admin: boolean };

/** The person a grant reads templates as (or the person an agent acts for). */
export async function botTemplateViewerForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<BotTemplateViewer> {
  return {
    subjectId: await scheduledTaskViewerSubjectForGrant(db, grant),
    admin: hasPermission(grant.permissions, "workspace:admin", grant.permissionMode),
  };
}

export function botTemplateAccess(
  viewer: BotTemplateViewer,
  template: Pick<BotTemplateRecord, "createdBySubjectId">,
): "manage" | "use" {
  if (viewer.admin || viewer.subjectId === null) return "manage";
  return template.createdBySubjectId !== null && template.createdBySubjectId === viewer.subjectId
    ? "manage"
    : "use";
}

function forViewer(viewer: BotTemplateViewer, template: BotTemplateRecord): WorkspaceBotTemplate {
  const avatar = SessionAvatar.safeParse(template.avatar);
  return {
    id: template.id,
    workspaceId: template.workspaceId,
    name: template.name,
    description: template.description,
    avatar: avatar.success ? avatar.data : null,
    setupInstructions: template.setupInstructions,
    sourceSessionId: template.sourceSessionId,
    createdBySubjectId: template.createdBySubjectId,
    viewerAccess: botTemplateAccess(viewer, template),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

async function requireTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<BotTemplateRecord> {
  const template = await getBotTemplate(db, workspaceId, templateId);
  if (!template) throw new HTTPException(404, { message: "bot template not found" });
  return template;
}

function requireManage(viewer: BotTemplateViewer, template: BotTemplateRecord): void {
  if (botTemplateAccess(viewer, template) !== "manage") {
    throw new HTTPException(403, {
      message: "Only whoever saved this bot template, or a workspace admin, can change it",
    });
  }
}

export async function listBotTemplatesForViewer(
  db: Database,
  workspaceId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate[]> {
  return (await listBotTemplates(db, workspaceId)).map((template) => forViewer(viewer, template));
}

export async function getBotTemplateForViewer(
  db: Database,
  workspaceId: string,
  templateId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate> {
  return forViewer(viewer, await requireTemplate(db, workspaceId, templateId));
}

export async function createBotTemplateForViewer(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  viewer: BotTemplateViewer;
  request: ParsedCreateBotTemplateRequest;
}): Promise<WorkspaceBotTemplate> {
  const { db, request, viewer, workspaceId } = input;
  try {
    const created = await createBotTemplate(db, {
      accountId: input.accountId,
      workspaceId,
      name: request.name,
      description: request.description,
      avatar: request.avatar,
      setupInstructions: request.setupInstructions,
      sourceSessionId: request.sourceSessionId,
      createdBySubjectId: viewer.subjectId,
    });
    return forViewer(viewer, created);
  } catch (error) {
    if (error instanceof BotTemplateLimitError) {
      throw new HTTPException(409, { message: error.message });
    }
    throw error;
  }
}

export async function updateBotTemplateForViewer(input: {
  db: Database;
  workspaceId: string;
  templateId: string;
  viewer: BotTemplateViewer;
  request: ParsedUpdateBotTemplateRequest;
}): Promise<WorkspaceBotTemplate> {
  const { db, request, viewer, workspaceId } = input;
  const template = await requireTemplate(db, workspaceId, input.templateId);
  requireManage(viewer, template);
  const updated = await updateBotTemplate(db, {
    workspaceId,
    templateId: template.id,
    name: request.name,
    description: request.description,
    avatar: request.avatar,
    setupInstructions: request.setupInstructions,
  });
  if (!updated) throw new HTTPException(404, { message: "bot template not found" });
  return forViewer(viewer, updated);
}

export async function deleteBotTemplateForViewer(input: {
  db: Database;
  workspaceId: string;
  templateId: string;
  viewer: BotTemplateViewer;
}): Promise<void> {
  const template = await requireTemplate(input.db, input.workspaceId, input.templateId);
  requireManage(input.viewer, template);
  if (!(await deleteBotTemplate(input.db, input.workspaceId, template.id))) {
    throw new HTTPException(404, { message: "bot template not found" });
  }
}
