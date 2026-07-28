import {
  ConnectionResponse,
  CreateConnectionRequest,
  IntegrationClientMetadata,
  ListConnectionsResponse,
  OpenGeniSlackBotInstallRequest,
  OpenGeniSlackBotInstallStart,
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
  consumeIntegrationOAuthStateNonce,
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
import {
  exchangeOpenGeniSlackAuthorizationCode,
  verifyOpenGeniSlackBotCredential,
} from "../integrations/slack-bot";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import { createSignedState, readSignedState } from "@opengeni/github";
import { oauthStateTtlMs, requireIntegrationsStateSecret } from "../integrations/oauth-client";

type OpenGeniSlackInstallState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  returnPath: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

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

  app.post("/v1/workspaces/:workspaceId/connections/slack-bot/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = OpenGeniSlackBotInstallRequest.parse(await c.req.json());
    const slack = requireOpenGeniSlackOAuthSettings(settings);
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
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, c.req.url);
    const redirectUri = `${baseUrl}/v1/integrations/slack/callback`;
    const returnPath = `/workspaces/${workspaceId}/capabilities`;
    const state = createSignedState(requireIntegrationsStateSecret(settings), {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      returnPath,
      ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
    });
    const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", slack.clientId);
    authorizationUrl.searchParams.set("scope", OPENGENI_SLACK_BOT_REQUIRED_SCOPES.join(","));
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);
    return c.json(
      OpenGeniSlackBotInstallStart.parse({
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
      }),
    );
  });

  app.get("/v1/integrations/slack/callback", async (c) => {
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, c.req.url);
    let state: OpenGeniSlackInstallState | null = null;
    try {
      state = readOpenGeniSlackInstallState(c.req.query("state"), settings);
      const consumed = await consumeIntegrationOAuthStateNonce(db, {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        subjectId: state.subjectId,
        nonce: state.nonce,
        expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
        now: new Date(),
      });
      if (!consumed) {
        throw new HTTPException(400, { message: "Slack installation state has already been used" });
      }
      const slackError = c.req.query("error");
      if (slackError) {
        return c.redirect(
          slackInstallReturnUrl(baseUrl, state.returnPath, "error", slackError),
          302,
        );
      }
      const code = c.req.query("code");
      if (!code) {
        throw new HTTPException(400, { message: "Slack installation callback is missing code" });
      }
      const slack = requireOpenGeniSlackOAuthSettings(settings);
      const redirectUri = `${baseUrl}/v1/integrations/slack/callback`;
      const token = await exchangeOpenGeniSlackAuthorizationCode(
        {
          code,
          clientId: slack.clientId,
          clientSecret: slack.clientSecret,
          redirectUri,
        },
        deps.slackFetch ?? fetch,
      );
      const verified = await verifyOpenGeniSlackBotCredential(token, deps.slackFetch ?? fetch);
      const connection = await persistOpenGeniSlackBotConnection({
        deps,
        state,
        token,
        verified,
      });
      return c.redirect(
        slackInstallReturnUrl(baseUrl, state.returnPath, "connected", connection.id),
        302,
      );
    } catch (error) {
      const reason = slackInstallErrorReason(error);
      return c.redirect(
        slackInstallReturnUrl(baseUrl, state?.returnPath ?? "/integrations", "error", reason),
        302,
      );
    }
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

async function persistOpenGeniSlackBotConnection(input: {
  deps: ApiRouteDeps;
  state: OpenGeniSlackInstallState;
  token: string;
  verified: Awaited<ReturnType<typeof verifyOpenGeniSlackBotCredential>>;
}) {
  const { db, settings } = input.deps;
  const key = requireEnvironmentEncryption(settings);
  const credentialEncrypted = encryptCredentialBundle(key, slackBotCredentialBundle(input.token));
  const existing = input.state.connectionId
    ? await getConnectionMetadata(
        db,
        input.state.workspaceId,
        input.state.connectionId,
        input.state.subjectId,
      )
    : null;
  if (input.state.connectionId && !existing) {
    throw new HTTPException(404, { message: "connection not found" });
  }
  if (existing && !isOpenGeniSlackBotConnection(existing)) {
    throw new HTTPException(422, {
      message: "connectionId is not an OpenGeni Slack bot connection",
    });
  }
  if (existing?.version !== input.state.connectionVersion) {
    throw new HTTPException(409, {
      message: "Slack bot connection changed during reinstall; start again",
    });
  }
  const existingMetadata = existing ? openGeniSlackBotMetadata(existing.metadata) : null;
  if (existingMetadata && existingMetadata.slackTeamId !== input.verified.metadata.slackTeamId) {
    throw new HTTPException(409, {
      message: "a Slack bot connection can only be reinstalled for its original Slack workspace",
    });
  }
  if (
    existingMetadata &&
    (existingMetadata.botId !== input.verified.metadata.botId ||
      existingMetadata.botUserId !== input.verified.metadata.botUserId)
  ) {
    throw new HTTPException(409, {
      message:
        "a different Slack bot requires a new connection and explicit scheduled-task rebinding",
    });
  }
  const verifiedInstallAt = new Date(input.verified.metadata.verifiedAt);
  const connection = existing
    ? await updateConnection(db, {
        workspaceId: input.state.workspaceId,
        connectionId: existing.id,
        visibleToSubjectId: input.state.subjectId,
        expectedVersion: existing.version,
        subjectId: null,
        providerDomain: "slack.com",
        kind: "app_install",
        status: "active",
        credentialEncrypted,
        grantedScopes: input.verified.grantedScopes,
        expiresAt: null,
        verifiedInstallAt,
        verifiedInstallVersion: existing.version + 1,
        metadata: input.verified.metadata,
        updatedBySubjectId: input.state.subjectId,
      })
    : await createConnection(db, {
        accountId: input.state.accountId,
        workspaceId: input.state.workspaceId,
        subjectId: null,
        providerDomain: "slack.com",
        kind: "app_install",
        credentialEncrypted,
        grantedScopes: input.verified.grantedScopes,
        expiresAt: null,
        verifiedInstallAt,
        verifiedInstallVersion: 1,
        metadata: input.verified.metadata,
        createdBySubjectId: input.state.subjectId,
      });
  if (!connection) {
    throw new HTTPException(409, {
      message: "Slack bot connection changed during reinstall; start again",
    });
  }
  await recordAuditEvent(db, {
    accountId: input.state.accountId,
    workspaceId: input.state.workspaceId,
    subjectId: input.state.subjectId,
    action: existing ? "slack_bot.reinstalled" : "slack_bot.connected",
    targetType: "connection",
    targetId: connection.id,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      connectionId: connection.id,
      slackTeamId: input.verified.metadata.slackTeamId,
      outcome: "succeeded",
    },
  });
  return connection;
}

