import {
  MemorySlackPublication,
  MemorySlackPublicationActionRequest,
  MemorySlackPublicationConfigurationResponse,
  MemorySlackPublicationHistoryResponse,
  SlackPublicationChannelListResponse,
  UpdateMemorySlackPublicationConfigurationRequest,
} from "@opengeni/contracts";
import {
  actOnMemorySlackPublication,
  createMemorySlackPublicationConfiguration,
  listMemorySlackPublicationConfigurations,
  listMemorySlackPublications,
  MemorySlackPublicationRevisionConflictError,
  recordAuditEvent,
} from "@opengeni/db";
import {
  openGeniSlackBotMetadata,
  requireAccessGrant,
  validateOpenGeniSlackBotConnectionSelection,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createOpenGeniSlackBotInteractionClient } from "../integrations/slack-bot";

export function registerMemorySlackPublicationRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/memory-slack-publications";

  app.get(`${base}/configuration`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const history = await listMemorySlackPublicationConfigurations(deps.db, workspaceId, 25);
    c.header("cache-control", "private, no-store");
    return c.json(
      MemorySlackPublicationConfigurationResponse.parse({
        current: history[0] ?? null,
        history,
      }),
    );
  });

  app.put(`${base}/configuration`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = UpdateMemorySlackPublicationConfigurationRequest.parse(await c.req.json());
    let slackTeamId: string | null = null;
    let channelName = payload.slackChannelName;
    if (payload.connectionId || payload.slackChannelId) {
      if (!payload.connectionId || !payload.slackChannelId) {
        throw new HTTPException(400, {
          message: "connectionId and slackChannelId must be configured together",
        });
      }
      const connection = await validateOpenGeniSlackBotConnectionSelection(
        deps.db,
        grant,
        workspaceId,
        payload.connectionId,
      );
      const metadata = openGeniSlackBotMetadata(connection.metadata);
      if (!metadata) {
        throw new HTTPException(422, { message: "Slack bot installation metadata is invalid" });
      }
      const client = await createOpenGeniSlackBotInteractionClient(deps, {
        accountId: grant.accountId,
        workspaceId,
        connectionId: connection.id,
        subjectId: grant.subjectId,
      });
      const channel = await client.verifyChannelAccess(payload.slackChannelId);
      if (
        channel.isShared ||
        channel.isExternallyShared ||
        channel.isOrgShared ||
        channel.isArchived
      ) {
        throw new HTTPException(422, {
          message: "Slack publication requires an active, non-shared bot-member channel",
        });
      }
      slackTeamId = metadata.slackTeamId;
      channelName = channel.name ?? payload.slackChannelName;
    }
    try {
      const configuration = await createMemorySlackPublicationConfiguration(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        expectedRevision: payload.expectedRevision,
        enabled: payload.enabled,
        connectionId: payload.connectionId,
        slackTeamId,
        slackChannelId: payload.slackChannelId,
        slackChannelName: channelName,
        autoImportances: payload.autoImportances,
        reviewImportances: payload.reviewImportances,
        subjectId: grant.subjectId,
      });
      await recordAuditEvent(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        action: "memory_slack_publication.configuration.created",
        targetType: "memory_slack_publication_configuration",
        targetId: configuration.id,
        metadata: {
          revision: configuration.revision,
          enabled: configuration.enabled,
          connectionId: configuration.connectionId,
          slackTeamId: configuration.slackTeamId,
          slackChannelId: configuration.slackChannelId,
          autoImportances: configuration.autoImportances,
          reviewImportances: configuration.reviewImportances,
        },
      });
      return c.json(configuration);
    } catch (error) {
      if (error instanceof MemorySlackPublicationRevisionConflictError) {
        throw new HTTPException(409, {
          message: `configuration revision conflict; current revision is ${error.currentRevision}`,
        });
      }
      throw error;
    }
  });

  app.get(`${base}/channels`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const connectionId = c.req.query("connectionId");
    if (!connectionId) throw new HTTPException(400, { message: "connectionId is required" });
    await validateOpenGeniSlackBotConnectionSelection(deps.db, grant, workspaceId, connectionId);
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: grant.accountId,
      workspaceId,
      connectionId,
      subjectId: grant.subjectId,
    });
    const result = await client.listChannels({
      limit: 200,
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
    });
    return c.json(
      SlackPublicationChannelListResponse.parse({
        channels: result.channels
          .filter(
            (channel) =>
              channel.isMember &&
              !channel.isArchived &&
              !channel.isShared &&
              !channel.isExternallyShared &&
              !channel.isOrgShared,
          )
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            isPrivate: channel.isPrivate,
          })),
        nextCursor: result.nextCursor || null,
      }),
    );
  });

  app.get(base, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const publications = await listMemorySlackPublications(deps.db, workspaceId, { limit: 50 });
    c.header("cache-control", "private, no-store");
    return c.json(MemorySlackPublicationHistoryResponse.parse({ publications, nextCursor: null }));
  });

  app.post(`${base}/:publicationId/action`, async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = MemorySlackPublicationActionRequest.parse(await c.req.json());
    const publication = await actOnMemorySlackPublication(deps.db, {
      workspaceId,
      publicationId: c.req.param("publicationId"),
      expectedState: payload.expectedState,
      action: payload.action,
      subjectId: grant.subjectId,
    });
    if (!publication) {
      throw new HTTPException(409, { message: "publication state changed or action is invalid" });
    }
    await recordAuditEvent(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: `memory_slack_publication.${payload.action}`,
      targetType: "memory_slack_publication",
      targetId: publication.id,
      metadata: {
        expectedState: payload.expectedState,
        resultState: publication.state,
        operationId: publication.receipts.at(-1)?.operationId ?? null,
      },
    });
    return c.json(MemorySlackPublication.parse(publication));
  });
}
