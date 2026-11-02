/**
 * Update messages about Slack agents: the settings an organization admin
 * changes per Slack installation, and the admin's own "send me a preview".
 *
 * Anyone in the organization can read the settings. Changing them, and the
 * preview, need `account:admin`, checked from the live account grant like
 * organization sandbox environments. Rows are written under the installation's
 * HOME tenancy, like Slack agents.
 */
import {
  SlackAgentUpdatePreviewRequest,
  SlackAgentUpdatePreviewResponse,
  SlackAgentUpdateSettings,
  UpdateSlackAgentUpdateSettingsRequest,
} from "@opengeni/contracts";
import {
  MissingPermissionRefusal,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  availableSlackBotConnectionMetadata,
  findSlackBotUserLinkForSubject,
  getSlackAgentUpdateSettings,
  listSlackInstallationBindings,
  saveSlackAgentUpdateSettings,
  type SlackAgentUpdateSettingsRecord,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import {
  sendSlackAgentUpdatePreview,
  SlackAgentUpdatePreviewUnavailableError,
} from "../integrations/slack-agent-updates";
import { SlackBotProviderError } from "../integrations/slack-bot";

/** The Slack installation a connection is, as seen from a workspace it is available in. */
async function installationFor(
  deps: ApiRouteDeps,
  scope: { accountId: string; workspaceId: string },
  connectionId: string,
) {
  const available = await availableSlackBotConnectionMetadata(deps.db, scope);
  const connection = available.find(
    (candidate) => candidate.id === connectionId && candidate.status === "active",
  );
  if (!connection) return null;
  const home = { accountId: scope.accountId, workspaceId: connection.workspaceId };
  const binding = (await listSlackInstallationBindings(deps.db, home)).find(
    (candidate) => candidate.connectionId === connectionId && candidate.state === "active",
  );
  return binding ? { home, binding } : null;
}

function unavailable(): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message: "The Opengeni Slack app is not available in this workspace.",
    retryable: false,
    details: { code: "slack_bot_unavailable" },
  });
}

function settingsView(
  settings: SlackAgentUpdateSettingsRecord,
  viewerCanManage: boolean,
): SlackAgentUpdateSettings {
  return SlackAgentUpdateSettings.parse({
    connectionId: settings.connectionId,
    updatesEnabled: settings.updatesEnabled,
    channelPostsOnly: settings.channelPostsOnly,
    viewerCanManage,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  });
}

export function registerSlackAgentUpdateRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/integrations/slack/agent-updates";

  type Context = Parameters<typeof requireAccessGrantAuthorization>[0];

  const organizationAdmin = (
    authorization: Awaited<ReturnType<typeof requireAccessGrantAuthorization>>,
  ): boolean => authorization.accountGrant?.permissions.includes("account:admin") === true;

  const requireOrganizationAdmin = async (c: Context, workspaceId: string) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "workspace:read",
    );
    if (!organizationAdmin(authorization)) throw new MissingPermissionRefusal("account:admin");
    return authorization;
  };

  app.get(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "workspace:read",
    );
    const connectionId = c.req.query("connectionId") ?? "";
    if (!/^[0-9a-f-]{36}$/iu.test(connectionId)) {
      throw new HTTPException(400, { message: "connectionId is required" });
    }
    const installation = await installationFor(
      deps,
      { accountId: authorization.grant.accountId, workspaceId },
      connectionId,
    );
    if (!installation) throw unavailable();
    c.header("cache-control", "private, no-store");
    const settings = await getSlackAgentUpdateSettings(deps.db, installation.home, {
      connectionId,
    });
    return c.json(settingsView(settings, organizationAdmin(authorization)));
  });

  app.put(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireOrganizationAdmin(c, workspaceId);
    const payload = UpdateSlackAgentUpdateSettingsRequest.parse(
      await parseRequestJson(c, UpdateSlackAgentUpdateSettingsRequest),
    );
    const installation = await installationFor(
      deps,
      { accountId: authorization.grant.accountId, workspaceId },
      payload.connectionId,
    );
    if (!installation) throw unavailable();
    const saved = await saveSlackAgentUpdateSettings(deps.db, installation.home, {
      connectionId: payload.connectionId,
      updatesEnabled: payload.updatesEnabled,
      channelPostsOnly: payload.channelPostsOnly,
      subjectId: authorization.grant.subjectId,
    });
    return c.json(settingsView(saved, true));
  });

  /**
   * Send one update message to the caller's own linked Slack account now. It
   * ignores the schedule, the settings and mute, counts toward no one's limits
   * and never messages anyone else.
   */
  app.post(`${base}/preview`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireOrganizationAdmin(c, workspaceId);
    const payload = SlackAgentUpdatePreviewRequest.parse(
      await parseRequestJson(c, SlackAgentUpdatePreviewRequest),
    );
    const installation = await installationFor(
      deps,
      { accountId: authorization.grant.accountId, workspaceId },
      payload.connectionId,
    );
    if (!installation) throw unavailable();
    const link = await findSlackBotUserLinkForSubject(deps.db, installation.home, {
      connectionId: payload.connectionId,
      subjectId: authorization.grant.subjectId,
    });
    const kind = payload.kind ?? "update";
    try {
      if (!link) throw new SlackAgentUpdatePreviewUnavailableError("not_linked");
      const sent = await sendSlackAgentUpdatePreview(deps, {
        home: installation.home,
        connectionId: payload.connectionId,
        slackTeamId: installation.binding.slackTeamId,
        botUserId: installation.binding.botUserId,
        subjectId: authorization.grant.subjectId,
        slackUserId: link.slackUserId,
        kind,
      });
      return c.json(
        SlackAgentUpdatePreviewResponse.parse({
          kind,
          slackUserId: link.slackUserId,
          agentIds: sent.agentIds,
        }),
      );
    } catch (error) {
      if (error instanceof SlackAgentUpdatePreviewUnavailableError) {
        throw new ApiHttpError(409, {
          code: "conflict",
          message: error.message,
          retryable: false,
          details: { code: `slack_agent_update_preview_${error.reason}` },
        });
      }
      if (error instanceof SlackBotProviderError) {
        throw new ApiHttpError(502, {
          code: "upstream_unavailable",
          message: `Slack refused the message (${error.code}).`,
          retryable: error.code === "rate_limited",
          details: { code: "slack_provider_error", slackError: error.code },
        });
      }
      throw error;
    }
  });
}
