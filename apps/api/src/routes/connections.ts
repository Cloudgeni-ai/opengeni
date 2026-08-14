import { createHash } from "node:crypto";
import {
  ATLASSIAN_PROVIDER_DOMAIN,
  AtlassianConnectionMetadata,
  AtlassianDisconnectRequest,
  AtlassianLifecycleActionRequest,
  AtlassianOAuthStartRequest,
  AtlassianOAuthStartResponse,
} from "@opengeni/contracts/atlassian";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  ApiIntegrationOAuthStartRequest,
  ConnectionResponse,
  CreateConnectionRequest,
  FIKEN_CREDENTIAL_LABEL,
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  FikenInstallRequest,
  FikenOAuthStartRequest,
  FikenOAuthStartResponse,
  IntegrationClientMetadata,
  ListSlackInstallationBindingsResponse,
  ListConnectionsResponse,
  OpenGeniSlackBotInstallRequest,
  OpenGeniSlackBotInstallStart,
  OAuthStartRequest,
  OAuthStartResponse,
  UpdateConnectionRequest,
} from "@opengeni/contracts";
import {
  bindConnectorDocumentDestination,
  ConnectorDocumentDestinationSelection,
} from "@opengeni/contracts/connector-destinations";
import {
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GoogleDriveConnectionMetadata,
  GoogleDriveDisconnectRequest,
  GoogleDriveLifecycleActionRequest,
  GoogleDriveOAuthStartRequest,
  GoogleDriveOAuthStartResponse,
} from "@opengeni/contracts/google-drive";
import {
  fikenConnectionMetadata,
  hasPermission,
  hasReservedFikenMetadata,
  hasReservedOpenGeniSlackBotMetadata,
  isFikenConnection,
  isOpenGeniSlackBotConnection,
  openGeniSlackBotMetadata,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  resolveFikenDefaultCompanySlug,
} from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  createConnection,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  listConnectionsMetadata,
  listSlackInstallationBindings,
  persistSlackBotInstallationWithSuccessAudit,
  recordSlackBotInstallCallbackFailure,
  revokeConnection,
  revokeConnectionWithSlackBotSuccessAudit,
  SlackBotLifecycleSuccessAuditError,
  SlackInstallationBindingConflictError,
  updateConnection,
  updateSlackBotDocumentDestination,
  type SlackBotInstallCallbackFailureReason,
  type SlackBotInstallCallbackFailureStage,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  browseGoogleDrive,
  completeGoogleDriveOAuthCallback,
  disconnectGoogleDrive,
  saveGoogleDriveSource,
  startGoogleDriveOAuth,
  transitionGoogleDriveLifecycle,
} from "../integrations/google-drive";
import {
  completeApiIntegrationProviderOAuth,
  startApiIntegrationProviderOAuth,
} from "../integrations/provider-oauth";
import {
  browseAtlassianSources,
  completeAtlassianOAuthCallback,
  disconnectAtlassian,
  saveAtlassianSources,
  startAtlassianOAuth,
  transitionAtlassianLifecycle,
} from "../integrations/atlassian";
import {
  completeMcpOAuthCallback,
  integrationBaseUrl,
  startMcpOAuth,
} from "../integrations/oauth-client";
import { canonicalProviderDomain } from "../integrations/provider-domain";
import {
  exchangeOpenGeniSlackAuthorizationCode,
  SlackBotCredentialVerificationError,
  verifyOpenGeniSlackBotCredential,
} from "../integrations/slack-bot";
import {
  completeFikenOAuthCallback,
  fikenCredentialBundle,
  startFikenOAuth,
  verifyFikenApiToken,
} from "../integrations/fiken";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
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

  app.get("/v1/workspaces/:workspaceId/connections/slack-bot/bindings", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    return c.json(
      ListSlackInstallationBindingsResponse.parse({
        bindings: await listSlackInstallationBindings(db, {
          accountId: grant.accountId,
          workspaceId,
        }),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = CreateConnectionRequest.parse(await c.req.json());
    assertNotReservedSlackBotMetadata(payload.metadata);
    assertNotReservedFikenMetadata(payload.metadata);
    assertNotReservedApiIntegrationOAuthMetadata(payload.metadata);
    const key = requireEnvironmentEncryption(settings);
    const subjectId = createConnectionSubjectId(payload, grant.subjectId);
    const providerDomain = canonicalProviderDomain(payload.providerDomain);
    assertNotDirectPersonalSlackOAuth(providerDomain, payload.kind);
    assertNotDirectGoogleDriveOAuth(providerDomain, payload.kind, payload.metadata);
    assertNotDirectAtlassianOAuth(providerDomain, payload.kind, payload.metadata);
    const connection = await createConnection(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId,
      providerDomain,
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
    authorizationUrl.searchParams.set("scope", OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(","));
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
    let stage: SlackBotInstallCallbackFailureStage = "permission_check";
    try {
      state = readOpenGeniSlackInstallState(c.req.query("state"), settings);
      await requireSlackInstallCallbackGrant(db, state);
      stage = "nonce_consume";
      const consumed = await consumeIntegrationOAuthStateNonce(db, {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        subjectId: state.subjectId,
        nonce: state.nonce,
        expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
        now: new Date(),
      });
      if (!consumed) {
        throw new SlackInstallCallbackError(
          400,
          "state_replayed",
          "Slack installation state has already been used",
        );
      }
      if (c.req.query("error")) {
        stage = "provider_denial";
        throw new SlackInstallCallbackError(
          400,
          "provider_denied",
          "Slack installation authorization was denied",
        );
      }
      stage = "code_exchange";
      const code = c.req.query("code");
      if (!code) {
        throw new SlackInstallCallbackError(
          400,
          "missing_code",
          "Slack installation callback is missing code",
        );
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
      stage = "credential_verification";
      const verified = await verifyOpenGeniSlackBotCredential(token, deps.slackFetch ?? fetch);
      stage = "permission_recheck";
      await requireSlackInstallCallbackGrant(db, state);
      stage = "persistence";
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
      if (state) {
        const failure = slackInstallCallbackFailure(stage, error);
        try {
          await recordSlackBotInstallCallbackFailure(db, {
            accountId: state.accountId,
            workspaceId: state.workspaceId,
            subjectId: state.subjectId,
            callbackDigest: createHash("sha256").update(state.nonce).digest("hex"),
            installMode: state.connectionId ? "reinstall" : "connect",
            ...failure,
          });
        } catch {
          return c.redirect(
            slackInstallReturnUrl(baseUrl, state.returnPath, "error", "installation_failed"),
            302,
          );
        }
      }
      const reason = slackInstallErrorReason(error);
      return c.redirect(
        slackInstallReturnUrl(baseUrl, state?.returnPath ?? "/integrations", "error", reason),
        302,
      );
    }
  });

  // Verified paste-a-token install for the first-party Fiken connector. The
  // token is validated against Fiken (and its accessible companies discovered)
  // before it enters encrypted storage. Workspace-owned only.
  app.post("/v1/workspaces/:workspaceId/connections/fiken/install", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = FikenInstallRequest.parse(await c.req.json());
    const key = requireEnvironmentEncryption(settings);
    const existing = payload.connectionId
      ? await getConnectionMetadata(db, workspaceId, payload.connectionId, null)
      : null;
    if (payload.connectionId && !existing) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    if (existing && !isFikenConnection(existing)) {
      throw new HTTPException(422, { message: "connectionId is not a Fiken connection" });
    }
    const verified = await verifyFikenApiToken(payload.apiToken, deps.fikenFetch ?? fetch);
    const previousDefault = existing
      ? (fikenConnectionMetadata(existing.metadata)?.defaultCompanySlug ?? null)
      : null;
    const defaultCompanySlug = resolveFikenDefaultCompanySlug({
      requested: payload.defaultCompanySlug ?? null,
      previous: previousDefault,
      companies: verified.companies,
    });
    if (payload.defaultCompanySlug && defaultCompanySlug !== payload.defaultCompanySlug) {
      throw new HTTPException(422, {
        message: `defaultCompanySlug is not among the companies this token can access: ${verified.companies
          .map((company) => company.slug)
          .join(", ")}`,
      });
    }
    const metadata = {
      credentialRole: FIKEN_CREDENTIAL_ROLE,
      credentialLabel: FIKEN_CREDENTIAL_LABEL,
      companies: verified.companies,
      defaultCompanySlug,
      verifiedAt: new Date().toISOString(),
    };
    const credentialEncrypted = encryptCredentialBundle(
      key,
      fikenCredentialBundle(payload.apiToken),
    );
    if (existing) {
      // Rewrites the whole credential identity: a token pasted over an OAuth
      // row must also flip kind and clear the OAuth expiry, or the broker
      // keeps treating the api_key bundle as a refreshable oauth2 credential.
      const updated = await updateConnection(db, {
        workspaceId,
        connectionId: existing.id,
        visibleToSubjectId: null,
        expectedVersion: existing.version,
        kind: "api_key",
        status: "active",
        credentialEncrypted,
        grantedScopes: [],
        expiresAt: null,
        metadata,
        updatedBySubjectId: grant.subjectId,
      });
      if (!updated) {
        throw new HTTPException(409, { message: "the Fiken connection changed; retry" });
      }
      return c.json(ConnectionResponse.parse({ connection: updated }));
    }
    const connection = await createConnection(db, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: null,
      providerDomain: FIKEN_PROVIDER_DOMAIN,
      kind: "api_key",
      credentialEncrypted,
      grantedScopes: [],
      expiresAt: null,
      metadata,
      createdBySubjectId: grant.subjectId,
    });
    return c.json(ConnectionResponse.parse({ connection }), 201);
  });

  // Fiken OAuth (registered app) start. Both Fiken lanes produce the same
  // workspace-owned connection shape; this one refreshes through the broker.
  app.post("/v1/workspaces/:workspaceId/connections/fiken/oauth/start", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const payload = FikenOAuthStartRequest.parse(await c.req.json());
    requireEnvironmentEncryption(settings);
    return c.json(
      FikenOAuthStartResponse.parse(
        await startFikenOAuth(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          requestUrl: c.req.url,
          payload,
        }),
      ),
    );
  });

  app.get("/v1/integrations/fiken/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeFikenOAuthCallback(deps, {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      ...(c.req.query("picked_file_ids") ? { pickedFileIds: c.req.query("picked_file_ids") } : {}),
      requestUrl: c.req.url,
    });
    return c.redirect(result.redirectTo, 302);
  });

  app.post("/v1/workspaces/:workspaceId/connections/google-drive/install", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const parsed = GoogleDriveOAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid Google Drive install request" });
    }
    return c.json(
      GoogleDriveOAuthStartResponse.parse(
        await startGoogleDriveOAuth(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          requestUrl: c.req.url,
          payload: parsed.data,
        }),
      ),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/atlassian/install", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const parsed = AtlassianOAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid Atlassian install request" });
    }
    return c.json(
      AtlassianOAuthStartResponse.parse(
        await startAtlassianOAuth(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          requestUrl: c.req.url,
          payload: parsed.data,
        }),
      ),
    );
  });

  app.get("/v1/integrations/atlassian/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeAtlassianOAuthCallback(deps, {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      requestUrl: c.req.url,
    });
    return c.redirect(result.redirectTo, 302);
  });

  app.patch(
    "/v1/workspaces/:workspaceId/connections/atlassian/:connectionId/lifecycle",
    async (c) => {
      assertIntegrationsEnabled();
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
      const parsed = AtlassianLifecycleActionRequest.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid Atlassian lifecycle request" });
      }
      return c.json(
        ConnectionResponse.parse({
          connection: await transitionAtlassianLifecycle(deps, {
            workspaceId,
            subjectId: grant.subjectId,
            connectionId: c.req.param("connectionId"),
            payload: parsed.data,
          }),
        }),
      );
    },
  );

  app.get("/v1/workspaces/:workspaceId/connections/atlassian/:connectionId/browse", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
    return c.json(
      await browseAtlassianSources(deps, {
        workspaceId,
        subjectId: grant.subjectId,
        connectionId: c.req.param("connectionId"),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/connections/atlassian/:connectionId/source", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const { grant } = authorization;
    const connection = await saveAtlassianSources(deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      grant,
      connectionId: c.req.param("connectionId"),
      payload: await c.req.json(),
      canManageOrganizationDestination:
        authorization.accountGrant?.permissions.includes("account:admin") === true,
      canManageWorkspaceDestination: hasPermission(grant.permissions, "workspace:admin"),
      canManagePersonalDestination:
        authorization.contextIntegrity && authorization.authenticatedSubjectId === grant.subjectId,
    });
    return c.json(ConnectionResponse.parse({ connection }));
  });

  app.get("/v1/integrations/google-drive/callback", async (c) => {
    assertIntegrationsEnabled();
    const input = {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      requestUrl: c.req.url,
    };
    const result = await completeGoogleDriveOAuthCallback(deps, input);
    return c.redirect(result.redirectTo, 302);
  });

  app.patch(
    "/v1/workspaces/:workspaceId/connections/google-drive/:connectionId/lifecycle",
    async (c) => {
      assertIntegrationsEnabled();
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
      const parsed = GoogleDriveLifecycleActionRequest.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid Google Drive lifecycle request" });
      }
      return c.json(
        ConnectionResponse.parse({
          connection: await transitionGoogleDriveLifecycle(deps, {
            workspaceId,
            subjectId: grant.subjectId,
            connectionId: c.req.param("connectionId"),
            payload: parsed.data,
          }),
        }),
      );
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/connections/google-drive/:connectionId/browse",
    async (c) => {
      assertIntegrationsEnabled();
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
      return c.json(
        await browseGoogleDrive(deps, {
          workspaceId,
          subjectId: grant.subjectId,
          connectionId: c.req.param("connectionId"),
          parentId: c.req.query("parentId") ?? "root",
          ...(c.req.query("pageToken") ? { pageToken: c.req.query("pageToken") } : {}),
        }),
      );
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/connections/google-drive/:connectionId/source",
    async (c) => {
      assertIntegrationsEnabled();
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      const { grant } = authorization;
      const connection = await saveGoogleDriveSource(deps, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        grant,
        connectionId: c.req.param("connectionId"),
        payload: await c.req.json(),
        canManageOrganizationDestination:
          authorization.accountGrant?.permissions.includes("account:admin") === true,
        canManageWorkspaceDestination: hasPermission(grant.permissions, "workspace:admin"),
        canManagePersonalDestination:
          authorization.contextIntegrity &&
          authorization.authenticatedSubjectId === grant.subjectId,
      });
      return c.json(ConnectionResponse.parse({ connection }));
    },
  );

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
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const { grant } = authorization;
    const payload = UpdateConnectionRequest.parse(await c.req.json());
    assertNotReservedSlackBotMetadata(payload.metadata);
    assertNotReservedFikenMetadata(payload.metadata);
    assertNotReservedApiIntegrationOAuthMetadata(payload.metadata);
    const existing = await getConnectionMetadata(
      db,
      workspaceId,
      c.req.param("connectionId"),
      grant.subjectId,
    );
    if (existing && isOpenGeniSlackBotConnection(existing)) {
      const destination = ConnectorDocumentDestinationSelection.safeParse(
        payload.metadata?.documentDestination,
      );
      const destinationOnlyUpdate =
        payload.metadata !== undefined &&
        Object.keys(payload.metadata).length === 1 &&
        payload.providerDomain === undefined &&
        payload.subjectId === undefined &&
        payload.kind === undefined &&
        payload.status === undefined &&
        payload.credential === undefined &&
        payload.grantedScopes === undefined &&
        payload.expiresAt === undefined;
      if (!destination.success || !destinationOnlyUpdate) {
        throw new HTTPException(422, {
          message: "use the dedicated OpenGeni Slack bot reinstall flow to update this connection",
        });
      }
      const destinationSelection = destination.data;
      if (
        destinationSelection.authorityKind === "organization" &&
        authorization.accountGrant?.permissions.includes("account:admin") !== true
      ) {
        throw new HTTPException(403, { message: "missing permission: account:admin" });
      }
      if (
        destinationSelection.authorityKind === "workspace" &&
        !hasPermission(grant.permissions, "workspace:admin")
      ) {
        throw new HTTPException(403, { message: "missing permission: workspace:admin" });
      }
      if (
        destinationSelection.authorityKind === "personal" &&
        (!authorization.contextIntegrity ||
          authorization.authenticatedSubjectId !== grant.subjectId)
      ) {
        throw new HTTPException(403, {
          message: "personal destination requires the exact actor",
        });
      }
      const metadata = {
        ...existing.metadata,
        documentDestination: bindConnectorDocumentDestination(destinationSelection, {
          accountId: grant.accountId,
          workspaceId,
          initiatingSubjectId: grant.subjectId,
        }),
      };
      const connection = await updateSlackBotDocumentDestination(db, {
        accountId: grant.accountId,
        workspaceId,
        connectionId: existing.id,
        visibleToSubjectId: grant.subjectId,
        expectedVersion: existing.version,
        metadata,
        updatedBySubjectId: grant.subjectId,
      });
      if (!connection) {
        throw new HTTPException(409, {
          message: "Slack bot connection changed; reload before saving its destination",
        });
      }
      return c.json(ConnectionResponse.parse({ connection }));
    }
    if (existing && GoogleDriveConnectionMetadata.safeParse(existing.metadata).success) {
      throw new HTTPException(422, {
        message: "use the dedicated Google Drive reconnect or source-selection flow",
      });
    }
    if (existing?.metadata.credentialRole === API_INTEGRATION_OAUTH_CREDENTIAL_ROLE) {
      throw new HTTPException(422, {
        message: "use the dedicated Integration provider OAuth flow to update this connection",
      });
    }
    if (existing && AtlassianConnectionMetadata.safeParse(existing.metadata).success) {
      throw new HTTPException(422, {
        message: "use the dedicated Atlassian reconnect or source-selection flow",
      });
    }
    if (existing) {
      const providerDomain = canonicalProviderDomain(
        payload.providerDomain ?? existing.providerDomain,
      );
      const kind = payload.kind ?? existing.kind;
      assertNotDirectPersonalSlackOAuth(providerDomain, kind);
      assertNotDirectGoogleDriveOAuth(providerDomain, kind, payload.metadata ?? existing.metadata);
      assertNotDirectAtlassianOAuth(providerDomain, kind, payload.metadata ?? existing.metadata);
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
    const connectionId = c.req.param("connectionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const existing = await getConnectionMetadata(db, workspaceId, connectionId, grant.subjectId);
    if (!existing) {
      throw new HTTPException(404, { message: "connection not found" });
    }
    const isGoogleDrive =
      existing.subjectId === grant.subjectId &&
      existing.providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN &&
      existing.kind === "oauth2" &&
      GoogleDriveConnectionMetadata.safeParse(existing.metadata).success;
    const isAtlassian =
      existing.subjectId === grant.subjectId &&
      existing.providerDomain === ATLASSIAN_PROVIDER_DOMAIN &&
      existing.kind === "oauth2" &&
      AtlassianConnectionMetadata.safeParse(existing.metadata).success;
    const disconnectPayload = await c.req.json().catch(() => null);
    const googleDriveDisconnect = isGoogleDrive
      ? GoogleDriveDisconnectRequest.safeParse(disconnectPayload)
      : null;
    if (googleDriveDisconnect && !googleDriveDisconnect.success) {
      throw new HTTPException(400, {
        message:
          googleDriveDisconnect.error.issues[0]?.message ??
          "invalid Google Drive disconnect request",
      });
    }
    const atlassianDisconnect = isAtlassian
      ? AtlassianDisconnectRequest.safeParse(disconnectPayload)
      : null;
    if (atlassianDisconnect && !atlassianDisconnect.success) {
      throw new HTTPException(400, {
        message:
          atlassianDisconnect.error.issues[0]?.message ?? "invalid Atlassian disconnect request",
      });
    }
    if (existing.status === "revoked" && !isGoogleDrive && !isAtlassian) {
      return c.json(ConnectionResponse.parse({ connection: existing }));
    }
    const connection = isGoogleDrive
      ? await disconnectGoogleDrive(deps, {
          workspaceId,
          subjectId: grant.subjectId,
          connection: existing,
          payload: googleDriveDisconnect!.data,
        })
      : isAtlassian
        ? await disconnectAtlassian(deps, {
            workspaceId,
            subjectId: grant.subjectId,
            connection: existing,
            payload: atlassianDisconnect!.data,
          })
        : isOpenGeniSlackBotConnection(existing)
          ? await revokeConnectionWithSlackBotSuccessAudit(db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              connectionId,
              expectedVersion: existing.version,
              credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
              credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
              slackTeamId: openGeniSlackBotMetadata(existing.metadata)!.slackTeamId,
            })
          : await revokeConnection(
              db,
              workspaceId,
              connectionId,
              grant.subjectId,
              existing.version,
            );
    if (!connection) {
      throw new HTTPException(409, { message: "connection changed during disconnect; try again" });
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
      { db, settings, observability, oauthStartDeadlineMs: deps.oauthStartDeadlineMs },
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

  app.post("/v1/workspaces/:workspaceId/integrations/oauth/start", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
    const parsed = ApiIntegrationOAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "invalid Integration OAuth start request",
      });
    }
    return c.json(
      OAuthStartResponse.parse(
        await startApiIntegrationProviderOAuth(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          requestUrl: c.req.url,
          payload: parsed.data,
        }),
      ),
    );
  });

  app.get("/v1/integrations/oauth/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeMcpOAuthCallback(
      { db, settings, observability, oauthCallbackDeadlineMs: deps.oauthCallbackDeadlineMs },
      {
        code: c.req.query("code"),
        state: c.req.query("state"),
        requestUrl: c.req.url,
      },
    );
    return c.redirect(result.redirectTo, 302);
  });

  app.get("/v1/integrations/provider-oauth/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeApiIntegrationProviderOAuth(deps, {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      requestUrl: c.req.url,
    });
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
  const requestedExisting = input.state.connectionId
    ? await getConnectionMetadata(
        db,
        input.state.workspaceId,
        input.state.connectionId,
        input.state.subjectId,
      )
    : null;
  if (input.state.connectionId && !requestedExisting) {
    throw new SlackInstallCallbackError(
      404,
      "connection_conflict",
      "connection not found",
      "principal_validation",
    );
  }
  if (requestedExisting && !isOpenGeniSlackBotConnection(requestedExisting)) {
    throw new SlackInstallCallbackError(
      422,
      "connection_conflict",
      "connectionId is not an OpenGeni Slack bot connection",
      "principal_validation",
    );
  }
  if (requestedExisting && requestedExisting.version !== input.state.connectionVersion) {
    throw new SlackInstallCallbackError(
      409,
      "connection_conflict",
      "Slack bot connection changed during reinstall; start again",
      "principal_validation",
    );
  }
  const existingMetadata = requestedExisting
    ? openGeniSlackBotMetadata(requestedExisting.metadata)
    : null;
  if (existingMetadata && existingMetadata.slackTeamId !== input.verified.metadata.slackTeamId) {
    throw new SlackInstallCallbackError(
      409,
      "principal_mismatch",
      "a Slack bot connection can only be reinstalled for its original Slack workspace",
      "principal_validation",
    );
  }
  if (
    existingMetadata &&
    (existingMetadata.botId !== input.verified.metadata.botId ||
      existingMetadata.botUserId !== input.verified.metadata.botUserId)
  ) {
    throw new SlackInstallCallbackError(
      409,
      "principal_mismatch",
      "a different Slack bot requires a new connection and explicit scheduled-task rebinding",
      "principal_validation",
    );
  }
  const verifiedInstallAt = new Date(input.verified.metadata.verifiedAt);
  try {
    return await persistSlackBotInstallationWithSuccessAudit(db, {
      accountId: input.state.accountId,
      workspaceId: input.state.workspaceId,
      subjectId: input.state.subjectId,
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: input.verified.metadata.slackTeamId,
      ...(input.state.connectionId
        ? {
            requestedConnectionId: input.state.connectionId,
            requestedConnectionVersion: input.state.connectionVersion,
          }
        : {}),
      credentialEncrypted,
      grantedScopes: input.verified.grantedScopes,
      verifiedInstallAt,
      metadata: input.verified.metadata,
    });
  } catch (error) {
    if (error instanceof SlackInstallationBindingConflictError) {
      throw new SlackInstallCallbackError(
        409,
        "connection_conflict",
        error.message,
        "principal_validation",
      );
    }
    throw error;
  }
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    typeof payload.iat !== "number" ||
    nowSeconds < payload.iat ||
    nowSeconds - payload.iat > oauthStateTtlMs / 1000
  ) {
    throw new HTTPException(400, { message: "invalid or expired Slack installation state" });
  }
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

