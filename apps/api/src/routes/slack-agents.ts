/**
 * Slack agents: the admin API behind Slack settings.
 *
 * Anyone in the organization can list agents. Creating one needs
 * `workspace:admin` in the workspace it will work in, which is the path
 * workspace; editing and deleting follow the current admins of that workspace,
 * not the creator. Rows are written under the Slack installation's own HOME
 * tenancy, like channel routes.
 */
import { createHash } from "node:crypto";

import {
  CreateSlackAgentRequest,
  slackAgentHandle,
  slackAgentNameKey,
  SlackAgentChannelListResponse,
  SlackAgentIntroRequest,
  SlackAgentIntroResponse,
  SlackAgentListResponse,
  SlackAgentResponse,
  UpdateSlackAgentRequest,
  type SlackAgent,
} from "@opengeni/contracts";
import {
  deleteSlackAgent,
  getAgentLearningSettings,
  getSlackAgent,
  getWorkspace,
  getWorkspaceGrant,
  listOrganizationSlackAgents,
  listSlackInstallationBindings,
  updateSlackAgent,
  type SlackAgentRecord,
} from "@opengeni/db";
import {
  hasPermission,
  knowledgeContextForAccess,
  requireAccountAdminAuthorizationStamp,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import type { AccessGrant } from "@opengeni/contracts";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import {
  createOpenGeniSlackBotInteractionClient,
  SlackBotProviderError,
} from "../integrations/slack-bot";
import { escapeSlackMrkdwn } from "../integrations/slack-app-home";
import { createSlackAgent } from "../integrations/slack-agent-create";

const SLACK_AGENT_ADMIN_SUBJECT_ID = "service:slack-interaction";

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nameTaken(): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message: "Another Slack agent already has this name.",
    retryable: false,
    details: { code: "slack_agent_name_taken" },
  });
}

function agentView(
  agent: SlackAgentRecord,
  extra: {
    slackTeamName: string | null;
    targetWorkspaceName: string | null;
    viewerCanManage: boolean;
    /** The reader can read the agent's workspace, so sees its instructions and Memory. */
    viewerCanRead: boolean;
    memoryReviewFirst: boolean;
  },
): SlackAgent {
  return {
    id: agent.id,
    connectionId: agent.connectionId,
    slackTeamId: agent.slackTeamId,
    slackTeamName: extra.slackTeamName,
    targetWorkspaceId: agent.targetWorkspaceId,
    targetWorkspaceName: extra.targetWorkspaceName,
    name: agent.name,
    handle: slackAgentHandle(agent.name),
    description: agent.description,
    avatar: agent.avatar,
    instructions: extra.viewerCanRead ? agent.instructions : null,
    knowledgeCollectionId: extra.viewerCanRead ? agent.knowledgeCollectionId : null,
    open: agent.open,
    version: agent.version,
    createdBySubjectId: extra.viewerCanRead ? agent.createdBySubjectId : null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    viewerCanManage: extra.viewerCanManage,
    memoryReviewFirst: extra.memoryReviewFirst,
  };
}

/** What the reader may do in a workspace right now. */
async function readerAccess(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
): Promise<{ read: boolean; admin: boolean }> {
  const permissions =
    grant.workspaceId === workspaceId
      ? grant.permissions
      : await getWorkspaceGrant(deps.db, grant.subjectId, workspaceId, {
          principalKind: "human_session",
        })
          .then((other) => (other && other.accountId === grant.accountId ? other.permissions : []))
          .catch(() => []);
  return {
    read: hasPermission(permissions, "workspace:read"),
    admin: hasPermission(permissions, "workspace:admin"),
  };
}

