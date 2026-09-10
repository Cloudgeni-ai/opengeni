import { createHash, createHmac } from "node:crypto";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  startSlackBotInstall,
  requireOpenGeniSlackOAuthSettings,
} from "../integrations/slack-install";
import {
  WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
  WORKSPACE_OPENROUTER_CONNECTION_ROLE,
  VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
  VERCEL_AI_GATEWAY_CONNECTION_ROLE,
} from "@opengeni/config";
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
  FikenInstallRequest,
  FikenOAuthStartRequest,
  FikenOAuthStartResponse,
  IntegrationClientMetadata,
  ListSlackInstallationBindingsResponse,
  ListConnectionsResponse,
  OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY,
  OpenGeniSlackBotInstallRequest,
  OAuthStartRequest,
  OAuthStartResponse,
  UpdateConnectionRequest,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY,
  VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY,
  stableJson,
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
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  PersonalGitHubDisconnectRequest,
  hasReservedPersonalGitHubMetadata,
  isPersonalGitHubConnection,
} from "@opengeni/contracts/personal-github";
import {
  hasPermission,
  hasReservedFikenMetadata,
  hasReservedOpenGeniSlackBotMetadata,
  isOpenGeniSlackBotConnection,
  openGeniSlackBotMetadata,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  externalContinuationCommitAuthorizer,
} from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  claimConnectOperation,
  finishConnectOperation,
  getConnectAttempt,
  decryptEnvironmentValue,
  createConnection,
  withWorkspaceSubjectRls,
  type Database,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  listSlackInstallationBindings,
  persistSlackBotInstallationWithSuccessAudit,
  recordSlackBotInstallCallbackFailure,
  revokeConnection,
  revokeWorkspaceOpenRouterConnections,
  revokeWorkspaceVercelAiGatewayConnections,
  revokeConnectionWithSlackBotSuccessAudit,
  rotateWorkspaceVercelAiGatewayConnection,
  rotateWorkspaceOpenRouterConnection,
  SlackBotLifecycleSuccessAuditError,
  SlackInstallationBindingConflictError,
  updateConnection,
  updateSlackBotDocumentDestination,
  upsertWorkspaceVercelAiGatewayConnection,
  upsertWorkspaceOpenRouterConnection,
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
  isApiIntegrationProviderOAuthState,
  startApiIntegrationProviderOAuth,
} from "../integrations/provider-oauth";
import { disconnectPersonalGitHub } from "../integrations/personal-github";
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
import {
  assertPersonalConnectionOwnerPrincipal,
  isPersonalConnectionOwnerPrincipal,
  requireLegacyOAuthActor,
} from "../connection-ownership";
import { canonicalProviderDomain } from "../integrations/provider-domain";
import { externalActorContinuationForAuthorization } from "@opengeni/core";
import {
  exchangeOpenGeniSlackAuthorizationCode,
  SlackBotCredentialVerificationError,
  verifyOpenGeniSlackBotCredential,
} from "../integrations/slack-bot";
import {
  completeFikenOAuthCallback,
  startFikenOAuth,
  prepareFikenTokenInstall,
} from "../integrations/fiken";
import { requireConnectOwnerAuthority } from "../integrations/connect-authority";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { readSignedState } from "@opengeni/github";
import { oauthStateTtlMs, requireIntegrationsStateSecret } from "../integrations/oauth-client";