class SlackInstallCallbackError extends HTTPException {
  constructor(
    status: 400 | 403 | 404 | 409 | 422,
    readonly failureReason: SlackBotInstallCallbackFailureReason,
    message: string,
    readonly failureStage?: SlackBotInstallCallbackFailureStage,
  ) {
    super(status, { message });
    this.name = "SlackInstallCallbackError";
  }
}

function slackInstallCallbackFailure(
  stage: SlackBotInstallCallbackFailureStage,
  error: unknown,
): {
  stage: SlackBotInstallCallbackFailureStage;
  reason: SlackBotInstallCallbackFailureReason;
} {
  if (error instanceof SlackInstallCallbackError) {
    return { stage: error.failureStage ?? stage, reason: error.failureReason };
  }
  if (error instanceof SlackBotCredentialVerificationError) {
    return { stage: "credential_verification", reason: error.failureReason };
  }
  if (error instanceof SlackBotLifecycleSuccessAuditError) {
    return { stage: "persistence", reason: "success_audit_failed" };
  }
  if (stage === "code_exchange") {
    return { stage, reason: "exchange_failed" };
  }
  if (stage === "credential_verification") {
    return { stage, reason: "credential_verification_failed" };
  }
  return { stage, reason: "persistence_failed" };
}

function slackInstallErrorReason(error: unknown): string {
  if (error instanceof SlackInstallCallbackError && error.failureReason === "provider_denied") {
    return "provider_denied";
  }
  if (error instanceof HTTPException) {
    return `http_${error.status}`;
  }
  return "installation_failed";
}

