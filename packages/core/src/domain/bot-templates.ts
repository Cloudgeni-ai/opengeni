import {
  SessionAvatar,
  type BotTemplateVisibility,
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
 * Bot templates saved in a workspace. A shared one is for everyone in the
 * workspace to start bots from; whoever saved it, an admin, or a
 * workspace-level caller may change or delete it. An Only me one exists only
 * for whoever saved it, like an Only me chat: nobody else reads, finds or
 * changes it. The server stores templates and never starts a chat from one:
 * the client opens a new chat with the template's setup instructions as its
 * first message and gives it the template's name, description and avatar.
 */

/**
 * Who reads a template: the person (null for a service), whether they
 * administer the workspace, and whether they may start chats there, which is
 * what saving and changing templates needs.
 */
export type BotTemplateViewer = { subjectId: string | null; admin: boolean; contributor: boolean };

/** The person a grant reads templates as (or the person an agent acts for). */
export async function botTemplateViewerForGrant(
  db: Database,
  grant: AccessGrant,
): Promise<BotTemplateViewer> {
  return {
    subjectId: await scheduledTaskViewerSubjectForGrant(db, grant),
    admin: hasPermission(grant.permissions, "workspace:admin", grant.permissionMode),
    contributor: hasPermission(grant.permissions, "sessions:create", grant.permissionMode),
  };
}

/**
 * A workspace template is shared work, like a shared Skill or Site: everyone
 * who may start chats can change or delete it. An Only me template stays with
 * whoever saved it.
 */
export function botTemplateAccess(
  viewer: BotTemplateViewer,
  template: Pick<BotTemplateRecord, "createdBySubjectId" | "visibility">,
): "manage" | "use" {
  if (viewer.admin || viewer.subjectId === null) return "manage";
  if (template.visibility === "workspace" && viewer.contributor) return "manage";
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
    visibility: template.visibility,
    sourceSessionId: template.sourceSessionId,
    createdBySubjectId: template.createdBySubjectId,
    viewerAccess: botTemplateAccess(viewer, template),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

/** Whether the viewer may see the template at all. */
function visibleTo(viewer: BotTemplateViewer, template: BotTemplateRecord): boolean {
  return (
    template.visibility === "workspace" ||
    (viewer.subjectId !== null && template.createdBySubjectId === viewer.subjectId)
  );
}

async function requireTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
  viewer: BotTemplateViewer,
): Promise<BotTemplateRecord> {
  const template = await getBotTemplate(db, workspaceId, templateId);
  if (!template || !visibleTo(viewer, template)) {
    throw new HTTPException(404, { message: "bot template not found" });
  }
  return template;
}

function requireOwnerForPrivate(
  viewer: BotTemplateViewer,
  visibility: BotTemplateVisibility | undefined,
): void {
  if (visibility === "private" && viewer.subjectId === null) {
    throw new HTTPException(422, {
      message:
        "Only a person can keep a bot template to themselves. Save it for the workspace instead.",
    });
  }
}

function requireManage(viewer: BotTemplateViewer, template: BotTemplateRecord): void {
  if (botTemplateAccess(viewer, template) !== "manage") {
    throw new HTTPException(403, {
      message: "Only people who can start chats in this workspace can change its bot templates",
    });
  }
}

export async function listBotTemplatesForViewer(
  db: Database,
  workspaceId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate[]> {
  return (await listBotTemplates(db, workspaceId, viewer.subjectId)).map((template) =>
    forViewer(viewer, template),
  );
}

export async function getBotTemplateForViewer(
  db: Database,
  workspaceId: string,
  templateId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate> {
  return forViewer(viewer, await requireTemplate(db, workspaceId, templateId, viewer));
}

export async function createBotTemplateForViewer(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  viewer: BotTemplateViewer;
  request: ParsedCreateBotTemplateRequest;
}): Promise<WorkspaceBotTemplate> {
  const { db, request, viewer, workspaceId } = input;
  requireOwnerForPrivate(viewer, request.visibility);
  try {
    const created = await createBotTemplate(db, {
      accountId: input.accountId,
      workspaceId,
      name: request.name,
      description: request.description,
      avatar: request.avatar,
      setupInstructions: request.setupInstructions,
      visibility: request.visibility,
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
  const template = await requireTemplate(db, workspaceId, input.templateId, viewer);
  requireManage(viewer, template);
  // Making a template Only me keeps it with whoever saved it, not the caller.
  if (request.visibility === "private" && template.createdBySubjectId === null) {
    throw new HTTPException(422, {
      message:
        "This template was saved for the workspace, not by a person, so it can't become Only me.",
    });
  }
  // ...so only they (or an admin) can take a shared template away from everyone.
  if (
    request.visibility === "private" &&
    template.visibility === "workspace" &&
    !viewer.admin &&
    viewer.subjectId !== template.createdBySubjectId
  ) {
    throw new HTTPException(403, {
      message: "Only whoever saved this bot template, or a workspace admin, can make it Only me.",
    });
  }
  const updated = await updateBotTemplate(db, {
    workspaceId,
    templateId: template.id,
    name: request.name,
    description: request.description,
    avatar: request.avatar,
    setupInstructions: request.setupInstructions,
    visibility: request.visibility,
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
  const template = await requireTemplate(
    input.db,
    input.workspaceId,
    input.templateId,
    input.viewer,
  );
  requireManage(input.viewer, template);
  if (!(await deleteBotTemplate(input.db, input.workspaceId, template.id))) {
    throw new HTTPException(404, { message: "bot template not found" });
  }
}