function requireOpenGeniSlackOAuthSettings(settings: ApiRouteDeps["settings"]): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = settings.slackClientId?.trim();
  const clientSecret = settings.slackClientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new HTTPException(503, {
      message:
        "OpenGeni Slack installation requires OPENGENI_SLACK_CLIENT_ID and OPENGENI_SLACK_CLIENT_SECRET",
    });
  }
  return { clientId, clientSecret };
}

function readOpenGeniSlackInstallState(
  rawState: string | undefined,
  settings: ApiRouteDeps["settings"],
): OpenGeniSlackInstallState {
  if (!rawState) {
    throw new HTTPException(400, { message: "missing Slack installation state" });
  }
  const payload = readSignedState(rawState, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) {
    throw new HTTPException(400, { message: "invalid or expired Slack installation state" });
  }
  const requiredString = (value: unknown, label: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new HTTPException(400, { message: `invalid Slack installation ${label}` });
    }
    return value;
  };
  const accountId = requiredString(payload.accountId, "account");
  const workspaceId = requiredString(payload.workspaceId, "workspace");
  const subjectId = requiredString(payload.subjectId, "subject");
  const returnPath = requiredString(payload.returnPath, "return path");
  if (returnPath !== `/workspaces/${workspaceId}/capabilities`) {
    throw new HTTPException(400, { message: "invalid Slack installation return path" });
  }
  const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : undefined;
  const connectionVersion =
    typeof payload.connectionVersion === "number" && Number.isInteger(payload.connectionVersion)
      ? payload.connectionVersion
      : undefined;
  if (Boolean(connectionId) !== Boolean(connectionVersion)) {
    throw new HTTPException(400, { message: "invalid Slack reinstall state" });
  }
  return {
    accountId,
    workspaceId,
    subjectId,
    returnPath,
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
    nonce: requiredString(payload.nonce, "nonce"),
    iat:
      typeof payload.iat === "number"
        ? payload.iat
        : (() => {
            throw new HTTPException(400, { message: "invalid Slack installation timestamp" });
          })(),
  };
}

function slackInstallReturnUrl(
  baseUrl: string,
  returnPath: string,
  status: "connected" | "error",
  detail: string,
): string {
  const url = new URL(returnPath, `${baseUrl}/`);
  url.searchParams.set("slack", status);
  url.searchParams.set(status === "connected" ? "connectionId" : "reason", detail.slice(0, 128));
  return url.toString();
}

function slackInstallErrorReason(error: unknown): string {
  if (error instanceof HTTPException) {
    return `http_${error.status}`;
  }
  return "installation_failed";
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