export function registerSlackAgentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/integrations/slack/agents";

  /** Whether the path workspace saves new Knowledge for review first. */
  const memoryReviewFirst = async (
    c: Parameters<typeof requireAccessGrantAuthorization>[0],
    workspaceId: string,
  ): Promise<boolean> => {
    try {
      const access = await requireAccessGrantAuthorization(c, deps, workspaceId);
      return await withAccessGrantSessionRlsContext(deps, access.grant, async () => {
        const context = await knowledgeContextForAccess(deps, access, "workspace:read");
        const settings = await getAgentLearningSettings(deps.db, context, "workspace");
        return settings.settings.knowledge === "review_first";
      });
    } catch {
      return false;
    }
  };

  app.get(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    c.header("cache-control", "private, no-store");
    const agents = await listOrganizationSlackAgents(deps.db, { accountId: grant.accountId });
    const workspaceNames = new Map<string, string | null>();
    const teamNames = new Map<string, string | null>();
    const access = new Map<string, { read: boolean; admin: boolean }>();
    for (const agent of agents) {
      if (!workspaceNames.has(agent.targetWorkspaceId)) {
        workspaceNames.set(
          agent.targetWorkspaceId,
          (await getWorkspace(deps.db, agent.targetWorkspaceId))?.name ?? null,
        );
        access.set(
          agent.targetWorkspaceId,
          await readerAccess(deps, grant, agent.targetWorkspaceId),
        );
      }
      if (!teamNames.has(agent.connectionId)) {
        const binding = (
          await listSlackInstallationBindings(deps.db, {
            accountId: agent.accountId,
            workspaceId: agent.workspaceId,
          })
        ).find((candidate) => candidate.connectionId === agent.connectionId);
        teamNames.set(agent.connectionId, binding?.slackTeamName ?? null);
      }
    }
    const reviewFirst = await memoryReviewFirst(c, workspaceId);
    return c.json(
      SlackAgentListResponse.parse({
        routingEnabled: deps.settings.slackWorkspaceRoutingEnabled,
        memoryReviewFirst: reviewFirst,
        agents: agents.map((agent) =>
          agentView(agent, {
            slackTeamName: teamNames.get(agent.connectionId) ?? null,
            targetWorkspaceName: workspaceNames.get(agent.targetWorkspaceId) ?? null,
            viewerCanManage: access.get(agent.targetWorkspaceId)?.admin ?? false,
            viewerCanRead: access.get(agent.targetWorkspaceId)?.read ?? false,
            memoryReviewFirst: agent.targetWorkspaceId === workspaceId && reviewFirst,
          }),
        ),
      }),
    );
  });

  app.post(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:admin");
    const grant = access.grant;
    const payload = CreateSlackAgentRequest.parse(
      await parseRequestJson(c, CreateSlackAgentRequest),
    );
    const outcome = await createSlackAgent(deps, {
      grant,
      request: payload,
      memoryContext: () => knowledgeContextForAccess(deps, access, "documents:manage"),
    });
    if (outcome.kind === "workspace_not_found") {
      throw new HTTPException(404, { message: "Workspace not found" });
    }
    if (outcome.kind === "personal_workspace") {
      throw new HTTPException(422, {
        message: "A Slack agent works in a shared workspace, not a personal one.",
      });
    }
    if (outcome.kind === "slack_bot_unavailable") {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "The Opengeni Slack app is not available in this workspace.",
        retryable: false,
        details: { code: "slack_bot_unavailable" },
      });
    }
    if (outcome.kind === "name_taken") throw nameTaken();
    const { agent, installation } = outcome;
    const target = { name: outcome.targetWorkspaceName };
    return c.json(
      SlackAgentResponse.parse({
        agent: agentView(agent, {
          slackTeamName: installation.binding.slackTeamName,
          targetWorkspaceName: target.name,
          viewerCanManage: true,
          viewerCanRead: true,
          memoryReviewFirst: await memoryReviewFirst(c, workspaceId),
        }),
      }),
      201,
    );
  });

  /** The agent in the path, which must work in the path workspace. */
  const requireManagedAgent = async (
    c: Parameters<typeof requireAccessGrant>[0],
  ): Promise<{ grant: AccessGrant; agent: SlackAgentRecord }> => {
    const workspaceId = c.req.param("workspaceId")!;
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const agentId = z.string().uuid().safeParse(c.req.param("agentId"));
    const agent = agentId.success
      ? await getSlackAgent(deps.db, { accountId: grant.accountId, agentId: agentId.data })
      : null;
    if (!agent || agent.targetWorkspaceId !== workspaceId) {
      throw new HTTPException(404, { message: "Slack agent not found" });
    }
    return { grant, agent };
  };

  /**
   * Opening an agent to anyone in Slack lets people outside its workspace use
   * what the workspace shares, so it takes the request's verified
   * organization admin proof (`account:admin` for the agent's organization).
   * Turning it off only needs the workspace admin every edit already needs.
   */
  const requireOrganizationAdmin = async (
    c: Parameters<typeof requireAccessGrantAuthorization>[0],
    workspaceId: string,
  ) => {
    requireAccountAdminAuthorizationStamp(
      await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:admin"),
    );
  };

  app.patch(`${base}/:agentId`, async (c) => {
    const { agent } = await requireManagedAgent(c);
    const payload = UpdateSlackAgentRequest.parse(
      await parseRequestJson(c, UpdateSlackAgentRequest),
    );
    if (payload.open === true && !agent.open) {
      await requireOrganizationAdmin(c, agent.targetWorkspaceId);
    }
    const updated = await updateSlackAgent(
      deps.db,
      { accountId: agent.accountId, workspaceId: agent.workspaceId },
      {
        agentId: agent.id,
        expectedVersion: payload.expectedVersion,
        patch: {
          ...(payload.name !== undefined
            ? { name: payload.name, nameKey: slackAgentNameKey(payload.name) }
            : {}),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.avatar !== undefined ? { avatar: payload.avatar } : {}),
          ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
          ...(payload.open !== undefined ? { open: payload.open } : {}),
        },
      },
    );
    if (updated === "name_taken") throw nameTaken();
    if (updated === "version_conflict") {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "This Slack agent changed. Refresh and try again.",
        retryable: false,
        details: { code: "slack_agent_version_conflict" },
      });
    }
    if (!updated) throw new HTTPException(404, { message: "Slack agent not found" });
    const binding = (
      await listSlackInstallationBindings(deps.db, {
        accountId: updated.accountId,
        workspaceId: updated.workspaceId,
      })
    ).find((candidate) => candidate.connectionId === updated.connectionId);
    return c.json(
      SlackAgentResponse.parse({
        agent: agentView(updated, {
          slackTeamName: binding?.slackTeamName ?? null,
          targetWorkspaceName:
            (await getWorkspace(deps.db, updated.targetWorkspaceId))?.name ?? null,
          viewerCanManage: true,
          viewerCanRead: true,
          memoryReviewFirst: await memoryReviewFirst(c, updated.targetWorkspaceId),
        }),
      }),
    );
  });

  app.delete(`${base}/:agentId`, async (c) => {
    const { agent } = await requireManagedAgent(c);
    const deleted = await deleteSlackAgent(
      deps.db,
      { accountId: agent.accountId, workspaceId: agent.workspaceId },
      { agentId: agent.id },
    );
    return c.json({ deleted });
  });

  /**
   * Channels an intro may go to: ones the app is in, not shared outside the
   * Slack workspace. Private channels only for admins of the installation's
   * own workspace, since an agent's admin may not be in them.
   */
  const introChannels = async (
    grant: AccessGrant,
    agent: SlackAgentRecord,
    cursor: string | null,
  ) => {
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: agent.accountId,
      workspaceId: agent.workspaceId,
      connectionId: agent.connectionId,
      subjectId: SLACK_AGENT_ADMIN_SUBJECT_ID,
    });
    const includePrivate = (await readerAccess(deps, grant, agent.workspaceId)).admin;
    const result = await client.listChannels({ limit: 200, ...(cursor ? { cursor } : {}) });
    return {
      client,
      channels: result.channels.filter(
        (channel) =>
          channel.isMember &&
          !channel.isArchived &&
          !channel.isShared &&
          !channel.isExternallyShared &&
          !channel.isOrgShared &&
          (includePrivate || !channel.isPrivate),
      ),
      nextCursor: result.nextCursor || null,
    };
  };

  app.get(`${base}/:agentId/channels`, async (c) => {
    const { grant, agent } = await requireManagedAgent(c);
    c.header("cache-control", "private, no-store");
    const cursor = z.string().max(1_024).safeParse(c.req.query("cursor"));
    const result = await introChannels(grant, agent, cursor.success ? cursor.data || null : null);
    return c.json(
      SlackAgentChannelListResponse.parse({
        channels: result.channels.slice(0, 200).map((channel) => ({
          id: channel.id,
          name: channel.name || null,
          isPrivate: channel.isPrivate,
        })),
        nextCursor: result.nextCursor,
      }),
    );
  });

  app.post(`${base}/:agentId/intro`, async (c) => {
    const { grant, agent } = await requireManagedAgent(c);
    const payload = await parseRequestJson(c, SlackAgentIntroRequest);
    const home = { accountId: agent.accountId, workspaceId: agent.workspaceId };
    const binding = (await listSlackInstallationBindings(deps.db, home)).find(
      (candidate) => candidate.connectionId === agent.connectionId,
    );
    // Only channels the admin could have picked from the list above.
    const requested = new Set(payload.channelIds);
    const allowed = new Set<string>();
    let cursor: string | null = null;
    let client: Awaited<ReturnType<typeof introChannels>>["client"] | null = null;
    for (let page = 0; page < 10 && [...requested].some((id) => !allowed.has(id)); page += 1) {
      const result = await introChannels(grant, agent, cursor);
      client = result.client;
      for (const channel of result.channels) allowed.add(channel.id);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    client ??= await createOpenGeniSlackBotInteractionClient(deps, {
      ...home,
      connectionId: agent.connectionId,
      subjectId: SLACK_AGENT_ADMIN_SUBJECT_ID,
    });
    const text = slackAgentIntroText(agent, binding?.botUserId ?? null);
    const identity = client.postIdentity(agent.targetWorkspaceId, {
      title: agent.name,
      avatar: agent.avatar,
    });
    const results: SlackAgentIntroResponse["results"] = [];
    for (const channelId of requested) {
      if (!allowed.has(channelId)) {
        results.push({ channelId, status: "not_in_channel" });
        continue;
      }
      try {
        await client.postMessage({
          // One intro per channel per version of the agent, so a retried
          // request never posts twice.
          operationId: deterministicUuid(
            `slack-agent-intro:${agent.id}:${agent.version}:${channelId}`,
          ),
          channelId,
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
          requireActiveNonSharedChannel: true,
          identity,
        });
        results.push({ channelId, status: "posted" });
      } catch (error) {
        results.push({
          channelId,
          status:
            error instanceof SlackBotProviderError &&
            (error.code === "not_in_channel" || error.code === "channel_not_found")
              ? "not_in_channel"
              : "failed",
        });
      }
    }
    return c.json(SlackAgentIntroResponse.parse({ results }));
  });
}

/** The intro an agent posts in a channel an admin picked, under its own name. */
export function slackAgentIntroText(
  agent: Pick<SlackAgentRecord, "name" | "description">,
  botUserId: string | null,
): string {
  const mention = botUserId ? `<@${botUserId}>` : "@Opengeni";
  return `Hi, I'm *${escapeSlackMrkdwn(agent.name)}*. ${escapeSlackMrkdwn(agent.description)}\nAsk me with ${mention} +${slackAgentHandle(agent.name)}`;
}
