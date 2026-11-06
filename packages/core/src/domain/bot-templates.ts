import {
  AGENTS_PER_WORKSPACE_MAX,
  SessionAvatar,
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  type BotTemplateVisibility,
  type ParsedCreateBotTemplateRequest,
  type ParsedUpdateBotTemplateRequest,
  type WorkspaceBotTemplate,
} from "@opengeni/contracts";
import {
  AgentLimitError,
  AgentPrivateOwnerError,
  createAgent,
  deleteAgent,
  getAgent,
  getWorkspace,
  listAgents,
  listAgentSlackInstalls,
  updateAgent,
  type AgentRecord,
  type Database,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { agentEditableBy, agentViewerCanMakePrivate, agentVisibleTo } from "./agents";
import { scheduledTaskViewerSubjectForGrant } from "./scheduled-task-audience";

/**
 * Bot templates: the compatibility view of agents (docs/agents.md) for the
 * `/bot-templates` endpoints and the `bot_template_save` tool. Every agent the
 * reader can use is a template; its setup instructions are the agent's First
 * message. Saving one makes an agent with that First message and no
 * Instructions, and keeps a legacy `bot_templates` row for older releases.
 *
 * Who may change one follows the agents rule: whoever made it, an admin, or a
 * workspace-level caller. An Only me one exists only for its owner. The server
 * never starts a chat from one: the client opens a new chat with the setup
 * instructions as its first message.
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

/** A template's access for the viewer: `manage` when they may change it. */
export function botTemplateAccess(
  viewer: BotTemplateViewer,
  agent: Pick<AgentRecord, "createdBySubjectId" | "ownerSubjectId" | "visibility">,
): "manage" | "use" {
  return agentEditableBy(viewer, agent) ? "manage" : "use";
}

/** Whether the viewer may make the template Only me. */
export function botTemplateViewerCanMakePrivate(
  viewer: BotTemplateViewer,
  agent: Pick<AgentRecord, "createdBySubjectId" | "ownerSubjectId" | "visibility">,
): boolean {
  return agentViewerCanMakePrivate(viewer, agent);
}

function forViewer(viewer: BotTemplateViewer, agent: AgentRecord): WorkspaceBotTemplate {
  const avatar = SessionAvatar.safeParse(agent.avatar);
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    description: agent.description,
    avatar: avatar.success ? avatar.data : null,
    setupInstructions: agent.content?.firstMessage ?? "",
    visibility: agent.visibility,
    sourceSessionId: agent.sourceSessionId,
    // An Only me template belongs to whoever saved it.
    createdBySubjectId:
      agent.visibility === "private" ? agent.ownerSubjectId : agent.createdBySubjectId,
    viewerAccess: botTemplateAccess(viewer, agent),
    viewerCanMakePrivate: botTemplateViewerCanMakePrivate(viewer, agent),
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

async function homeOf(db: Database, workspaceId: string) {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) throw new HTTPException(404, { message: "bot template not found" });
  return { accountId: workspace.accountId, workspaceId };
}

async function requireTemplate(
  db: Database,
  workspaceId: string,
  templateId: string,
  viewer: BotTemplateViewer,
): Promise<{ home: { accountId: string; workspaceId: string }; agent: AgentRecord }> {
  const home = await homeOf(db, workspaceId);
  const agent = await getAgent(db, home, templateId);
  if (!agent || !agentVisibleTo(viewer, agent)) {
    throw new HTTPException(404, { message: "bot template not found" });
  }
  return { home, agent };
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

function requireManage(viewer: BotTemplateViewer, agent: AgentRecord): void {
  if (botTemplateAccess(viewer, agent) !== "manage") {
    throw new HTTPException(403, {
      message: "Only whoever made this agent, or a workspace admin, can change it.",
    });
  }
}

export async function listBotTemplatesForViewer(
  db: Database,
  workspaceId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate[]> {
  const home = await homeOf(db, workspaceId);
  // The old gallery opens a template as composer text, in a chat not bound to
  // the agent, so it lists only agents with a First message (or made as
  // templates); the others' Instructions would silently not apply.
  return (await listAgents(db, home, { viewerSubjectId: viewer.subjectId, withContent: true }))
    .filter((agent) => agent.origin === "bot_template" || Boolean(agent.content?.firstMessage))
    .map((agent) => forViewer(viewer, agent));
}

export async function getBotTemplateForViewer(
  db: Database,
  workspaceId: string,
  templateId: string,
  viewer: BotTemplateViewer,
): Promise<WorkspaceBotTemplate> {
  return forViewer(viewer, (await requireTemplate(db, workspaceId, templateId, viewer)).agent);
}

export async function createBotTemplateForViewer(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  viewer: BotTemplateViewer;
  request: ParsedCreateBotTemplateRequest;
  /** Standing Instructions, for `bot_template_save`; the endpoint has none. */
  instructions?: string;
}): Promise<WorkspaceBotTemplate> {
  const { db, request, viewer, workspaceId } = input;
  requireOwnerForPrivate(viewer, request.visibility);
  try {
    const { agent } = await createAgent(
      db,
      { accountId: input.accountId, workspaceId },
      {
        visibility: request.visibility,
        ownerSubjectId: request.visibility === "private" ? viewer.subjectId : null,
        name: request.name,
        description: request.description,
        avatar: request.avatar,
        instructions: input.instructions ?? "",
        firstMessage: request.setupInstructions,
        memoryEnabled: false,
        origin: "bot_template",
        sourceSessionId: request.sourceSessionId,
        createdBySubjectId: viewer.subjectId,
        legacyBotTemplate: true,
        maxPerWorkspace: AGENTS_PER_WORKSPACE_MAX,
      },
    );
    return forViewer(viewer, agent);
  } catch (error) {
    if (error instanceof AgentLimitError) {
      throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof AgentPrivateOwnerError) {
      throw new HTTPException(422, { message: error.message });
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
  const { home, agent } = await requireTemplate(db, workspaceId, input.templateId, viewer);
  requireManage(viewer, agent);
  const makesPrivate = request.visibility === "private" && agent.visibility !== "private";
  if (makesPrivate && !botTemplateViewerCanMakePrivate(viewer, agent)) {
    throw new HTTPException(agent.createdBySubjectId === null ? 422 : 403, {
      message:
        agent.createdBySubjectId === null
          ? "This template was saved for the workspace, not by a person, so it can't become Only me."
          : "Only whoever saved this bot template, or a workspace admin, can make it Only me.",
    });
  }
  const changesVisibility =
    request.visibility !== undefined && request.visibility !== agent.visibility;
  const renamesSlackHandle =
    request.name !== undefined && slackAgentNameKey(request.name) !== slackAgentNameKey(agent.name);
  if (makesPrivate || renamesSlackHandle) {
    const inSlack = (await listAgentSlackInstalls(db, home, [agent.id])).length > 0;
    if (inSlack && makesPrivate) {
      throw new HTTPException(409, {
        message: "This agent is available in Slack, so it stays shared with the workspace.",
      });
    }
    const problem =
      inSlack && request.name !== undefined ? slackAgentNameProblem(request.name) : null;
    if (problem && request.name !== undefined) {
      throw new HTTPException(422, { message: slackAgentNameProblemText(request.name, problem) });
    }
  }
  if (changesVisibility && agent.memoryEnabled) {
    throw new HTTPException(409, {
      message: "This agent remembers across chats. Turn Memory off to change who can use it.",
    });
  }
  const outcome = await updateAgent(db, home, {
    agentId: agent.id,
    expectedVersion: null,
    actorSubjectId: viewer.subjectId,
    patch: {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.avatar !== undefined ? { avatar: request.avatar } : {}),
      ...(request.setupInstructions !== undefined
        ? { firstMessage: request.setupInstructions }
        : {}),
      ...(changesVisibility && request.visibility !== undefined
        ? {
            visibility: request.visibility,
            ownerSubjectId: request.visibility === "private" ? agent.createdBySubjectId : null,
          }
        : {}),
    },
  }).catch((error: unknown) => {
    if (error instanceof AgentPrivateOwnerError) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  });
  if (outcome.kind === "slack_name_taken") {
    throw new HTTPException(409, {
      message: "Another agent in Slack already has this name.",
    });
  }
  if (outcome.kind === "requires_workspace_visibility") {
    throw new HTTPException(409, {
      message: "This agent is available in Slack, so it stays shared with the workspace.",
    });
  }
  if (outcome.kind !== "updated") {
    throw new HTTPException(404, { message: "bot template not found" });
  }
  return forViewer(viewer, outcome.agent);
}

export async function deleteBotTemplateForViewer(input: {
  db: Database;
  workspaceId: string;
  templateId: string;
  viewer: BotTemplateViewer;
}): Promise<void> {
  const { home, agent } = await requireTemplate(
    input.db,
    input.workspaceId,
    input.templateId,
    input.viewer,
  );
  requireManage(input.viewer, agent);
  if (!(await deleteAgent(input.db, home, agent.id))) {
    throw new HTTPException(404, { message: "bot template not found" });
  }
}