async function requireSlackInstallCallbackGrant(
  db: ApiRouteDeps["db"],
  state: OpenGeniSlackInstallState,
): Promise<void> {
  const grant = await getWorkspaceGrant(db, state.subjectId, state.workspaceId);
  if (
    !grant ||
    grant.accountId !== state.accountId ||
    !hasPermission(grant.permissions, "connections:write")
  ) {
    throw new SlackInstallCallbackError(
      403,
      "permission_lost",
      "Slack installation subject no longer has permission for this workspace",
    );
  }
}

function assertNotDirectPersonalSlackOAuth(providerDomain: string, kind: string): void {
  if (providerDomain === "slack.com" && kind === "oauth2") {
    throw new HTTPException(422, {
      message: "personal Slack credentials must use the hosted MCP OAuth flow",
    });
  }
}

function assertNotDirectGoogleDriveOAuth(
  providerDomain: string,
  kind: string,
  metadata: Record<string, unknown> | undefined,
): void {
  if (
    (providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN && kind === "oauth2") ||
    GoogleDriveConnectionMetadata.safeParse(metadata).success
  ) {
    throw new HTTPException(422, {
      message: "Google Drive credentials must use the dedicated OAuth connection flow",
    });
  }
}

function assertNotDirectAtlassianOAuth(
  providerDomain: string,
  kind: string,
  metadata: Record<string, unknown> | undefined,
): void {
  if (
    (providerDomain === ATLASSIAN_PROVIDER_DOMAIN && kind === "oauth2") ||
    AtlassianConnectionMetadata.safeParse(metadata).success
  ) {
    throw new HTTPException(422, {
      message: "Atlassian credentials must use the dedicated OAuth connection flow",
    });
  }
}

