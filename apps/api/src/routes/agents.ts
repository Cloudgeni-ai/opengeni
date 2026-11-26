/**
 * Agents (docs/agents.md): `/v1/workspaces/:workspaceId/agents`.
 *
 * The path workspace is the agent's home, where its chats run. Reading needs
 * what reading chats needs, and an Only me agent is visible only to its
 * owner. Making and changing agents needs what starting a chat needs; a
 * change also needs the agent's creator or a workspace admin, or on a shared
 * agent whose "Who can edit" is everyone, anyone in its workspace. Who can use
 * or edit it, and deleting it, stay with its creator and admins. A shared agent
 * is available in every Slack workspace linked to its workspace, with no
 * separate step (see integrations/agent-slack-availability.ts), so the Slack
 * name rules apply when a shared agent is created, renamed or shared; open use
 * in Slack needs the request's organization admin proof.
 */

import {
  AgentChatsFilter,
  AgentListFilter,
  AgentResponse,
  AgentSlackAvailabilityResponse,
  AgentSlackIntroRequest,
  CreateAgentFromTemplateRequest,
  CreateAgentRequest,
  DeleteAgentResponse,
  ListAgentTemplatesResponse,
  ListAgentChatsResponse,
  ListAgentRevisionsResponse,
  ListAgentSlackInstallsResponse,
  ListAgentsResponse,
  PutAgentSlackAvailabilityRequest,
  SessionAvatar,
  AgentReadinessListResponse,
  SetupReadinessResponse,
  UpdateAgentRequest,
  AGENTS_PER_WORKSPACE_MAX,
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  type AccessGrant,
  type AgentErrorCode,
} from "@opengeni/contracts";
import {
  AgentEditRefusedError,
  AgentLimitError,
  AgentPrivateOwnerError,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentLearningSettings,
  getSessionForSubject,
  getSlackAgent,
  getWorkspace,
  listAgentChats,
  listAgentRevisions,
  listAgents,
  listAgentSlackInstalls,
  listSlackInstallationBindings,
  putAgentSlackInstall,
  updateAgent,
  type AgentRecord,
  type AgentSlackInstallRecord,
} from "@opengeni/db";
import {
  agentTemplateByKey,
  agentTemplates,
  agentChatView,
  agentEditableBy,
  agentManageableBy,
  agentRevisionView,
  agentSlackAvailabilityView,
  agentSummaryView,
  agentView,
  agentViewerCanMakePrivate,
  agentViewerForGrant,
  agentVisibilityRecord,
  agentVisibilityValue,
  agentVisibleTo,
  authorizationHoldsOrganizationAdministration,
  knowledgeContextForAccess,
  MissingPermissionRefusal,
  requireAccessGrantAuthorization,
  type AccessGrantAuthorization,
  type AgentViewContext,
  type AgentViewer,
  type ApiRouteDeps,
  agentsReadinessPurposes,
  setupReadinessFor,
  setupReadinessForMany,
  templateTriggerUsesGitHubEvents,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { ensureAgentMemoryCollection } from "../integrations/agent-memory-collection";
import {
  agentHomeIsPersonalWorkspace,
  agentSlackNameRefusal,
  agentSlackUnavailableReason,
  ensureAgentInLinkedSlack,
  linkedSlackInstallations,
  type AgentSlackNameRefusal,
} from "../integrations/agent-slack-availability";
import { slackAgentInstallationFor } from "../integrations/slack-agent-create";
import { requireUsableSessionAvatar } from "./session-avatar";
import { postSlackAgentIntro, slackAgentChannelList } from "./slack-agents";

type Home = { accountId: string; workspaceId: string };

type RequestContext = {
  access: AccessGrantAuthorization;
  grant: AccessGrant;
  viewer: AgentViewer;
  home: Home;
};

function agentError(
  status: number,
  code: AgentErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): ApiHttpError {
  return new ApiHttpError(status, {
    code: status === 409 ? "conflict" : status === 403 ? "forbidden" : "validation_failed",
    message,
    retryable: false,
    details: { code, ...extra },
  });
}

/** An Only me agent whose owner the organization does not know as a member. */
function privateOwnerError(error: unknown): unknown {
  return error instanceof AgentPrivateOwnerError
    ? new ApiHttpError(422, { code: "validation_failed", message: error.message, retryable: false })
    : error;
}

/** A name Slack can't use, or one another agent there answers to. */
function slackNameError(refusal: AgentSlackNameRefusal): ApiHttpError {
  return refusal.code === "agent_slack_name_taken"
    ? agentError(409, refusal.code, refusal.message, {
        connectionId: refusal.connectionId,
        slackTeamName: refusal.slackTeamName,
      })
    : agentError(422, refusal.code, refusal.message, { problem: refusal.problem });
}

function notFound(): ApiHttpError {
  return new ApiHttpError(404, { code: "not_found", message: "Agent not found", retryable: false });
}

/** Cursor of a chat list: the last chat's start and id. */
function encodeChatCursor(chat: { cursorAt: string; sessionId: string }): string {
  return Buffer.from(`${chat.cursorAt}|${chat.sessionId}`).toString("base64url");
}

function decodeChatCursor(
  value: string | undefined,
): { createdAt: string; sessionId: string } | null {
  if (!value) return null;
  const [at, sessionId] = Buffer.from(value, "base64url").toString("utf8").split("|");
  // Microseconds are kept, so chats made in the same millisecond page correctly.
  if (
    !at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/u.test(at) ||
    Number.isNaN(new Date(at).getTime()) ||
    !z.string().uuid().safeParse(sessionId).success
  ) {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message: "cursor is not one this list returned",
      retryable: false,
    });
  }
  return { createdAt: at, sessionId: sessionId! };
}

