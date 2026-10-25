import {
  AutomationTemplateSchedule,
  AutomationTemplateTrigger,
  type ParsedCreateAutomationTemplateRequest,
  type ParsedUpdateAutomationTemplateRequest,
  type WorkspaceAutomationTemplate,
} from "@opengeni/contracts";
import {
  AutomationTemplateLimitError,
  createAutomationTemplate,
  deleteAutomationTemplate,
  getAutomationTemplate,
  getEventSource,
  listAutomationTemplates,
  updateAutomationTemplate,
  type AutomationTemplateRecord,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ScheduledTaskViewer } from "./scheduled-task-audience";

/**
 * Automation templates saved in a workspace: everyone in it may use them;
 * whoever saved one, an admin, or a workspace-level caller may change or
 * delete it. The server stores templates and never makes an automation from
 * one: the client fills its form with a template and saves an automation.
 */

export type AutomationTemplateViewer = Pick<ScheduledTaskViewer, "subjectId" | "admin">;

/** What is stored in `definition`. Unknown keys from newer versions are ignored. */
const StoredDefinition = z.object({
  instructions: z.string(),
  schedule: AutomationTemplateSchedule.nullable(),
  triggers: z.array(AutomationTemplateTrigger),
  maxRunsPerHour: z.number().int().nullable(),
});
type StoredDefinition = z.output<typeof StoredDefinition>;

export function automationTemplateAccess(
  viewer: AutomationTemplateViewer,
  template: Pick<AutomationTemplateRecord, "createdBySubjectId">,
): "manage" | "use" {
  if (viewer.admin || viewer.subjectId === null) return "manage";
  return template.createdBySubjectId !== null && template.createdBySubjectId === viewer.subjectId
    ? "manage"
    : "use";
}

/** The template as the API returns it; null for a row this version can't read. */
function forViewer(
  viewer: AutomationTemplateViewer,
  template: AutomationTemplateRecord,
): WorkspaceAutomationTemplate | null {
  const definition = StoredDefinition.safeParse(template.definition);
  if (!definition.success) return null;
  return {
    id: template.id,
    workspaceId: template.workspaceId,
    name: template.name,
    description: template.description,
    ...definition.data,
    createdBySubjectId: template.createdBySubjectId,
    viewerAccess: automationTemplateAccess(viewer, template),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
  };
}

function readable(
  viewer: AutomationTemplateViewer,
  template: AutomationTemplateRecord,
): WorkspaceAutomationTemplate {
  const result = forViewer(viewer, template);
  if (!result) throw new HTTPException(404, { message: "automation template not found" });
  return result;
}

/**
 * A trigger may name a source shared with the workspace, so everyone who uses
 * the template listens on it. A private source is never named: it would be
 * meaningless to anyone else.
 */
async function checkNamedSources(
  db: Database,
  workspaceId: string,
  triggers: StoredDefinition["triggers"],
): Promise<void> {
  for (const trigger of triggers) {
    const { sourceId } = trigger.source;
    if (!sourceId) continue;
    const source = await getEventSource(db, workspaceId, sourceId);
    const matches =
      source !== null &&
      source.visibility === "workspace" &&
      source.kind === trigger.source.kind &&
      (source.adapter ?? undefined) === trigger.source.adapter &&
      (source.mcpServerId ?? undefined) === trigger.source.mcpServerId;
    if (!matches) {
      throw new HTTPException(422, {
        message:
          "A template can name only a source shared with the workspace, of the kind its trigger says",
      });
    }
  }
}

function definitionOf(content: StoredDefinition): Record<string, unknown> {
  return {
    instructions: content.instructions,
    schedule: content.schedule,
    triggers: content.triggers,
    maxRunsPerHour: content.maxRunsPerHour,
  };
}

async function requireTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
): Promise<AutomationTemplateRecord> {
  const template = await getAutomationTemplate(db, workspaceId, templateId);
  if (!template) throw new HTTPException(404, { message: "automation template not found" });
  return template;
}

function requireManage(viewer: AutomationTemplateViewer, template: AutomationTemplateRecord): void {
  if (automationTemplateAccess(viewer, template) !== "manage") {
    throw new HTTPException(403, {
      message: "Only whoever saved this template, or a workspace admin, can change it",
    });
  }
}

export async function listAutomationTemplatesForViewer(
  db: Database,
  workspaceId: string,
  viewer: AutomationTemplateViewer,
): Promise<WorkspaceAutomationTemplate[]> {
  const templates = await listAutomationTemplates(db, workspaceId);
  return templates.flatMap((template) => forViewer(viewer, template) ?? []);
}

export async function createAutomationTemplateForViewer(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  viewer: AutomationTemplateViewer;
  request: ParsedCreateAutomationTemplateRequest;
}): Promise<WorkspaceAutomationTemplate> {
  const { db, request, viewer, workspaceId } = input;
  await checkNamedSources(db, workspaceId, request.triggers);
  try {
    const created = await createAutomationTemplate(db, {
      accountId: input.accountId,
      workspaceId,
      name: request.name,
      description: request.description,
      definition: definitionOf(request),
      createdBySubjectId: viewer.subjectId,
    });
    return readable(viewer, created);
  } catch (error) {
    if (error instanceof AutomationTemplateLimitError) {
      throw new HTTPException(409, { message: error.message });
    }
    throw error;
  }
}

export async function updateAutomationTemplateForViewer(input: {
  db: Database;
  workspaceId: string;
  templateId: string;
  viewer: AutomationTemplateViewer;
  request: ParsedUpdateAutomationTemplateRequest;
}): Promise<WorkspaceAutomationTemplate> {
  const { db, request, viewer, workspaceId } = input;
  const template = await requireTemplate(db, workspaceId, input.templateId);
  requireManage(viewer, template);
  const current = readable(viewer, template);
  const changesContent =
    request.instructions !== undefined ||
    request.schedule !== undefined ||
    request.triggers !== undefined ||
    request.maxRunsPerHour !== undefined;
  const content: StoredDefinition = {
    instructions: request.instructions ?? current.instructions,
    schedule: request.schedule !== undefined ? request.schedule : current.schedule,
    triggers: request.triggers ?? current.triggers,
    maxRunsPerHour:
      request.maxRunsPerHour !== undefined ? request.maxRunsPerHour : current.maxRunsPerHour,
  };
  if (request.triggers !== undefined) await checkNamedSources(db, workspaceId, content.triggers);
  const updated = await updateAutomationTemplate(db, {
    workspaceId,
    templateId: template.id,
    name: request.name,
    description: request.description,
    definition: changesContent ? definitionOf(content) : undefined,
  });
  if (!updated) throw new HTTPException(404, { message: "automation template not found" });
  return readable(viewer, updated);
}

export async function deleteAutomationTemplateForViewer(input: {
  db: Database;
  workspaceId: string;
  templateId: string;
  viewer: AutomationTemplateViewer;
}): Promise<void> {
  const template = await requireTemplate(input.db, input.workspaceId, input.templateId);
  requireManage(input.viewer, template);
  if (!(await deleteAutomationTemplate(input.db, input.workspaceId, template.id))) {
    throw new HTTPException(404, { message: "automation template not found" });
  }
}