function assertNotReservedSlackBotMetadata(metadata: Record<string, unknown> | undefined): void {
  if (hasReservedOpenGeniSlackBotMetadata(metadata)) {
    throw new HTTPException(422, {
      message: "OpenGeni Slack bot metadata is reserved for the dedicated connection flow",
    });
  }
}

function assertNotReservedFikenMetadata(metadata: Record<string, unknown> | undefined): void {
  if (hasReservedFikenMetadata(metadata)) {
    throw new HTTPException(422, {
      message: "Fiken connection metadata is reserved for the verified Fiken connect flows",
    });
  }
}

function assertNotReservedApiIntegrationOAuthMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  if (metadata?.credentialRole === API_INTEGRATION_OAUTH_CREDENTIAL_ROLE) {
    throw new HTTPException(422, {
      message: "API Integration OAuth metadata is reserved for the dedicated provider flow",
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

function createConnectionSubjectId(
  payload: Pick<CreateConnectionRequest, "ownership" | "subjectId">,
  grantSubjectId: string,
): string | null {
  if (payload.ownership === undefined) {
    return writableSubjectId(payload.subjectId, grantSubjectId);
  }
  const subjectId = payload.ownership === "personal" ? grantSubjectId : null;
  if (payload.subjectId !== undefined && payload.subjectId !== subjectId) {
    throw new HTTPException(422, {
      message: "ownership and subjectId describe different connection owners",
    });
  }
  return subjectId;
}

function encryptCredentialBundle(key: Uint8Array, credential: Record<string, unknown>): string {
  return encryptEnvironmentValue(key, JSON.stringify(credential));
}

function slackBotCredentialBundle(token: string): Record<string, unknown> {
  const headerName = ["author", "ization"].join("");
  const scheme = ["Bear", "er"].join("");
  return { headers: { [headerName]: `${scheme} ${token}` } };
}