function limitParam(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(100, Math.trunc(parsed)) : fallback;
}

/** Create the agent's Memory collection, as the person or key making the request. */
async function ensureAgentMemory(
  deps: ApiRouteDeps,
  context: RequestContext,
  agent: AgentRecord,
): Promise<AgentRecord> {
  const { agent: updated } = await ensureAgentMemoryCollection(
    deps.db,
    context.home,
    agent,
    (save) =>
      withAccessGrantSessionRlsContext(deps, context.grant, async () =>
        save(await knowledgeContextForAccess(deps, context.access, "documents:manage")),
      ),
  );
  return updated;
}

export function registerAgentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db } = deps;
  const base = "/v1/workspaces/:workspaceId/agents";

  async function requestContext(
    c: Context,
    permission: "sessions:read" | "sessions:create" | "workspace:admin",
  ): Promise<RequestContext> {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, permission);
    const grant = access.grant;
    return {
      access,
      grant,
      viewer: await agentViewerForGrant(db, grant),
      home: { accountId: grant.accountId, workspaceId },
    };
  }

  function agentIdParam(c: Context): string {
    const parsed = z.string().uuid().safeParse(c.req.param("agentId"));
    if (!parsed.success) throw notFound();
    return parsed.data;
  }

  async function requireVisibleAgent(c: Context, context: RequestContext): Promise<AgentRecord> {
    const agent = await getAgent(db, context.home, agentIdParam(c));
    if (!agent || !agentVisibleTo(context.viewer, agent)) throw notFound();
    return agent;
  }

  const EDIT_REFUSED = "Only whoever made this agent, or a workspace admin, can change it.";
  const MANAGE_REFUSED =
    "Only whoever made this agent, or a workspace admin, can change who can use or edit it, or delete it.";

  function forbidden(message: string): ApiHttpError {
    return new ApiHttpError(403, { code: "forbidden", message, retryable: false });
  }

  function requireEditable(context: RequestContext, agent: AgentRecord): void {
    if (!agentEditableBy(context.viewer, agent)) throw forbidden(EDIT_REFUSED);
  }

  /** Who can use or edit it, and deleting it: its creator or an admin. */
  function requireManageable(context: RequestContext, agent: AgentRecord): void {
    if (!agentManageableBy(context.viewer, agent)) throw forbidden(MANAGE_REFUSED);
  }

  /**
   * Letting anyone in the organization use an agent opens it beyond its
   * workspace, so it takes the organization's owner or one of its admins
   * (organization administration, not the owner-only `account:admin`).
   * Narrowing it back does not.
   */
  function requireOrganizationAccessAdmin(context: RequestContext): void {
    if (!isOrganizationAdmin(context)) throw new MissingPermissionRefusal("account:admin");
  }

  async function memoryReviewFirst(context: RequestContext): Promise<boolean> {
    try {
      return await withAccessGrantSessionRlsContext(deps, context.grant, async () => {
        const knowledge = await knowledgeContextForAccess(deps, context.access, "workspace:read");
        const settings = await getAgentLearningSettings(db, knowledge, "workspace");
        return settings.settings.knowledge === "review_first";
      });
    } catch {
      return false;
    }
  }

  /** The organization's owner or one of its admins, signed in as themselves. */
  function isOrganizationAdmin(context: RequestContext): boolean {
    return authorizationHoldsOrganizationAdministration(context.access);
  }

  /** Slack workspace names by installation, read from each installation's own workspace. */
  async function slackTeamNames(
    accountId: string,
    installs: readonly AgentSlackInstallRecord[],
  ): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const homes = new Set(installs.map((install) => install.installWorkspaceId));
    for (const workspaceId of homes) {
      const bindings = await listSlackInstallationBindings(db, { accountId, workspaceId }).catch(
        () => [],
      );
      for (const binding of bindings) names.set(binding.connectionId, binding.slackTeamName);
    }
    return names;
  }

  async function viewContext(
    context: RequestContext,
    agents: readonly AgentRecord[],
  ): Promise<AgentViewContext> {
    const installs = await listAgentSlackInstalls(
      db,
      context.home,
      agents.map((agent) => agent.id),
    );
    return {
      viewer: context.viewer,
      installs,
      slackTeamNames: await slackTeamNames(context.home.accountId, installs),
      memoryReviewFirst: await memoryReviewFirst(context),
      viewerIsOrganizationAdmin: isOrganizationAdmin(context),
    };
  }

  async function agentBody(context: RequestContext, agent: AgentRecord) {
    return AgentResponse.parse({ agent: agentView(agent, await viewContext(context, [agent])) });
  }

  // --- Agents ------------------------------------------------------------

  app.get(base, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    const filter = AgentListFilter.safeParse(c.req.query("filter") ?? "all");
    const agents = await listAgents(db, context.home, {
      viewerSubjectId: context.viewer.subjectId,
      filter: filter.success ? filter.data : "all",
    });
    const view = await viewContext(context, agents);
    return c.json(
      ListAgentsResponse.parse({ agents: agents.map((agent) => agentSummaryView(agent, view)) }),
    );
  });

  /**
   * Readiness of every agent the viewer can see, reading the catalog once
   * (the Agents list). Registered before `/:agentId`.
   */
  app.get(`${base}/readiness`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    const agents = await listAgents(db, context.home, {
      viewerSubjectId: context.viewer.subjectId,
      filter: "all",
    });
    const readiness = await setupReadinessForMany(
      deps,
      context.grant,
      agents.map((agent) =>
        agent.templateKey ? agentTemplateByKey(agent.templateKey)?.setup : undefined,
      ),
      // GitHub events only for agents whose own triggers run on them.
      await agentsReadinessPurposes(
        db,
        context.grant.workspaceId,
        context.grant.subjectId ?? null,
        agents,
      ),
    );
    return c.json(
      AgentReadinessListResponse.parse({
        agents: agents.map((agent, index) => ({ agentId: agent.id, readiness: readiness[index] })),
      }),
    );
  });

  app.get(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    return c.json(await agentBody(context, await requireVisibleAgent(c, context)));
  });

  app.post(base, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const request = await parseRequestJson(c, CreateAgentRequest);
    return c.json(await agentBody(context, await createAgentFor(context, request, null)), 201);
  });

  // --- Ready-made agents ("Add an agent") --------------------------------

  const templatesBase = "/v1/workspaces/:workspaceId/agent-templates";

  app.get(templatesBase, async (c) => {
    await requestContext(c, "sessions:read");
    return c.json(ListAgentTemplatesResponse.parse({ templates: agentTemplates() }));
  });

  /**
   * Add a ready-made agent: an ordinary agent with the template's
   * Instructions, Memory, Can use and Skills. Its suggested triggers are not
   * created; the agent page offers them to set up.
   */
  app.post(`${templatesBase}/:templateKey/agents`, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const template = agentTemplateByKey(c.req.param("templateKey") ?? "");
    if (!template) {
      throw agentError(
        404,
        "agent_template_not_found",
        "There is no ready-made agent with that key.",
      );
    }
    const overrides = await parseRequestJson(c, CreateAgentFromTemplateRequest);
    const request = CreateAgentRequest.parse({
      name: overrides.name ?? template.name,
      description: template.description,
      avatar: template.avatar,
      visibility: overrides.visibility ?? "workspace",
      ...(overrides.editAccess ? { editAccess: overrides.editAccess } : {}),
      instructions: template.instructions,
      memoryEnabled: template.memoryEnabled,
      toolPermissions: template.toolPermissions,
      skills: template.skills,
    });
    return c.json(
      await agentBody(context, await createAgentFor(context, request, template.key)),
      201,
    );
  });

  /**
   * Readiness of a ready-made agent before it is added (the Enable page): its
   * connections, which the viewer already has, and what keeps it off.
   */
  app.get(`${templatesBase}/:templateKey/readiness`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    const template = agentTemplateByKey(c.req.param("templateKey") ?? "");
    if (!template) {
      throw agentError(
        404,
        "agent_template_not_found",
        "There is no ready-made agent with that key.",
      );
    }
    return c.json(
      SetupReadinessResponse.parse({
        readiness: await setupReadinessFor(deps, context.grant, template.setup, {
          githubEvents: templateTriggerUsesGitHubEvents(template, c.req.query("trigger")),
        }),
      }),
    );
  });

  /**
   * Readiness of an agent for the viewer: an agent added from a ready-made
   * one needs that template's required connections; any other is ready.
   * Its triggers can't be turned on until it is (routes/scheduled-tasks.ts).
   */
  app.get(`${base}/:agentId/readiness`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    const agent = await requireVisibleAgent(c, context);
    const template = agent.templateKey ? agentTemplateByKey(agent.templateKey) : undefined;
    return c.json(
      SetupReadinessResponse.parse({
        readiness: await setupReadinessFor(
          deps,
          context.grant,
          template?.setup,
          // A named trigger (Enable), else the agent's own triggers.
          template && c.req.query("trigger")
            ? { githubEvents: templateTriggerUsesGitHubEvents(template, c.req.query("trigger")) }
            : ((
                await agentsReadinessPurposes(
                  db,
                  context.grant.workspaceId,
                  context.grant.subjectId ?? null,
                  [agent],
                )
              )[0] ?? {}),
        ),
      }),
    );
  });

  async function createAgentFor(
    context: RequestContext,
    request: z.output<typeof CreateAgentRequest>,
    templateKey: string | null,
  ): Promise<AgentRecord> {
    const { grant, viewer, home } = context;
    const access = agentVisibilityRecord(request.visibility);
    if (access.organizationAccess) requireOrganizationAccessAdmin(context);
    if (access.visibility === "private" && viewer.subjectId === null) {
      throw new ApiHttpError(422, {
        code: "validation_failed",
        message:
          "Only a person can keep an agent to themselves. Share it with the workspace instead.",
        retryable: false,
      });
    }
    if (
      request.sourceSessionId !== null &&
      !(await getSessionForSubject(db, home.workspaceId, request.sourceSessionId, grant.subjectId))
    ) {
      throw new ApiHttpError(422, {
        code: "validation_failed",
        message: "sourceSessionId must be a chat in this workspace that you can open.",
        retryable: false,
      });
    }
    await requireUsableSessionAvatar(deps, grant, request.avatar, {
      sharedWithWorkspace: access.visibility === "workspace",
    });
    if (access.visibility === "workspace") {
      const refusal = await agentSlackNameRefusal(deps, home, {
        agentId: null,
        name: request.name,
      });
      if (refusal) throw slackNameError(refusal);
    }
    let created: AgentRecord;
    try {
      created = (
        await createAgent(db, home, {
          visibility: access.visibility,
          ownerSubjectId: access.visibility === "private" ? viewer.subjectId : null,
          organizationAccess: access.organizationAccess,
          editAccess: request.editAccess,
          name: request.name,
          description: request.description,
          avatar: request.avatar,
          instructions: request.instructions,
          firstMessage: request.firstMessage,
          memoryEnabled: request.memoryEnabled,
          toolPermissions: request.toolPermissions,
          skills: request.skills,
          templateKey,
          origin: "app",
          sourceSessionId: request.sourceSessionId,
          createdBySubjectId: viewer.subjectId,
          maxPerWorkspace: AGENTS_PER_WORKSPACE_MAX,
        })
      ).agent;
    } catch (error) {
      if (error instanceof AgentLimitError) {
        throw agentError(409, "agent_limit_reached", error.message);
      }
      throw privateOwnerError(error);
    }
    // Read it back with where it is available in Slack.
    await ensureAgentInLinkedSlack(deps, home, created);
    return await ensureAgentMemory(
      deps,
      context,
      (await getAgent(db, home, created.id)) ?? created,
    );
  }

  app.patch(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const current = await requireVisibleAgent(c, context);
    requireEditable(context, current);
    const request = await parseRequestJson(c, UpdateAgentRequest);
    const { grant, viewer, home } = context;
    const access = agentVisibilityRecord(request.visibility ?? agentVisibilityValue(current));
    const visibility = access.visibility;
    const changesVisibility = visibility !== current.visibility;
    const changesOrganizationAccess = access.organizationAccess !== current.organizationAccess;
    const changesEditAccess =
      request.editAccess !== undefined && request.editAccess !== current.editAccess;
    // Who can use or edit it stays with its creator and admins.
    const manages = changesVisibility || changesOrganizationAccess || changesEditAccess;
    if (manages) requireManageable(context, current);
    if (access.organizationAccess && changesOrganizationAccess) {
      requireOrganizationAccessAdmin(context);
    }
    // Making it Only me takes it out of Slack (see updateAgent).
    if (changesVisibility && visibility === "private") {
      if (!agentViewerCanMakePrivate(viewer, current)) {
        throw new ApiHttpError(current.createdBySubjectId === null ? 422 : 403, {
          code: current.createdBySubjectId === null ? "validation_failed" : "forbidden",
          message:
            current.createdBySubjectId === null
              ? "No person made this agent, so it can't become Only me."
              : "Only whoever made this agent, or a workspace admin, can make it Only me.",
          retryable: false,
        });
      }
    }
    // A shared agent's name is how people ask it in Slack: checked when it
    // changes and when the agent becomes shared. An older name that is kept
    // is never rechecked, so older agents still save.
    const renames =
      request.name !== undefined &&
      slackAgentNameKey(request.name) !== slackAgentNameKey(current.name);
    if (visibility === "workspace" && (renames || changesVisibility)) {
      const refusal = await agentSlackNameRefusal(deps, home, {
        agentId: current.id,
        name: request.name ?? current.name,
      });
      if (refusal) throw slackNameError(refusal);
    }
    if (request.avatar !== undefined || changesVisibility) {
      const stored = SessionAvatar.safeParse(current.avatar);
      await requireUsableSessionAvatar(
        deps,
        grant,
        request.avatar === undefined ? (stored.success ? stored.data : null) : request.avatar,
        { sharedWithWorkspace: visibility === "workspace" },
      );
    }
    const outcome = await updateAgent(db, home, {
      agentId: current.id,
      expectedVersion: request.expectedVersion,
      actorSubjectId: viewer.subjectId,
      // Rechecked under the row lock: who can edit it may have just changed.
      authorize: (locked) =>
        manages ? agentManageableBy(viewer, locked) : agentEditableBy(viewer, locked),
      patch: {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.avatar !== undefined ? { avatar: request.avatar } : {}),
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...(request.firstMessage !== undefined ? { firstMessage: request.firstMessage } : {}),
        ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
        ...(request.toolPermissions !== undefined
          ? { toolPermissions: request.toolPermissions }
          : {}),
        ...(request.skills !== undefined ? { skills: request.skills } : {}),
        ...(changesOrganizationAccess ? { organizationAccess: access.organizationAccess } : {}),
        ...(changesEditAccess && request.editAccess ? { editAccess: request.editAccess } : {}),
        ...(changesVisibility
          ? {
              visibility,
              ownerSubjectId:
                visibility === "private"
                  ? current.visibility === "private"
                    ? current.ownerSubjectId
                    : current.createdBySubjectId
                  : null,
              // Memory follows who can use the agent: a new collection in the
              // new scope when Memory is on.
              clearMemoryCollection: current.memoryCollectionId !== null,
            }
          : {}),
      },
    }).catch((error: unknown) => {
      if (error instanceof AgentEditRefusedError) {
        throw forbidden(manages ? MANAGE_REFUSED : EDIT_REFUSED);
      }
      throw privateOwnerError(error);
    });
    if (outcome.kind === "not_found") throw notFound();
    if (outcome.kind === "version_conflict") {
      throw agentError(
        409,
        "agent_version_conflict",
        "This agent changed. Refresh and try again.",
        {
          currentVersion: outcome.current.version,
        },
      );
    }
    if (outcome.kind === "slack_name_taken") {
      throw agentError(
        409,
        "agent_slack_name_taken",
        "Another agent in that Slack workspace already has this name. Choose another name.",
        { connectionId: outcome.connectionId || null },
      );
    }
    await ensureAgentInLinkedSlack(deps, home, outcome.agent);
    const updated = (await getAgent(db, home, outcome.agent.id)) ?? outcome.agent;
    const agent = await ensureAgentMemory(deps, context, updated);
    return c.json(await agentBody(context, agent));
  });

  app.delete(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const agent = await requireVisibleAgent(c, context);
    requireManageable(context, agent);
    const deleted = await deleteAgent(db, context.home, agent.id, (locked) =>
      agentManageableBy(context.viewer, locked),
    ).catch((error: unknown) => {
      if (error instanceof AgentEditRefusedError) throw forbidden(MANAGE_REFUSED);
      throw error;
    });
    return c.json(DeleteAgentResponse.parse({ deleted }));
  });

  app.get(`${base}/:agentId/revisions`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    const agent = await requireVisibleAgent(c, context);
    const before = Number(c.req.query("cursor"));
    const limit = limitParam(c.req.query("limit"), 20);
    const revisions = await listAgentRevisions(db, context.home, {
      agentId: agent.id,
      beforeRevision: Number.isSafeInteger(before) && before > 0 ? before : null,
      limit: limit + 1,
    });
    const page = revisions.slice(0, limit);
    return c.json(
      ListAgentRevisionsResponse.parse({
        revisions: page.map(agentRevisionView),
        nextCursor:
          revisions.length > limit && page.length > 0
            ? String(page[page.length - 1]!.revision)
            : null,
      }),
    );
  });

  app.get(`${base}/:agentId/chats`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    const agent = await requireVisibleAgent(c, context);
    const filter = AgentChatsFilter.safeParse(c.req.query("filter") ?? "yours");
    const limit = limitParam(c.req.query("limit"), 30);
    const chats = await listAgentChats(db, context.home, {
      agentId: agent.id,
      viewerSubjectId: context.viewer.subjectId,
      filter: filter.success ? filter.data : "yours",
      direct: c.req.query("direct") === "true",
      before: decodeChatCursor(c.req.query("cursor")),
      limit: limit + 1,
    });
    const page = chats.slice(0, limit);
    return c.json(
      ListAgentChatsResponse.parse({
        chats: page.map(agentChatView),
        nextCursor:
          chats.length > limit && page.length > 0 ? encodeChatCursor(page[page.length - 1]!) : null,
      }),
    );
  });

  // --- Slack -------------------------------------------------------------

  app.get(`${base}/:agentId/slack`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    const agent = await requireVisibleAgent(c, context);
    // Available in every linked Slack workspace: catch up here too, for an
    // agent made before that or by a path that couldn't.
    const installs = await ensureAgentInLinkedSlack(deps, context.home, agent);
    const teamNames = await slackTeamNames(context.home.accountId, installs);
    const personalWorkspace = await agentHomeIsPersonalWorkspace(deps, context.home);
    const rows = [];
    for (const installation of await linkedSlackInstallations(deps, context.home)) {
      const install = installs.find(
        (candidate) => candidate.connectionId === installation.connectionId,
      );
      rows.push({
        connectionId: installation.connectionId,
        slackTeamId: installation.slackTeamId,
        slackTeamName: installation.slackTeamName,
        botDisplayName: installation.botDisplayName,
        postsAsAgent: installation.postsAsAgent,
        installWorkspaceId: installation.installHome.workspaceId,
        availability: install
          ? agentSlackAvailabilityView(
              agent,
              install,
              new Map([...teamNames, [installation.connectionId, installation.slackTeamName]]),
            )
          : null,
        unavailable: await agentSlackUnavailableReason(deps, {
          agent,
          installation,
          installs,
          personalWorkspace,
        }),
      });
    }
    // Availability in an installation no longer linked here still shows.
    for (const install of installs) {
      if (rows.some((row) => row.connectionId === install.connectionId)) continue;
      rows.push({
        connectionId: install.connectionId,
        slackTeamId: install.slackTeamId,
        slackTeamName: teamNames.get(install.connectionId) ?? null,
        availability: agentSlackAvailabilityView(agent, install, teamNames),
        unavailable: null,
      });
    }
    return c.json(
      ListAgentSlackInstallsResponse.parse({
        installs: rows,
        routingEnabled: deps.settings.slackWorkspaceRoutingEnabled,
      }),
    );
  });

  function connectionIdParam(c: Context): string {
    const parsed = z.string().uuid().safeParse(c.req.param("connectionId"));
    if (!parsed.success) {
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "Slack workspace not found",
        retryable: false,
      });
    }
    return parsed.data;
  }

  // Make a shared agent available in one linked Slack workspace now (it is
  // anyway, on its own), or change open use, which is the agent's own.
  app.put(`${base}/:agentId/slack/:connectionId`, async (c) => {
    const context = await requestContext(c, "workspace:admin");
    const agent = await requireVisibleAgent(c, context);
    const connectionId = connectionIdParam(c);
    const request = await parseRequestJson(c, PutAgentSlackAvailabilityRequest);
    const { home } = context;
    if (agent.visibility !== "workspace") {
      throw agentError(
        409,
        "agent_slack_requires_workspace_visibility",
        "Share this agent with the workspace to make it available in Slack.",
      );
    }
    const workspace = await getWorkspace(db, home.workspaceId);
    if (!workspace || workspace.accountId !== home.accountId) throw notFound();
    if (workspace.kind === "personal") {
      throw agentError(
        422,
        "agent_slack_personal_workspace",
        "Agents in a personal workspace stay in the app.",
      );
    }
    const installation = await slackAgentInstallationFor(deps, home, connectionId);
    if (!installation) {
      throw agentError(
        409,
        "slack_bot_unavailable",
        "The Opengeni Slack app is not available in this workspace.",
      );
    }
    const existing = (await listAgentSlackInstalls(db, home, [agent.id])).find(
      (install) => install.connectionId === connectionId,
    );
    if (!existing) {
      const problem = slackAgentNameProblem(agent.name);
      if (problem) {
        throw agentError(
          422,
          "agent_slack_name_invalid",
          slackAgentNameProblemText(agent.name, problem),
          {
            problem,
          },
        );
      }
    }
    // Open use is the agent's own "Anyone in <organization>" now; this
    // older field changes that, in every Slack workspace.
    if (request.open === true && !agent.organizationAccess) {
      requireOrganizationAccessAdmin(context);
    }
    const outcome = await putAgentSlackInstall(db, home, {
      agentId: agent.id,
      connectionId,
      slackTeamId: installation.binding.slackTeamId,
      installWorkspaceId: installation.home.workspaceId,
      ...(request.expectedVersion !== undefined
        ? { expectedVersion: request.expectedVersion }
        : {}),
      actorSubjectId: context.grant.subjectId,
    });
    if (outcome.kind === "not_found") throw notFound();
    if (outcome.kind === "requires_workspace_visibility") {
      throw agentError(
        409,
        "agent_slack_requires_workspace_visibility",
        "Share this agent with the workspace to make it available in Slack.",
      );
    }
    if (outcome.kind === "name_taken") {
      throw agentError(
        409,
        "agent_slack_name_taken",
        "Another agent in that Slack workspace already has this name. Rename this one first.",
      );
    }
    if (outcome.kind === "version_conflict") {
      throw agentError(409, "agent_version_conflict", "This changed. Refresh and try again.", {
        currentVersion: outcome.install.version,
      });
    }
    let saved = { agent: outcome.agent, install: outcome.install };
    if (request.open !== undefined && request.open !== outcome.agent.organizationAccess) {
      const opened = await updateAgent(db, home, {
        agentId: agent.id,
        expectedVersion: null,
        actorSubjectId: context.viewer.subjectId,
        patch: { organizationAccess: request.open },
      });
      if (opened.kind !== "updated") throw notFound();
      const install = (await listAgentSlackInstalls(db, home, [agent.id])).find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!install) throw notFound();
      saved = { agent: opened.agent, install };
    }
    const view = await viewContext(context, [saved.agent]);
    return c.json(
      AgentSlackAvailabilityResponse.parse({
        agent: agentView(saved.agent, view),
        availability: agentSlackAvailabilityView(saved.agent, saved.install, view.slackTeamNames),
      }),
      outcome.created ? 201 : 200,
    );
  });

  // A shared agent is available in every linked Slack workspace, so there is
  // nothing to turn off; making it Only me takes it out of Slack.
  app.delete(`${base}/:agentId/slack/:connectionId`, async (c) => {
    const context = await requestContext(c, "workspace:admin");
    await requireVisibleAgent(c, context);
    connectionIdParam(c);
    throw agentError(
      409,
      "agent_slack_always_available",
      "Agents are available in every Slack workspace linked to their workspace. To keep one out of Slack, make it Only me.",
    );
  });

  /** The agent as the Slack installation in the path sees it; it must be available there. */
  async function requireSlackAgent(c: Context, context: RequestContext) {
    const agent = await requireVisibleAgent(c, context);
    const connectionId = connectionIdParam(c);
    const projection = await getSlackAgent(db, {
      accountId: context.home.accountId,
      agentId: agent.id,
      connectionId,
    });
    if (
      !projection ||
      projection.connectionId !== connectionId ||
      projection.targetWorkspaceId !== context.home.workspaceId
    ) {
      throw new ApiHttpError(404, {
        code: "not_found",
        message: "This agent is not available in that Slack workspace.",
        retryable: false,
      });
    }
    return projection;
  }

  app.get(`${base}/:agentId/slack/:connectionId/channels`, async (c) => {
    const context = await requestContext(c, "workspace:admin");
    c.header("cache-control", "private, no-store");
    const projection = await requireSlackAgent(c, context);
    const cursor = z.string().max(1_024).safeParse(c.req.query("cursor"));
    return c.json(
      await slackAgentChannelList(
        deps,
        context.grant,
        projection,
        cursor.success ? cursor.data || null : null,
      ),
    );
  });

  app.post(`${base}/:agentId/slack/:connectionId/intro`, async (c) => {
    const context = await requestContext(c, "workspace:admin");
    const projection = await requireSlackAgent(c, context);
    const payload = await parseRequestJson(c, AgentSlackIntroRequest);
    return c.json(await postSlackAgentIntro(deps, context.grant, projection, payload));
  });
}
