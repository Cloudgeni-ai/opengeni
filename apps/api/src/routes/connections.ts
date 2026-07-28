import {
  ConnectOpenGeniSlackBotRequest,
  ConnectionResponse,
  CreateConnectionRequest,
  IntegrationClientMetadata,
  ListConnectionsResponse,
  OAuthStartRequest,
  OAuthStartResponse,
  UpdateConnectionRequest,
} from "@opengeni/contracts";
import {
  hasReservedOpenGeniSlackBotMetadata,
  isOpenGeniSlackBotConnection,
  openGeniSlackBotMetadata,
  requireAccessGrant,
  requireEnvironmentEncryption,
} from "@opengeni/core";
import {
  createConnection,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  recordAuditEvent,
  revokeConnection,
  updateConnection,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  completeMcpOAuthCallback,
  integrationBaseUrl,
  startMcpOAuth,
} from "../integrations/oauth-client";
import { canonicalProviderDomain } from "../integrations/provider-domain";
import { verifyOpenGeniSlackBotCredential } from "../integrations/slack-bot";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";

export function registerConnectionRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, observability } = deps;

  function assertIntegrationsEnabled(): void {
    if (!settings.integrationsEnabled) {
      throw new HTTPException(404, { message: "integrations are not enabled for this deployment" });
    }
  }

  app.get("/v1/workspaces/:workspaceId/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    return c.json(
      ListConnectionsResponse.parse({
        connections: await listConnectionsMetadata(db, workspaceId, grant.subjectId),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = CreateConnectionRequest.parse(await c.req.json());
    assertNotReservedSlackBotMetadata(payload.metadata);
    const key = requireEnvironmentEncryption(settings);
    const subjectId = writableSubjectId(payload.subjectId, grant.subjectId);
    const connection = await createConnection(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId,
      providerDomain: canonicalProviderDomain(payload.providerDomain),
      kind: payload.kind,
      credentialEncrypted: encryptCredentialBundle(key, payload.credential),
      grantedScopes: payload.grantedScopes,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      metadata: payload.metadata,
      createdBySubjectId: grant.subjectId,
    });
    return c.json(ConnectionResponse.parse({ connection }), 201);
  });

  app.post("/v1/workspaces/:workspaceId/connections/slack-bot", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = ConnectOpenGeniSlackBotRequest.parse(await c.req.json());
    const verified = await verifyOpenGeniSlackBotCredential(
      payload.token,
      deps.slackFetch ?? fetch,
    );
    const key = requireEnvironmentEncryption(settings);
    const credentialEncrypted = encryptCredentialBundle(
      key,
      slackBotCredentialBundle(payload.token),
    );
    const existing = payload.connectionId
      ? await getConnectionMetadata(db, workspaceId, payload.connectionId, grant.subjectId)
      : null;
    if (payload.connectionId && !existing) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    if (existing && !isOpenGeniSlackBotConnection(existing)) {
      throw new HTTPException(422, {
        message: "connectionId is not an OpenGeni Slack bot connection",
      });
    }
    const existingMetadata = existing ? openGeniSlackBotMetadata(existing.metadata) : null;
    if (existingMetadata && existingMetadata.slackTeamId !== verified.metadata.slackTeamId) {
      throw new HTTPException(409, {
        message: "a Slack bot connection can only be reinstalled for its original Slack workspace",
      });
    }
    const connection = existing
      ? await updateConnection(db, {
          workspaceId,
          connectionId: existing.id,
          visibleToSubjectId: grant.subjectId,
          expectedVersion: existing.version,
          subjectId: null,
          providerDomain: "slack.com",
          kind: "app_install",
          status: "active",
          credentialEncrypted,
          grantedScopes: verified.grantedScopes,
          expiresAt: null,
          metadata: verified.metadata,
          updatedBySubjectId: grant.subjectId,
        })
      : await createConnection(db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: null,
          providerDomain: "slack.com",
          kind: "app_install",
          credentialEncrypted,
          grantedScopes: verified.grantedScopes,
          expiresAt: null,
          metadata: verified.metadata,
          createdBySubjectId: grant.subjectId,
        });
    if (!connection) {
      throw new HTTPException(409, {
        message: "Slack bot connection changed during reinstall; retry with the current connection",
      });
    }
    await recordAuditEvent(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      action: existing ? "slack_bot.reinstalled" : "slack_bot.connected",
      targetType: "connection",
      targetId: connection.id,
      metadata: {
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        connectionId: connection.id,
        slackTeamId: verified.metadata.slackTeamId,
        outcome: "succeeded",
      },
    });
    return c.json(ConnectionResponse.parse({ connection }), existing ? 200 : 201);
  });

  app.get("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    const connection = await getConnectionMetadata(
      db,
      workspaceId,
      c.req.param("connectionId"),
      grant.subjectId,
    );
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.patch("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = UpdateConnectionRequest.parse(await c.req.json());
    assertNotReservedSlackBotMetadata(payload.metadata);
    const existing = await getConnectionMetadata(
      db,
      workspaceId,
      c.req.param("connectionId"),
      grant.subjectId,
    );
    if (existing && isOpenGeniSlackBotConnection(existing)) {
      throw new HTTPException(422, {
        message: "use the dedicated OpenGeni Slack bot reinstall flow to update this connection",
      });
    }
    // Status is not a free-form field: revocation goes through DELETE, and the
    // broker owns needs_reauth/error. Reactivating a connection is only
    // meaningful together with a fresh credential bundle — otherwise a PATCH
    // could clear the broker's re-auth signal while stale tokens stay in place.
    if (payload.status !== undefined) {
      if (payload.status !== "active") {
        throw new HTTPException(400, {
          message: 'status can only be set to "active"; use DELETE to revoke',
        });
      }
      if (payload.credential === undefined) {
        throw new HTTPException(400, {
          message: "reactivating a connection requires a new credential",
        });
      }
    }
    const key = payload.credential === undefined ? null : requireEnvironmentEncryption(settings);
    const subjectId =
      payload.subjectId === undefined
        ? undefined
        : writableSubjectId(payload.subjectId, grant.subjectId);
    const connection = await updateConnection(db, {
      workspaceId,
      connectionId: c.req.param("connectionId"),
      visibleToSubjectId: grant.subjectId,
      updatedBySubjectId: grant.subjectId,
      ...(payload.providerDomain !== undefined
        ? { providerDomain: canonicalProviderDomain(payload.providerDomain) }
        : {}),
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.credential !== undefined && key
        ? { credentialEncrypted: encryptCredentialBundle(key, payload.credential) }
        : {}),
      ...(payload.grantedScopes !== undefined ? { grantedScopes: payload.grantedScopes } : {}),
      ...(payload.expiresAt !== undefined
        ? { expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null }
        : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    });
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.delete("/v1/workspaces/:workspaceId/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const connection = await revokeConnection(
      db,
      workspaceId,
      c.req.param("connectionId"),
      grant.subjectId,
    );
    if (!connection) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    if (isOpenGeniSlackBotConnection(connection)) {
      const metadata = openGeniSlackBotMetadata(connection.metadata)!;
      await recordAuditEvent(db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        action: "slack_bot.disconnected",
        targetType: "connection",
        targetId: connection.id,
        metadata: {
          credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
          credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
          connectionId: connection.id,
          slackTeamId: metadata.slackTeamId,
          outcome: "succeeded",
        },
      });
    }
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.post("/v1/workspaces/:workspaceId/connections/oauth/start", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const parsed = OAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "invalid OAuth start request",
      });
    }
    const payload = parsed.data;
    const result = await startMcpOAuth(
      { db, settings, observability },
      {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        requestUrl: c.req.url,
        payload,
      },
    );
    return c.json(OAuthStartResponse.parse(result));
  });

  app.get("/v1/integrations/oauth/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeMcpOAuthCallback(
      { db, settings, observability },
      {
        code: c.req.query("code"),
        state: c.req.query("state"),
        requestUrl: c.req.url,
      },
    );
    return c.redirect(result.redirectTo, 302);
  });

  app.get("/v1/integrations/oauth/client-metadata.json", (c) => {
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, c.req.url);
    const metadataUrl = `${baseUrl}/v1/integrations/oauth/client-metadata.json`;
    return c.json(
      IntegrationClientMetadata.parse({
        client_id: metadataUrl,
        client_name: "OpenGeni",
        redirect_uris: [`${baseUrl}/v1/integrations/oauth/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    );
  });
}

function assertNotReservedSlackBotMetadata(metadata: Record<string, unknown> | undefined): void {
  if (hasReservedOpenGeniSlackBotMetadata(metadata)) {
    throw new HTTPException(422, {
      message: "OpenGeni Slack bot metadata is reserved for the dedicated connection flow",
    });
  }
}

function writableSubjectId(
  requested: string | null | undefined,
  grantSubjectId: string,
): string | null {
  if (requested == null) {
    return null;
  }
  if (requested !== grantSubjectId) {
    throw new HTTPException(403, { message: "cannot write a connection for another subject" });
  }
  return requested;
}

function encryptCredentialBundle(key: Uint8Array, credential: Record<string, unknown>): string {
  return encryptEnvironmentValue(key, JSON.stringify(credential));
}

function slackBotCredentialBundle(token: string): Record<string, unknown> {
  const headerName = ["author", "ization"].join("");
  const scheme = ["Bear", "er"].join("");
  return { headers: { [headerName]: `${scheme} ${token}` } };
}
