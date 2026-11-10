/**
 * Agents (docs/agents.md): `/v1/workspaces/:workspaceId/agents`.
 *
 * The path workspace is the agent's home, where its chats run. Reading needs
 * what reading chats needs, and an Only me agent is visible only to its
 * owner. Making and changing agents needs what starting a chat needs; a
 * change also needs the agent's creator or a workspace admin. Making one
 * available in Slack needs a workspace admin; open use in Slack needs the
 * request's organization admin proof. The Slack name rules apply when Slack
 * is turned on, and to a rename while it is on.
 */

import {
  AgentChatsFilter,
  AgentListFilter,
  AgentResponse,
  AgentSlackAvailabilityResponse,
  AgentSlackIntroRequest,
  CreateAgentRequest,
  DeleteAgentResponse,
  ListAgentChatsResponse,
  ListAgentRevisionsResponse,
  ListAgentSlackInstallsResponse,
  ListAgentsResponse,
  PutAgentSlackAvailabilityRequest,
  SessionAvatar,
  UpdateAgentRequest,
  AGENTS_PER_WORKSPACE_MAX,
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  type AccessGrant,
  type AgentErrorCode,
} from "@opengeni/contracts";
import {
  AgentLimitError,
  AgentPrivateOwnerError,
  availableSlackBotConnectionMetadata,
  createAgent,
  deleteAgent,
  deleteAgentSlackInstall,
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
  agentChatView,
  agentEditableBy,
  agentRevisionView,
  agentSlackAvailabilityView,
  agentSummaryView,
  agentView,
  agentViewerCanMakePrivate,
  agentViewerForGrant,
  agentVisibleTo,
  knowledgeContextForAccess,
  requireAccessGrantAuthorization,
  requireAccountAdminAuthorizationStamp,
  type AccessGrantAuthorization,
  type AgentViewContext,
  type AgentViewer,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { ensureAgentMemoryCollection } from "../integrations/agent-memory-collection";
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

  function requireEditable(context: RequestContext, agent: AgentRecord): void {
    if (!agentEditableBy(context.viewer, agent)) {
      throw new ApiHttpError(403, {
        code: "forbidden",
        message: "Only whoever made this agent, or a workspace admin, can change it.",
        retryable: false,
      });
    }
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

  function isOrganizationAdmin(context: RequestContext): boolean {
    try {
      requireAccountAdminAuthorizationStamp(context.access);
      return true;
    } catch {
      return false;
    }
  }

  /** Slack workspace names by installation, read from each installation's own workspace. */
  async function slackTeamNames(
    accountId: string,
    installs: readonly AgentSlackInstallRecord[],
  ): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    const homes = new Set(
      installs.flatMap((install) =>
        install.installWorkspaceId ? [install.installWorkspaceId] : [],
      ),
    );
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

  app.get(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:read");
    c.header("cache-control", "private, no-store");
    return c.json(await agentBody(context, await requireVisibleAgent(c, context)));
  });

  app.post(base, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const request = await parseRequestJson(c, CreateAgentRequest);
    const { grant, viewer, home } = context;
    if (request.visibility === "private" && viewer.subjectId === null) {
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
      sharedWithWorkspace: request.visibility === "workspace",
    });
    let created: AgentRecord;
    try {
      created = (
        await createAgent(db, home, {
          visibility: request.visibility,
          ownerSubjectId: request.visibility === "private" ? viewer.subjectId : null,
          name: request.name,
          description: request.description,
          avatar: request.avatar,
          instructions: request.instructions,
          firstMessage: request.firstMessage,
          memoryEnabled: request.memoryEnabled,
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
    const agent = await ensureAgentMemory(deps, context, created);
    return c.json(await agentBody(context, agent), 201);
  });

  app.patch(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const current = await requireVisibleAgent(c, context);
    requireEditable(context, current);
    const request = await parseRequestJson(c, UpdateAgentRequest);
    const { grant, viewer, home } = context;
    const visibility = request.visibility ?? current.visibility;
    const changesVisibility = visibility !== current.visibility;
    const installs = await listAgentSlackInstalls(db, home, [current.id]);
    if (changesVisibility && visibility === "private") {
      if (installs.length > 0) {
        throw agentError(
          409,
          "agent_slack_requires_workspace_visibility",
          "This agent is available in Slack, so it stays shared with the workspace. Turn Slack off first.",
        );
      }
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
    if (
      request.name !== undefined &&
      installs.length > 0 &&
      slackAgentNameKey(request.name) !== slackAgentNameKey(current.name)
    ) {
      const problem = slackAgentNameProblem(request.name);
      if (problem) {
        throw agentError(
          422,
          "agent_slack_name_invalid",
          slackAgentNameProblemText(request.name, problem),
          {
            problem,
          },
        );
      }
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
      patch: {
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.avatar !== undefined ? { avatar: request.avatar } : {}),
        ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        ...(request.firstMessage !== undefined ? { firstMessage: request.firstMessage } : {}),
        ...(request.memoryEnabled !== undefined ? { memoryEnabled: request.memoryEnabled } : {}),
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
      throw privateOwnerError(error);
    });
    if (outcome.kind === "not_found") throw notFound();
    if (outcome.kind === "requires_workspace_visibility") {
      throw agentError(
        409,
        "agent_slack_requires_workspace_visibility",
        "This agent is available in Slack, so it stays shared with the workspace. Turn Slack off first.",
      );
    }
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
        "Another agent in that Slack workspace already has this name.",
        { connectionId: outcome.connectionId || null },
      );
    }
    const agent = await ensureAgentMemory(deps, context, outcome.agent);
    return c.json(await agentBody(context, agent));
  });

  app.delete(`${base}/:agentId`, async (c) => {
    const context = await requestContext(c, "sessions:create");
    const agent = await requireVisibleAgent(c, context);
    requireEditable(context, agent);
    const deleted = await deleteAgent(db, context.home, agent.id);
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
    const installs = await listAgentSlackInstalls(db, context.home, [agent.id]);
    const teamNames = await slackTeamNames(context.home.accountId, installs);
    const available = (await availableSlackBotConnectionMetadata(db, context.home)).filter(
      (connection) => connection.status === "active",
    );
    const rows = [];
    for (const connection of available) {
      const binding = (
        await listSlackInstallationBindings(db, {
          accountId: context.home.accountId,
          workspaceId: connection.workspaceId,
        }).catch(() => [])
      ).find(
        (candidate) => candidate.connectionId === connection.id && candidate.state === "active",
      );
      if (!binding) continue;
      const install = installs.find((candidate) => candidate.connectionId === connection.id);
      rows.push({
        connectionId: connection.id,
        slackTeamId: binding.slackTeamId,
        slackTeamName: binding.slackTeamName ?? null,
        availability: install
          ? agentSlackAvailabilityView(
              agent,
              install,
              new Map([...teamNames, [connection.id, binding.slackTeamName ?? null]]),
            )
          : null,
      });
    }
    // Availability in an installation no longer offered here still shows.
    for (const install of installs) {
      if (rows.some((row) => row.connectionId === install.connectionId)) continue;
      rows.push({
        connectionId: install.connectionId,
        slackTeamId: install.slackTeamId,
        slackTeamName: teamNames.get(install.connectionId) ?? null,
        availability: agentSlackAvailabilityView(agent, install, teamNames),
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
    if (request.open === true && !existing?.open) {
      requireAccountAdminAuthorizationStamp(context.access);
    }
    const outcome = await putAgentSlackInstall(db, home, {
      agentId: agent.id,
      connectionId,
      slackTeamId: installation.binding.slackTeamId,
      installWorkspaceId: installation.home.workspaceId,
      ...(request.open !== undefined ? { open: request.open } : {}),
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
    if (outcome.kind === "single_install") {
      throw agentError(
        409,
        "agent_slack_single_install",
        "For now an agent is available in one Slack workspace. Turn it off in the other one first.",
        { connectionId: outcome.connectionId || null },
      );
    }
    if (outcome.kind === "version_conflict") {
      throw agentError(409, "agent_version_conflict", "This changed. Refresh and try again.", {
        currentVersion: outcome.install.version,
      });
    }
    const view = await viewContext(context, [outcome.agent]);
    return c.json(
      AgentSlackAvailabilityResponse.parse({
        agent: agentView(outcome.agent, view),
        availability: agentSlackAvailabilityView(
          outcome.agent,
          outcome.install,
          view.slackTeamNames,
        ),
      }),
      outcome.created ? 201 : 200,
    );
  });

  app.delete(`${base}/:agentId/slack/:connectionId`, async (c) => {
    const context = await requestContext(c, "workspace:admin");
    const agent = await requireVisibleAgent(c, context);
    const connectionId = connectionIdParam(c);
    await deleteAgentSlackInstall(db, context.home, { agentId: agent.id, connectionId });
    const updated = (await getAgent(db, context.home, agent.id)) ?? agent;
    const view = await viewContext(context, [updated]);
    return c.json(
      AgentSlackAvailabilityResponse.parse({ agent: agentView(updated, view), availability: null }),
    );
  });

  /** The agent as the Slack installation in the path sees it; it must be available there. */
  async function requireSlackAgent(c: Context, context: RequestContext) {
    const agent = await requireVisibleAgent(c, context);
    const connectionId = connectionIdParam(c);
    const projection = await getSlackAgent(db, {
      accountId: context.home.accountId,
      agentId: agent.id,
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