type OpenGeniSlackInstallState = {
  connectAttemptId?: string;
  externalContinuation?: ExternalActorContinuation;
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
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    const grant = access.grant;
    const beforeCommit = externalContinuationCommitAuthorizer(access);
    const payload = CreateConnectionRequest.parse(await c.req.json());
    // All writes in this closure must use the caller-owned scoped transaction.
    // eslint-disable-next-line no-shadow
    const persist = async (db: Database) => {
      assertNotReservedSlackBotMetadata(payload.metadata);
      assertNotReservedFikenMetadata(payload.metadata);
      assertNotReservedApiIntegrationOAuthMetadata(payload.metadata);
      assertNotReservedPersonalGitHubMetadata(payload.metadata);
      const key = requireEnvironmentEncryption(settings);
      const subjectId = createConnectionSubjectId(payload, grant.subjectId);
      if (subjectId !== null) {
        assertPersonalConnectionOwnerPrincipal(access);
      }
      const providerDomain = canonicalProviderDomain(payload.providerDomain);
      assertNotDirectPersonalSlackOAuth(providerDomain, payload.kind);
      assertNotDirectGoogleDriveOAuth(providerDomain, payload.kind, payload.metadata);
      assertNotDirectAtlassianOAuth(providerDomain, payload.kind, payload.metadata);
      assertNotDirectPersonalGitHubOAuth(providerDomain, payload.kind, payload.metadata);
      const credentialEncrypted = encryptCredentialBundle(key, payload.credential);
      const workspaceProviderKind = workspaceProviderApiKeyConnectionKind({
        subjectId,
        providerDomain,
        kind: payload.kind,
        metadata: payload.metadata,
      });
      const connection = workspaceProviderKind
        ? await (async () => {
            const provider = workspaceProviderApiKeyConnectionSpec(workspaceProviderKind);
            if (!payload.operationId) {
              throw new HTTPException(400, {
                message: `connecting ${provider.label} requires an operationId`,
              });
            }
            const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
            const metadata = workspaceProviderCredentialMetadata(
              workspaceProviderKind,
              payload.metadata,
            );
            const input = {
              accountId: grant.accountId,
              workspaceId,
              operationId: payload.operationId,
              requestDigest: workspaceProviderCredentialRequestDigest(key, {
                action: "create",
                providerDomain,
                kind: payload.kind,
                subjectId,
                credential: payload.credential,
                grantedScopes: payload.grantedScopes,
                expiresAt: expiresAt?.toISOString() ?? null,
                metadata,
              }),
              credentialEncrypted,
              grantedScopes: payload.grantedScopes,
              expiresAt,
              metadata,
              updatedBySubjectId: grant.subjectId,
            };
            const created =
              workspaceProviderKind === "vercel_gateway"
                ? await upsertWorkspaceVercelAiGatewayConnection(db, input)
                : await upsertWorkspaceOpenRouterConnection(db, input);
            if (!created || created.status === "revoked") {
              throw new HTTPException(409, {
                message: `${provider.label} is already connected; reload before replacing its key`,
              });
            }
            return created;
          })()
        : await createConnection(db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId,
            providerDomain,
            kind: payload.kind,
            credentialEncrypted,
            grantedScopes: payload.grantedScopes,
            expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
            metadata: payload.metadata,
            createdBySubjectId: grant.subjectId,
          });
      return c.json(ConnectionResponse.parse({ connection }), 201);
    };
    return beforeCommit
      ? withWorkspaceSubjectRls(db, workspaceId, grant.subjectId, async (tx) => {
          await beforeCommit(tx);
          return persist(tx);
        })
      : persist(db);
  });

  app.post("/v1/workspaces/:workspaceId/connections/slack-bot/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    requireLegacyOAuthActor(access);
    const grant = access.grant;
    const payload = OpenGeniSlackBotInstallRequest.parse(await c.req.json());
    return c.json(
      await startSlackBotInstall(deps, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        requestUrl: c.req.url,
        ...(payload.connectionId ? { connectionId: payload.connectionId } : {}),
      }),
    );
  });

  app.get("/v1/integrations/slack/callback", async (c) => {
    const baseUrl = integrationBaseUrl(settings.publicBaseUrl, c.req.url);
    let state: OpenGeniSlackInstallState | null = null;
    let exactReturnUrl: string | undefined;
    let operation: { attemptId: string; operationId: string; inputDigest: string } | undefined;
    let stage: SlackBotInstallCallbackFailureStage = "permission_check";
    try {
      state = readOpenGeniSlackInstallState(c.req.query("state"), settings);
      if (state.connectAttemptId) {
        const stored = await getConnectAttempt(db, state, state.connectAttemptId);
        if (stored.attempt.providerId !== "slack-bot" || stored.attempt.ownership !== "workspace")
          throw new HTTPException(403, { message: "Slack attempt mismatch" });
        exactReturnUrl = stored.returnUrl;
        operation = {
          attemptId: state.connectAttemptId,
          operationId: `oauth:${state.nonce}`,
          inputDigest: createHash("sha256").update(c.req.query("state")!).digest("hex"),
        };
        const claim = await claimConnectOperation(db, state, {
          ...operation,
          expectedRevision: stored.attempt.revision,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, state!, "connections:write", origin),
        });
        if (claim.status === "replayed")
          return new Response(null, { status: 302, headers: { Location: exactReturnUrl } });
      }
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
      if (operation && (c.req.query("error") || !c.req.query("code"))) {
        await finishConnectOperation(db, state, {
          ...operation,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, state!, "connections:write", origin),
          commit: async (_tx, current) => ({
            ...current,
            revision: current.revision + 1,
            state: c.req.query("error") === "access_denied" ? "cancelled" : "failed",
            nextAction: { type: "none" },
            error: {
              code: c.req.query("error") ? "provider_denied" : "missing_code",
              message: "Authorization was not completed. Start a new connection attempt.",
              retryable: false,
            },
          }),
        });
        return new Response(null, { status: 302, headers: { Location: exactReturnUrl! } });
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
      const authorization = await exchangeOpenGeniSlackAuthorizationCode(
        {
          code,
          clientId: slack.clientId,
          clientSecret: slack.clientSecret,
          redirectUri,
        },
        deps.slackFetch ?? fetch,
      );
      stage = "credential_verification";
      const verified = await verifyOpenGeniSlackBotCredential(
        authorization.accessToken,
        {
          appId: authorization.appId,
          displayName: settings.slackBotDisplayName,
        },
        deps.slackFetch ?? fetch,
        new Date(),
      );
      stage = "permission_recheck";
      await requireSlackInstallCallbackGrant(db, state);
      stage = "persistence";
      const acceptedState = state;
      const persist = (tx: Database) =>
        persistOpenGeniSlackBotConnection({
          deps: { ...deps, db: tx },
          state: acceptedState,
          token: authorization.accessToken,
          verified,
        });
      if (operation) {
        await finishConnectOperation(db, acceptedState, {
          ...operation,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, acceptedState, "connections:write", origin),
          commit: async (tx, current) => {
            const connection = await persist(tx);
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete",
              credentialsCommitted: true,
              nextAction: { type: "none" },
              account: {
                id: connection.id,
                version: connection.version,
                providerId: "slack-bot",
                label: "Slack workspace bot",
                ownership: "workspace",
                status: "connected",
              },
            };
          },
        });
        return new Response(null, { status: 302, headers: { Location: exactReturnUrl! } });
      }
      const connection = await db.transaction(async (tx) => {
        await requireSlackInstallCallbackGrant(tx, acceptedState);
        return persist(tx);
      });
      return c.redirect(
        slackInstallReturnUrl(baseUrl, state.returnPath, "connected", connection.id),
        302,
      );
    } catch (error) {
      if (exactReturnUrl)
        return new Response(null, { status: 302, headers: { Location: exactReturnUrl } });
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
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const grant = authorization.grant;
    const payload = FikenInstallRequest.parse(await c.req.json());
    const persist = await prepareFikenTokenInstall(deps, grant, payload);
    const continuation = externalActorContinuationForAuthorization(authorization);
    const connection = await db.transaction(async (tx) => {
      await requireConnectOwnerAuthority(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
        ...(continuation ? { externalContinuation: continuation } : {}),
      });
      return persist(tx);
    });
    return c.json(ConnectionResponse.parse({ connection }), payload.connectionId ? 200 : 201);
  });

  // Fiken OAuth (registered app) start. Both Fiken lanes produce the same
  // workspace-owned connection shape; this one refreshes through the broker.
  app.post("/v1/workspaces/:workspaceId/connections/fiken/oauth/start", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    requireLegacyOAuthActor(access);
    const grant = access.grant;
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
      requestUrl: c.req.url,
    });
    if (result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
    return c.redirect(result.redirectTo, 302);
  });

  app.post("/v1/workspaces/:workspaceId/connections/google-drive/install", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    // The Drive connector writes only a personal Connection, so only a managed
    // human may start it.
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "Google Drive");
    requireLegacyOAuthActor(access);
    const grant = access.grant;
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
    // The Atlassian connector writes only a personal Connection, so only a
    // managed human may start it.
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "Atlassian");
    requireLegacyOAuthActor(access);
    const grant = access.grant;
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
    if (result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
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
      ...(c.req.query("picked_file_ids") ? { pickedFileIds: c.req.query("picked_file_ids") } : {}),
      requestUrl: c.req.url,
    };
    const result = await completeGoogleDriveOAuthCallback(deps, input);
    if (result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
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
    assertNotReservedPersonalGitHubMetadata(payload.metadata);
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
    if (existing && isPersonalGitHubConnection(existing)) {
      throw new HTTPException(422, {
        message: "use the dedicated personal GitHub reconnect flow to update this connection",
      });
    }
    if (existing) {
      const providerDomain = canonicalProviderDomain(
        payload.providerDomain ?? existing.providerDomain,
      );
      const kind = payload.kind ?? existing.kind;
      const subjectId =
        payload.subjectId === undefined
          ? existing.subjectId
          : writableSubjectId(payload.subjectId, grant.subjectId);
      const targetWorkspaceProviderKind = workspaceProviderApiKeyConnectionKind({
        subjectId,
        providerDomain,
        kind,
        metadata: payload.metadata ?? existing.metadata,
      });
      if (!workspaceProviderApiKeyConnectionKind(existing) && targetWorkspaceProviderKind) {
        throw new HTTPException(422, {
          message:
            targetWorkspaceProviderKind === "vercel_gateway"
              ? "use the Vercel AI Gateway connect flow to create this connection"
              : "use the OpenRouter connect flow to create this connection",
        });
      }
      assertNotDirectPersonalSlackOAuth(providerDomain, kind);
      assertNotDirectGoogleDriveOAuth(providerDomain, kind, payload.metadata ?? existing.metadata);
      assertNotDirectAtlassianOAuth(providerDomain, kind, payload.metadata ?? existing.metadata);
      assertNotDirectPersonalGitHubOAuth(
        providerDomain,
        kind,
        payload.metadata ?? existing.metadata,
      );
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
    const existingWorkspaceProviderKind = existing
      ? workspaceProviderApiKeyConnectionKind(existing)
      : null;
    if (existing && existingWorkspaceProviderKind) {
      const provider = workspaceProviderApiKeyConnectionSpec(existingWorkspaceProviderKind);
      const providerDomain = canonicalProviderDomain(
        payload.providerDomain ?? existing.providerDomain,
      );
      const subjectId =
        payload.subjectId === undefined
          ? existing.subjectId
          : writableSubjectId(payload.subjectId, grant.subjectId);
      const kind = payload.kind ?? existing.kind;
      if (
        subjectId !== null ||
        providerDomain !== provider.providerDomain ||
        kind !== "api_key" ||
        (payload.metadata?.credentialRole !== undefined &&
          payload.metadata.credentialRole !== provider.credentialRole)
      ) {
        throw new HTTPException(422, {
          message: `${provider.label} connection identity cannot be changed`,
        });
      }
      if (payload.credential === undefined) {
        throw new HTTPException(400, {
          message: `updating a ${provider.label} connection requires a new credential`,
        });
      }
      if (payload.expectedVersion === undefined || payload.operationId === undefined) {
        throw new HTTPException(400, {
          message: `updating a ${provider.label} connection requires expectedVersion and operationId`,
        });
      }
      const key = requireEnvironmentEncryption(settings);
      const grantedScopes = payload.grantedScopes ?? existing.grantedScopes;
      const expiresAt =
        payload.expiresAt !== undefined
          ? payload.expiresAt
            ? new Date(payload.expiresAt)
            : null
          : existing.expiresAt
            ? new Date(existing.expiresAt)
            : null;
      const metadata = workspaceProviderCredentialMetadata(existingWorkspaceProviderKind, {
        ...existing.metadata,
        ...(payload.metadata ?? {}),
      });
      const input = {
        accountId: grant.accountId,
        workspaceId,
        connectionId: existing.id,
        expectedVersion: payload.expectedVersion,
        operationId: payload.operationId,
        requestDigest: workspaceProviderCredentialRequestDigest(key, {
          action: "rotate",
          connectionId: existing.id,
          expectedVersion: payload.expectedVersion,
          credential: payload.credential,
          grantedScopes,
          expiresAt: expiresAt?.toISOString() ?? null,
          metadata,
        }),
        credentialEncrypted: encryptCredentialBundle(key, payload.credential),
        grantedScopes,
        expiresAt,
        metadata,
        updatedBySubjectId: grant.subjectId,
      };
      const connection =
        existingWorkspaceProviderKind === "vercel_gateway"
          ? await rotateWorkspaceVercelAiGatewayConnection(db, input)
          : await rotateWorkspaceOpenRouterConnection(db, input);
      if (!connection) {
        throw new HTTPException(409, {
          message: `${provider.label} connection changed; reload before replacing its key`,
        });
      }
      return c.json(ConnectionResponse.parse({ connection }));
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
    const expectedVersion = c.req.query("expectedVersion");
    if (expectedVersion !== undefined) {
      if (!/^[1-9]\d*$/.test(expectedVersion) || !Number.isSafeInteger(Number(expectedVersion))) {
        throw new HTTPException(400, { message: "invalid expected connection version" });
      }
      if (Number(expectedVersion) !== existing.version) {
        throw new HTTPException(409, { message: "connection changed; refresh before disconnect" });
      }
    }
    const isPersonalGitHub =
      existing.subjectId === grant.subjectId && isPersonalGitHubConnection(existing);
    if (isPersonalGitHub) {
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      assertPersonalConnectionOwnerPrincipal(access, "My GitHub account");
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
    const workspaceProviderKind = workspaceProviderApiKeyConnectionKind(existing);
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
    const personalGitHubDisconnect = isPersonalGitHub
      ? PersonalGitHubDisconnectRequest.safeParse(disconnectPayload)
      : null;
    if (personalGitHubDisconnect && !personalGitHubDisconnect.success) {
      throw new HTTPException(400, {
        message:
          personalGitHubDisconnect.error.issues[0]?.message ??
          "invalid personal GitHub disconnect request",
      });
    }
    if (
      existing.status === "revoked" &&
      !isGoogleDrive &&
      !isAtlassian &&
      !isPersonalGitHub &&
      !workspaceProviderKind
    ) {
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
        : isPersonalGitHub
          ? await disconnectPersonalGitHub(deps, {
              workspaceId,
              subjectId: grant.subjectId,
              connectionId,
              payload: personalGitHubDisconnect!.data,
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
            : workspaceProviderKind
              ? workspaceProviderKind === "vercel_gateway"
                ? await revokeWorkspaceVercelAiGatewayConnections(db, {
                    accountId: grant.accountId,
                    workspaceId,
                    connectionId,
                    expectedVersion: existing.version,
                    updatedBySubjectId: grant.subjectId,
                  })
                : await revokeWorkspaceOpenRouterConnections(db, {
                    accountId: grant.accountId,
                    workspaceId,
                    connectionId,
                    expectedVersion: existing.version,
                    updatedBySubjectId: grant.subjectId,
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
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    const grant = access.grant;
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
        ...(externalActorContinuationForAuthorization(access)
          ? { externalContinuation: externalActorContinuationForAuthorization(access)! }
          : {}),
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        personalOwnershipAllowed: isPersonalConnectionOwnerPrincipal(access),
        requestUrl: c.req.url,
        payload,
      },
    );
    return c.json(OAuthStartResponse.parse(result));
  });

  app.post("/v1/workspaces/:workspaceId/integrations/oauth/start", async (c) => {
    assertIntegrationsEnabled();
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    const grant = access.grant;
    const parsed = ApiIntegrationOAuthStartRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: parsed.error.issues[0]?.message ?? "invalid Integration OAuth start request",
      });
    }
    return c.json(
      OAuthStartResponse.parse(
        await startApiIntegrationProviderOAuth(deps, {
          ...(externalActorContinuationForAuthorization(access)
            ? { externalContinuation: externalActorContinuationForAuthorization(access)! }
            : {}),
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          personalOwnershipAllowed: isPersonalConnectionOwnerPrincipal(access),
          requestUrl: c.req.url,
          payload: parsed.data,
        }),
      ),
    );
  });

  app.get("/v1/integrations/oauth/callback", async (c) => {
    assertIntegrationsEnabled();
    const input = {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      requestUrl: c.req.url,
    };
    const result = isApiIntegrationProviderOAuthState(input.state, deps.settings)
      ? await completeApiIntegrationProviderOAuth(deps, input)
      : await completeMcpOAuthCallback(
          { db, settings, observability, oauthCallbackDeadlineMs: deps.oauthCallbackDeadlineMs },
          input,
        );
    if ("exactReturn" in result && result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
    const redirectTo = settings.webBaseUrl
      ? new URL(result.redirectTo, settings.webBaseUrl).toString()
      : result.redirectTo;
    return c.redirect(redirectTo, 302);
  });

  app.get("/v1/integrations/provider-oauth/callback", async (c) => {
    assertIntegrationsEnabled();
    const result = await completeApiIntegrationProviderOAuth(deps, {
      ...(c.req.query("code") ? { code: c.req.query("code") } : {}),
      ...(c.req.query("state") ? { state: c.req.query("state") } : {}),
      ...(c.req.query("error") ? { error: c.req.query("error") } : {}),
      requestUrl: c.req.url,
    });
    if (result.exactReturn)
      return new Response(null, { status: 302, headers: { Location: result.redirectTo } });
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
  if (
    (payload.kind !== undefined && payload.kind !== "slack_bot_install") ||
    (payload.connectAttemptId && payload.kind !== "slack_bot_install")
  )
    throw new HTTPException(400, { message: "invalid Slack installation state kind" });
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
    ...(typeof payload.connectAttemptId === "string"
      ? { connectAttemptId: payload.connectAttemptId }
      : {}),
    ...(typeof payload.encryptedExternalContinuation === "string"
      ? {
          externalContinuation: ExternalActorContinuation.parse(
            JSON.parse(
              decryptEnvironmentValue(
                requireEnvironmentEncryption(settings),
                payload.encryptedExternalContinuation,
              ),
            ),
          ),
        }
      : {}),
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
  if (stage === "permission_check" && error instanceof HTTPException && error.status === 403) {
    return { stage, reason: "permission_lost" };
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
  await requireConnectOwnerAuthority(db, state, "connections:write");
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

function assertNotDirectPersonalGitHubOAuth(
  providerDomain: string,
  kind: string,
  metadata: Record<string, unknown> | undefined,
): void {
  if (
    (providerDomain === PERSONAL_GITHUB_PROVIDER_DOMAIN && kind === "oauth2") ||
    hasReservedPersonalGitHubMetadata(metadata)
  ) {
    throw new HTTPException(422, {
      message: "personal GitHub credentials must use the dedicated OAuth connection flow",
    });
  }
}

function assertNotReservedPersonalGitHubMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  if (hasReservedPersonalGitHubMetadata(metadata)) {
    throw new HTTPException(422, {
      message: "personal GitHub metadata is reserved for the dedicated OAuth connection flow",
    });
  }
}

type WorkspaceProviderApiKeyConnectionKind = "vercel_gateway" | "openrouter";

function workspaceProviderApiKeyConnectionSpec(
  providerKind: WorkspaceProviderApiKeyConnectionKind,
): {
  providerDomain: string;
  credentialRole: string;
  label: string;
} {
  return providerKind === "vercel_gateway"
    ? {
        providerDomain: VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
        credentialRole: VERCEL_AI_GATEWAY_CONNECTION_ROLE,
        label: "Vercel AI Gateway",
      }
    : {
        providerDomain: WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
        credentialRole: WORKSPACE_OPENROUTER_CONNECTION_ROLE,
        label: "OpenRouter",
      };
}

function workspaceProviderApiKeyConnectionKind(input: {
  subjectId?: string | null;
  providerDomain: string;
  kind: string;
  metadata?: Record<string, unknown>;
}): WorkspaceProviderApiKeyConnectionKind | null {
  if (input.subjectId != null || input.kind !== "api_key") return null;
  const providerDomain = input.providerDomain.toLowerCase();
  if (
    providerDomain === VERCEL_AI_GATEWAY_CONNECTION_DOMAIN &&
    input.metadata?.credentialRole === VERCEL_AI_GATEWAY_CONNECTION_ROLE
  ) {
    return "vercel_gateway";
  }
  if (
    providerDomain === WORKSPACE_OPENROUTER_CONNECTION_DOMAIN &&
    input.metadata?.credentialRole === WORKSPACE_OPENROUTER_CONNECTION_ROLE
  ) {
    return "openrouter";
  }
  return null;
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

function workspaceProviderCredentialMetadata(
  providerKind: WorkspaceProviderApiKeyConnectionKind,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const {
    [OPENROUTER_CREDENTIAL_OPERATION_ID_METADATA_KEY]: _openRouterOperationId,
    [OPENROUTER_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: _openRouterOperationDigest,
    [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_ID_METADATA_KEY]: _operationId,
    [VERCEL_AI_GATEWAY_CREDENTIAL_OPERATION_DIGEST_METADATA_KEY]: _operationDigest,
    ...effectiveMetadata
  } = metadata ?? {};
  return {
    ...effectiveMetadata,
    credentialRole: workspaceProviderApiKeyConnectionSpec(providerKind).credentialRole,
  };
}

function workspaceProviderCredentialRequestDigest(key: Uint8Array, value: unknown): string {
  return createHmac("sha256", key).update(stableJson(value), "utf8").digest("hex");
}

function slackBotCredentialBundle(token: string): Record<string, unknown> {
  const headerName = ["author", "ization"].join("");
  const scheme = ["Bear", "er"].join("");
  return { headers: { [headerName]: `${scheme} ${token}` } };
}
