import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  AdvanceConnectRequest,
  BeginConnectRequest,
  ConnectOperationRequest,
  ConnectProvider,
  ConnectAccount,
} from "@opengeni/contracts/connect";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  InstallApiIntegrationRequest,
  stableJson,
  OPENGENI_PERSONAL_SLACK_MCP_URL,
  OPENGENI_PR_REVIEW_PACK_ID,
} from "@opengeni/contracts";
import {
  CORE_INTEGRATION_DEFINITIONS,
  createPinnedIntegrationTransport,
} from "@opengeni/capabilities";
import {
  beginConnectAttempt,
  getConnectAttempt,
  listPendingConnectAttempts,
  withWorkspaceSubjectRls,
  installApiIntegration,
  listConnectionsMetadata,
  getConnectionMetadata,
  createConnection,
  updateConnection,
  encryptEnvironmentValue,
  normalizedHostCredentialHeaders,
  listGitHubInstallationAccessForWorkspace,
  getPackInstallation,
  listPrReviewAppRegistrations,
  listSocialConnections,
  getSocialConnection,
} from "@opengeni/db";
import {
  externalActorContinuationForAuthorization,
  requireAccessGrantAuthorization,
  hasPermission,
  requireEnvironmentEncryption,
  isFikenConnection,
  isOpenGeniSlackBotConnection,
  prepareCapabilityEnable,
  buildCapabilityCatalog,
  type ApiRouteDeps,
} from "@opengeni/core";
import { isPersonalConnectionOwnerPrincipal } from "../connection-ownership";
import { requireConnectOwnerAuthority } from "../integrations/connect-authority";
import { prepareFikenTokenInstall, startFikenOAuth } from "../integrations/fiken";
import { startAtlassianOAuth } from "../integrations/atlassian";
import { startSlackBotInstall } from "../integrations/slack-install";
import { startPersonalGitHubOAuth } from "../integrations/personal-github";
import { socialOAuthClientFor, startSocialOAuth } from "../integrations/social-oauth";
import {
  githubAppConnectNavigation,
  prepareGitHubAppConnectAction,
} from "../integrations/github-app-connect";
import { githubAppMissingSettings, prReviewGitHubAppMissingSettings } from "@opengeni/github";
import { requireGitHubLensConnect } from "../integrations/github-lens-connect";
import { isPersonalGitHubConnection } from "@opengeni/contracts/personal-github";
import { startGoogleDriveOAuth } from "../integrations/google-drive";
import { GOOGLE_DRIVE_CREDENTIAL_ROLE } from "@opengeni/contracts/google-drive";
import { ATLASSIAN_CREDENTIAL_ROLE } from "@opengeni/contracts/atlassian";
import {
  curatedOAuthReadiness,
  startApiIntegrationProviderOAuth,
} from "../integrations/provider-oauth";
import { resolveForRoute, validatedIntegrationInstallInput } from "./api-integrations";
import { executeConnectOperation } from "@opengeni/core";
import { startMcpOAuth, requireIntegrationsStateSecret } from "../integrations/oauth-client";
import { z } from "zod";
import {
  WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
  VERCEL_AI_GATEWAY_CONNECTION_DOMAIN,
} from "@opengeni/config";

/** Shared durable setup entry. Provider completion is distinct from
 * subsequent preview/install; never report an OAuth token as a ready integration. */
export function registerConnectRoutes(app: Hono, deps: ApiRouteDeps): void {
  const canReadAttempt = (permissions: Parameters<typeof hasPermission>[0], providerId: string) =>
    ["x", "reddit", "mcp-install"].includes(providerId)
      ? hasPermission(permissions, "workspace:read")
      : providerId === "github-app"
        ? hasPermission(permissions, "github:use") || hasPermission(permissions, "github:manage")
        : providerId === "github-lens"
          ? hasPermission(permissions, "workspace:read")
          : hasPermission(permissions, "connections:read");
  app.get("/v1/workspaces/:workspaceId/connect/catalog", async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      c.req.param("workspaceId"),
      "workspace:read",
    );
    const external = authorization.contextIntegrity;
    const canWrite = hasPermission(authorization.grant.permissions, "connections:write");
    const personal = isPersonalConnectionOwnerPrincipal(authorization);
    const lensPack = await getPackInstallation(
      deps.db,
      authorization.grant.workspaceId,
      OPENGENI_PR_REVIEW_PACK_ID,
    );
    let mcpConfigured = false;
    let credentialConfigured = false;
    try {
      requireEnvironmentEncryption(deps.settings);
      credentialConfigured = deps.settings.integrationsEnabled;
      requireIntegrationsStateSecret(deps.settings);
      mcpConfigured = deps.settings.integrationsEnabled;
    } catch {
      /* Missing operator configuration is catalog readiness, not actor authority. */
    }
    return c.json([
      ...(["x", "reddit"] as const).map((providerId) => {
        let configured = mcpConfigured;
        try {
          socialOAuthClientFor(deps.settings, providerId);
        } catch {
          configured = false;
        }
        const ownership = [
          ...(hasPermission(authorization.grant.permissions, "workspace:admin")
            ? ["workspace" as const]
            : []),
          ...(personal ? ["personal" as const] : []),
        ];
        return ConnectProvider.parse({
          id: providerId,
          label: providerId === "x" ? "X" : "Reddit",
          family: "social",
          readiness:
            !external || !ownership.length
              ? "unsupported"
              : configured
                ? "available"
                : "needs_configuration",
          ownership,
          setup: ["oauth"],
        });
      }),
      ConnectProvider.parse({
        id: "mcp-install",
        label: "Install MCP capability",
        family: "mcp",
        readiness:
          !external || !hasPermission(authorization.grant.permissions, "capabilities:manage")
            ? "unsupported"
            : deps.settings.integrationsEnabled
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["installation"],
      }),
      ...CORE_INTEGRATION_DEFINITIONS.map((definition) => {
        const readiness = curatedOAuthReadiness(deps.settings, definition);
        return ConnectProvider.parse({
          id: definition.id,
          label: definition.name,
          family: definition.provider.id,
          readiness:
            !external || !canWrite
              ? "unsupported"
              : readiness.configured
                ? "available"
                : "needs_configuration",
          ...(!external
            ? { reason: "A verified user is required by this Connect adapter" }
            : !canWrite
              ? { reason: "connections:write permission required" }
              : !readiness.configured
                ? { reason: "Deployment OAuth or encryption configuration is incomplete" }
                : {}),
          ownership: readiness.ownership.filter((owner) => owner !== "personal" || personal),
          setup: ["oauth"],
        });
      }),
      ...(["openapi", "graphql"] as const).map((protocol) =>
        ConnectProvider.parse({
          id: protocol,
          label: protocol === "openapi" ? "OpenAPI service" : "GraphQL service",
          family: protocol,
          readiness:
            !external || !canWrite
              ? "unsupported"
              : deps.settings.integrationsEnabled
                ? "available"
                : "needs_configuration",
          ownership: personal ? ["workspace", "personal"] : ["workspace"],
          setup: [protocol, "installation"],
        }),
      ),
      ConnectProvider.parse({
        id: "atlassian",
        label: "Atlassian (Jira and Confluence)",
        family: "atlassian",
        readiness:
          !external || !canWrite || !personal
            ? "unsupported"
            : mcpConfigured &&
                deps.settings.atlassianClientId?.trim() &&
                deps.settings.atlassianClientSecret?.trim()
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["personal"] : [],
        setup: ["oauth"],
      }),
      ConnectProvider.parse({
        id: "slack-bot",
        label: "Slack workspace bot",
        family: "slack",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : mcpConfigured &&
                deps.settings.slackClientId?.trim() &&
                deps.settings.slackClientSecret?.trim() &&
                deps.settings.slackSigningSecret?.trim()
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["oauth"],
      }),
      ConnectProvider.parse({
        id: "slack-personal",
        label: "My Slack account",
        family: "slack",
        readiness:
          !external || !canWrite || !personal
            ? "unsupported"
            : mcpConfigured &&
                deps.settings.slackClientId?.trim() &&
                deps.settings.slackClientSecret?.trim()
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["personal"] : [],
        setup: ["oauth"],
      }),
      ConnectProvider.parse({
        id: "github-personal",
        label: "My GitHub account",
        family: "github",
        readiness:
          !external || !canWrite || !personal
            ? "unsupported"
            : mcpConfigured &&
                deps.settings.githubPersonalOauthEnabled &&
                deps.settings.githubPersonalOauthClientId?.trim() &&
                deps.settings.githubPersonalOauthClientSecret?.trim()
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["personal"] : [],
        setup: ["oauth"],
      }),
      ConnectProvider.parse({
        id: "github-app",
        label: "GitHub App installation",
        family: "github",
        readiness:
          !external || !hasPermission(authorization.grant.permissions, "github:manage")
            ? "unsupported"
            : githubAppMissingSettings(deps.settings).length === 0 &&
                deps.settings.githubAppSlug?.trim()
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["oauth", "installation"],
      }),
      ConnectProvider.parse({
        id: "github-lens",
        label: "OpenGeni Lens PR review",
        family: "github-lens",
        readiness:
          !external ||
          !hasPermission(authorization.grant.permissions, "workspace:admin") ||
          !hasPermission(authorization.grant.permissions, "secrets:write")
            ? "unsupported"
            : credentialConfigured &&
                lensPack?.status === "active" &&
                deps.settings.sandboxBackend !== "selfhosted" &&
                prReviewGitHubAppMissingSettings(deps.settings).length === 0
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["oauth", "installation"],
      }),
      ...(["google-drive-knowledge", "google-drive-publish"] as const).map((id) =>
        ConnectProvider.parse({
          id,
          label:
            id === "google-drive-publish"
              ? "Google Drive publishing"
              : "Google Drive knowledge sources",
          family: "google-drive",
          readiness:
            !external || !canWrite || !personal
              ? "unsupported"
              : mcpConfigured &&
                  deps.settings.googleDriveClientId?.trim() &&
                  deps.settings.googleDriveClientSecret?.trim()
                ? "available"
                : "needs_configuration",
          ownership: personal ? ["personal"] : [],
          setup: ["oauth"],
        }),
      ),
      ConnectProvider.parse({
        id: "fiken-token",
        label: "Fiken",
        family: "fiken",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : credentialConfigured
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["credentials"],
      }),
      ConnectProvider.parse({
        id: "fiken-oauth",
        label: "Fiken (OAuth)",
        family: "fiken",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : mcpConfigured &&
                deps.settings.fikenClientId?.trim() &&
                deps.settings.fikenClientSecret?.trim()
              ? "available"
              : "needs_configuration",
        ownership: ["workspace"],
        setup: ["oauth"],
      }),
      ConnectProvider.parse({
        id: "mcp-oauth",
        label: "MCP server (OAuth)",
        family: "mcp",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : mcpConfigured
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["workspace", "personal"] : ["workspace"],
        setup: ["credentials", "oauth"],
      }),
      ConnectProvider.parse({
        id: "mcp-headers",
        label: "MCP server (custom headers)",
        family: "mcp",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : credentialConfigured
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["workspace", "personal"] : ["workspace"],
        setup: ["credentials"],
      }),
      ConnectProvider.parse({
        id: "mcp-bearer",
        label: "MCP server (bearer credential)",
        family: "mcp",
        readiness:
          !external || !canWrite
            ? "unsupported"
            : credentialConfigured
              ? "available"
              : "needs_configuration",
        ownership: personal ? ["workspace", "personal"] : ["workspace"],
        setup: ["credentials"],
      }),
    ]);
  });
  app.get("/v1/workspaces/:workspaceId/connect/accounts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant } = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const connections = hasPermission(grant.permissions, "connections:read")
      ? await listConnectionsMetadata(deps.db, workspaceId, grant.subjectId)
      : [];
    const githubInstallations =
      hasPermission(grant.permissions, "github:use") ||
      hasPermission(grant.permissions, "github:manage")
        ? await listGitHubInstallationAccessForWorkspace(deps.db, workspaceId)
        : [];
    const lensRegistrations = await listPrReviewAppRegistrations(
      deps.db,
      grant.accountId,
      workspaceId,
    );
    const socialConnections = await listSocialConnections(
      deps.db,
      workspaceId,
      200,
      grant.subjectId,
    );
    return c.json([
      ...socialConnections
        .filter((connection) => ["x", "reddit"].includes(connection.provider))
        .map((connection) =>
          ConnectAccount.parse({
            id: `social:${connection.id}`,
            version: connection.version,
            providerId: connection.provider,
            label: connection.accountHandle,
            ownership: connection.ownership,
            status:
              connection.status === "connected"
                ? "connected"
                : connection.status === "disabled"
                  ? "disabled"
                  : "auth_needed",
          }),
        ),
      ...lensRegistrations
        .filter((registration) => registration.credentialKind === "managed_github_app")
        .map((registration) =>
          ConnectAccount.parse({
            id: `lens-registration:${registration.id}`,
            providerId: "github-lens",
            label: registration.providerAccountLogin ?? "Lens installation",
            ownership: "workspace",
            status: registration.status === "active" ? "connected" : "disabled",
          }),
        ),
      ...githubInstallations.map((installation) =>
        ConnectAccount.parse({
          id: `github-installation:${installation.installationId}`,
          providerId: "github-app",
          label: installation.accountLogin ?? `Installation ${installation.installationId}`,
          ownership: "workspace",
          status: "connected",
        }),
      ),
      ...connections.flatMap((connection) => {
        if (isPersonalGitHubConnection(connection))
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: "github-personal",
              label: String(connection.metadata.githubLogin ?? "GitHub"),
              ownership: "personal",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (isOpenGeniSlackBotConnection(connection))
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: "slack-bot",
              label: String(connection.metadata.slackTeamName ?? "Slack workspace bot"),
              ownership: "workspace",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (connection.metadata.credentialRole === GOOGLE_DRIVE_CREDENTIAL_ROLE)
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: "google-drive-knowledge",
              label: String(
                connection.metadata.googleEmail ??
                  connection.metadata.googleDisplayName ??
                  "Google Drive",
              ),
              ownership: "personal",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (connection.metadata.credentialRole === ATLASSIAN_CREDENTIAL_ROLE)
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: "atlassian",
              label: String(connection.metadata.displayName ?? "Atlassian"),
              ownership: "personal",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (isFikenConnection(connection))
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: connection.kind === "oauth2" ? "fiken-oauth" : "fiken-token",
              label: "Fiken",
              ownership: "workspace",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (
          connection.kind === "api_key" &&
          ["mcp-bearer", "mcp-headers"].includes(String(connection.metadata.connectAdapter))
        )
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId: connection.metadata.connectAdapter,
              label: connection.providerDomain,
              ownership: connection.subjectId === null ? "workspace" : "personal",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (
          connection.kind === "oauth2" &&
          connection.metadata.oauthDiscovery &&
          typeof connection.metadata.mcpUrl === "string"
        )
          return [
            ConnectAccount.parse({
              id: connection.id,
              version: connection.version,
              providerId:
                connection.metadata.mcpUrl === OPENGENI_PERSONAL_SLACK_MCP_URL
                  ? "slack-personal"
                  : "mcp-oauth",
              label: connection.providerDomain,
              ownership: connection.subjectId === null ? "workspace" : "personal",
              status:
                connection.status === "revoked"
                  ? "disabled"
                  : connection.status === "active"
                    ? "connected"
                    : "auth_needed",
            }),
          ];
        if (connection.metadata.credentialRole !== API_INTEGRATION_OAUTH_CREDENTIAL_ROLE) return [];
        const ids = connection.metadata.authorizedDefinitionIds;
        if (!Array.isArray(ids)) return [];
        return CORE_INTEGRATION_DEFINITIONS.filter(
          (definition) =>
            ids.includes(definition.id) &&
            definition.provider.id === connection.metadata.providerFamily,
        ).map((definition) =>
          ConnectAccount.parse({
            id: connection.id,
            version: connection.version,
            providerId: definition.id,
            label: String(
              connection.metadata.providerDisplayName ??
                connection.metadata.providerEmail ??
                connection.metadata.providerPrincipalId ??
                connection.id,
            ).slice(0, 256),
            ownership: connection.subjectId === null ? "workspace" : "personal",
            status:
              connection.status === "revoked"
                ? "disabled"
                : connection.status !== "active"
                  ? "auth_needed"
                  : "connected",
          }),
        );
      }),
    ]);
  });
  const transport = createPinnedIntegrationTransport({
    network: deps.settings,
    ...(deps.apiIntegrationSourceFetch ? { fetchImpl: deps.apiIntegrationSourceFetch } : {}),
  });
  app.post("/v1/workspaces/:workspaceId/connect/attempts/:attemptId/advance", async (c) => {
    const input = AdvanceConnectRequest.parse(await c.req.json());
    const action = input.action;
    const workspaceId = c.req.param("workspaceId");
    const permission =
      action.type === "install"
        ? "capabilities:manage"
        : action.type === "credentials"
          ? "connections:write"
          : "workspace:read";
    // Resolve the authenticated workspace actor first, then enforce the exact
    // stored provider/action permission below. Setup managers need not also
    // carry the unrelated workspace metadata read permission.
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const continuation = externalActorContinuationForAuthorization(authorization);
    if (!authorization.contextIntegrity)
      throw new HTTPException(403, { message: "Verified Connect authority required" });
    const scope = {
      accountId: authorization.grant.accountId,
      workspaceId,
      subjectId: authorization.grant.subjectId,
      personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
      ...(continuation ? { externalContinuation: continuation } : {}),
    };
    // Reject invalid caller selections before taking a durable operation claim.
    // Older revisions still go through the receipt-aware claim path for replay.
    const stored = await getConnectAttempt(deps.db, scope, c.req.param("attemptId"));
    const before = stored.attempt;
    const advancePermission =
      before.providerId === "mcp-install" ? "capabilities:manage" : permission;
    if (!hasPermission(authorization.grant.permissions, advancePermission))
      throw new HTTPException(403, { message: `${advancePermission} required` });
    if (before.providerId === "mcp-install") {
      if (action.type !== "credentials")
        throw new HTTPException(422, { message: "Choose an MCP capability" });
      const values = z
        .object({ capabilityId: z.string().min(1).max(512) })
        .strict()
        .parse(action.values);
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, scope, "capabilities:manage", origin),
          execute: async (attempt) => {
            if (attempt.state !== "credential_input")
              throw new HTTPException(409, { message: "Reload MCP setup" });
            const prepared = await prepareCapabilityEnable({
              db: deps.db,
              settings: deps.settings,
              grant: authorization.grant,
              accountId: scope.accountId,
              workspaceId,
              capabilityId: values.capabilityId,
              payload: { config: {}, metadata: {}, headers: {} },
            });
            return {
              commit: async (tx, current) => {
                await prepared.commit(tx);
                return {
                  ...current,
                  revision: current.revision + 1,
                  state: "complete",
                  completionRequirement: "provider_setup",
                  integrationInstalled: true,
                  nextAction: { type: "none" },
                };
              },
            };
          },
        }),
      );
    }
    if (["github-app", "github-lens"].includes(before.providerId)) {
      const installationPermission =
        before.providerId === "github-lens" ? "workspace:admin" : "github:manage";
      if (
        !hasPermission(authorization.grant.permissions, installationPermission) ||
        (before.providerId === "github-lens" &&
          !hasPermission(authorization.grant.permissions, "secrets:write"))
      )
        throw new HTTPException(403, { message: "Installation management permission required" });
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
          authorize: async (tx, _attempt, origin) => {
            await requireConnectOwnerAuthority(tx, scope, installationPermission, origin);
            if (before.providerId === "github-lens") {
              await requireConnectOwnerAuthority(tx, scope, "secrets:write", origin);
              await requireGitHubLensConnect({ ...deps, db: tx }, workspaceId);
            }
          },
          execute: async (attempt) =>
            prepareGitHubAppConnectAction(deps, scope, c.req.url, attempt, action),
        }),
      );
    }
    if (["openapi", "graphql"].includes(before.providerId) && action.type === "credentials") {
      const values = z
        .object({
          url: z.string().url().max(2048),
          connectionId: z.string().uuid().or(z.literal("")).optional(),
        })
        .strict()
        .parse(action.values);
      const source =
        before.providerId === "openapi"
          ? { kind: "openapi" as const, url: values.url }
          : { kind: "graphql" as const, endpoint: values.url };
      const connectionId = values.connectionId || undefined;
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, scope, "connections:write", origin),
          execute: async (attempt) => {
            if (attempt.state !== "credential_input")
              throw new HTTPException(409, { message: "Reload setup before changing the source" });
            const resolved = await resolveForRoute({
              deps,
              transport,
              workspaceId,
              subjectId: scope.subjectId,
              payload: {
                source,
                ownership: attempt.ownership,
                ...(connectionId ? { connectionId } : {}),
              },
            });
            const account = connectionId
              ? await getConnectionMetadata(deps.db, workspaceId, connectionId, scope.subjectId)
              : null;
            if (
              connectionId &&
              (!account ||
                (account.subjectId === null ? "workspace" : "personal") !== attempt.ownership)
            )
              throw new HTTPException(404, {
                message: "Connection unavailable for the requested ownership",
              });
            if (!account && attempt.ownership === "personal")
              throw new HTTPException(422, {
                message: "Personal installation requires a personal connection",
              });
            if (!account && resolved.preview.auth.kind !== "none")
              throw new HTTPException(422, {
                message: "Select a connection for this authenticated service",
              });
            return {
              commit: async (_tx, current) => ({
                ...current,
                source,
                revision: current.revision + 1,
                state: "preview",
                credentialsCommitted: !!account,
                ...(account
                  ? {
                      account: {
                        id: account.id,
                        version: account.version,
                        providerId: attempt.providerId,
                        label: account.providerDomain,
                        ownership: attempt.ownership,
                        status: "connected" as const,
                      },
                    }
                  : {}),
                nextAction: {
                  type: "preview",
                  previewId: resolved.preview.revisionId,
                  contentHash: resolved.preview.contentSha256,
                  operations: resolved.preview.tools.map((tool) => ({
                    id: tool.id,
                    label: tool.name,
                    kind: tool.safety,
                  })),
                },
              }),
            };
          },
        }),
      );
    }
    if (before.providerId === "fiken-token") {
      if (action.type !== "credentials" || before.ownership !== "workspace")
        throw new HTTPException(422, { message: "Fiken requires workspace-owned token setup" });
      const values = z
        .object({
          apiToken: z.string().min(1).max(16_384),
          defaultCompanySlug: z.string().max(128).optional(),
        })
        .strict()
        .parse(action.values);
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHmac("sha256", requireEnvironmentEncryption(deps.settings))
            .update(stableJson(input))
            .digest("hex"),
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, scope, "connections:write", origin),
          execute: async (attempt) => {
            if (attempt.state !== "credential_input")
              throw new HTTPException(409, { message: "Reload Fiken setup" });
            const persist = await prepareFikenTokenInstall(
              deps,
              scope,
              {
                apiToken: values.apiToken,
                ...(values.defaultCompanySlug
                  ? { defaultCompanySlug: values.defaultCompanySlug }
                  : {}),
                ...(attempt.account ? { connectionId: attempt.account.id } : {}),
              },
              attempt.account?.version,
            );
            return {
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
                    providerId: "fiken-token",
                    label: "Fiken",
                    ownership: "workspace",
                    status: "connected",
                  },
                };
              },
            };
          },
        }),
      );
    }
    if (["mcp-bearer", "mcp-headers"].includes(before.providerId)) {
      if (action.type !== "credentials")
        throw new HTTPException(422, { message: "MCP credentials required" });
      const values =
        before.providerId === "mcp-headers"
          ? z
              .object({
                mcpUrl: z.string().url().max(4096),
                headers: z.string().min(2).max(65_536),
              })
              .strict()
              .parse(action.values)
          : z
              .object({
                mcpUrl: z.string().url().max(4096),
                token: z
                  .string()
                  .min(1)
                  .max(16_384)
                  .regex(/^[^\u0000-\u0020\u007f]+$/),
              })
              .strict()
              .parse(action.values);
      let credentialHeaders: Record<string, string>;
      try {
        credentialHeaders =
          "headers" in values
            ? normalizedHostCredentialHeaders(
                z.record(z.string(), z.string()).parse(JSON.parse(values.headers)),
              )
            : { authorization: `Bearer ${values.token}` };
      } catch {
        throw new HTTPException(422, {
          message: "Supply a JSON object of valid credential headers",
        });
      }
      const destination = new URL(values.mcpUrl);
      if (
        [WORKSPACE_OPENROUTER_CONNECTION_DOMAIN, VERCEL_AI_GATEWAY_CONNECTION_DOMAIN].some(
          (domain) => domain === destination.hostname,
        )
      )
        throw new HTTPException(422, {
          message: "Use the dedicated workspace provider credential flow",
        });
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password ||
        destination.hash
      )
        throw new HTTPException(422, {
          message: "MCP credential destination requires HTTPS without userinfo or fragment",
        });
      const encryptionKey = requireEnvironmentEncryption(deps.settings);
      const mcpUrl = destination.toString();
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHmac("sha256", encryptionKey).update(stableJson(input)).digest("hex"),
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, scope, "connections:write", origin),
          execute: async (attempt) => {
            if (attempt.state !== "credential_input")
              throw new HTTPException(409, { message: "Reload the current credential setup" });
            const credentialEncrypted = encryptEnvironmentValue(
              encryptionKey,
              JSON.stringify({ headers: credentialHeaders }),
            );
            return {
              commit: async (tx, current) => {
                const existing = current.account
                  ? await getConnectionMetadata(
                      tx,
                      workspaceId,
                      current.account.id,
                      scope.subjectId,
                    )
                  : null;
                if (
                  current.account &&
                  (!existing ||
                    existing.metadata.connectAdapter !== current.providerId ||
                    existing.metadata.mcpUrl !== mcpUrl ||
                    existing.version !== current.account.version ||
                    (existing.subjectId === null ? "workspace" : "personal") !== current.ownership)
                )
                  throw new HTTPException(409, {
                    message: "MCP account changed; reload before replacing credentials",
                  });
                const metadata = { connectAdapter: current.providerId, mcpUrl, resource: mcpUrl };
                const subjectId = current.ownership === "personal" ? scope.subjectId : null;
                const connection = existing
                  ? await updateConnection(tx, {
                      workspaceId,
                      connectionId: existing.id,
                      expectedVersion: existing.version,
                      visibleToSubjectId: scope.subjectId,
                      subjectId,
                      providerDomain: destination.hostname,
                      kind: "api_key",
                      status: "active",
                      credentialEncrypted,
                      grantedScopes: [],
                      expiresAt: null,
                      metadata,
                      updatedBySubjectId: scope.subjectId,
                    })
                  : await createConnection(tx, {
                      accountId: scope.accountId,
                      workspaceId,
                      subjectId,
                      providerDomain: destination.hostname,
                      kind: "api_key",
                      credentialEncrypted,
                      grantedScopes: [],
                      expiresAt: null,
                      metadata,
                      createdBySubjectId: scope.subjectId,
                    });
                if (!connection) throw new HTTPException(409, { message: "MCP account changed" });
                return {
                  ...current,
                  revision: current.revision + 1,
                  state: "complete",
                  credentialsCommitted: true,
                  nextAction: { type: "none" },
                  account: {
                    id: connection.id,
                    version: connection.version,
                    providerId: current.providerId,
                    label: connection.providerDomain,
                    ownership: current.ownership,
                    status: "connected",
                  },
                };
              },
            };
          },
        }),
      );
    }
    if (["mcp-oauth", "slack-personal"].includes(before.providerId)) {
      if (action.type !== "credentials")
        throw new HTTPException(422, { message: "MCP OAuth requires a server URL" });
      const values =
        before.providerId === "slack-personal"
          ? { mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL }
          : z
              .object({ mcpUrl: z.string().url().max(4096) })
              .strict()
              .parse(action.values);
      return c.json(
        await executeConnectOperation({
          db: deps.db,
          scope,
          attemptId: before.id,
          expectedRevision: input.expectedRevision,
          operationId: input.idempotencyKey,
          inputDigest: createHmac("sha256", requireIntegrationsStateSecret(deps.settings))
            .update(stableJson(input))
            .digest("hex"),
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, scope, "connections:write", origin),
          execute: async (attempt) => {
            if (attempt.state !== "credential_input")
              throw new HTTPException(409, { message: "Reload the current connection setup" });
            const started = await startMcpOAuth(deps, {
              ...scope,
              ...(continuation ? { externalContinuation: continuation } : {}),
              connectAttemptId: attempt.id,
              personalOwnershipAllowed: isPersonalConnectionOwnerPrincipal(authorization),
              requestUrl: c.req.url,
              payload: {
                requestedScopes: [],
                mcpUrl: values.mcpUrl,
                ownership: attempt.ownership,
                returnUrl: stored.returnUrl,
                ...(attempt.account ? { connectionId: attempt.account.id } : {}),
              },
            });
            const authorizationUrl = started.authorizationUrl;
            if (!authorizationUrl)
              throw new HTTPException(502, {
                message: "provider did not return an authorization URL",
              });
            return {
              commit: async (_tx, current) => ({
                ...current,
                revision: current.revision + 1,
                state: "requires_user_action",
                nextAction: { type: "authorize", url: authorizationUrl },
              }),
            };
          },
        }),
      );
    }
    if (action.type !== "retry" && action.type !== "install")
      throw new HTTPException(422, {
        message: "this provider action is not supported by curated OAuth",
      });
    if (before.revision === input.expectedRevision) {
      if (
        (!before.source && (!before.credentialsCommitted || !before.account)) ||
        !["connected_but_incomplete", "preview"].includes(before.state)
      )
        throw new HTTPException(409, { message: "connection is not ready for preview or install" });
      if (action.type === "install") {
        const preview = before.nextAction;
        if (
          preview.type !== "preview" ||
          preview.previewId !== action.previewId ||
          preview.contentHash !== action.contentHash ||
          action.operationIds.some(
            (id) => !preview.operations.some((operation) => operation.id === id),
          )
        )
          throw new HTTPException(409, {
            message: "review the current preview before installation",
          });
      }
    }
    return c.json(
      await executeConnectOperation({
        db: deps.db,
        scope,
        attemptId: c.req.param("attemptId"),
        expectedRevision: input.expectedRevision,
        operationId: input.idempotencyKey,
        inputDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
        authorize: (tx, _attempt, origin) =>
          requireConnectOwnerAuthority(tx, scope, permission, origin),
        execute: async (attempt) => {
          if (
            (!attempt.source && (!attempt.credentialsCommitted || !attempt.account)) ||
            !["connected_but_incomplete", "preview"].includes(attempt.state)
          )
            throw new HTTPException(409, {
              message: "connection is not ready for preview or install",
            });
          if (
            action.type === "install" &&
            (attempt.nextAction.type !== "preview" ||
              attempt.nextAction.previewId !== action.previewId ||
              attempt.nextAction.contentHash !== action.contentHash)
          )
            throw new HTTPException(409, {
              message: "review the current preview before installation",
            });
          const previewRequest = {
            source: attempt.source ?? {
              kind: "definition" as const,
              definitionId: attempt.providerId,
            },
            ...(attempt.account ? { connectionId: attempt.account.id } : {}),
            ownership: attempt.ownership,
          };
          const resolved = await resolveForRoute({
            deps,
            transport,
            workspaceId,
            subjectId: scope.subjectId,
            payload: previewRequest,
          });
          const preparedPreview = (changed = false) => ({
            commit: async () => ({
              ...attempt,
              error: changed
                ? {
                    code: "source_changed",
                    message: "The source changed; review the new operations before installing.",
                    retryable: true,
                  }
                : undefined,
              revision: attempt.revision + 1,
              state: "preview" as const,
              nextAction: {
                type: "preview" as const,
                previewId: resolved.preview.revisionId,
                contentHash: resolved.preview.contentSha256,
                operations: resolved.preview.tools.map((tool) => ({
                  id: tool.id,
                  label: tool.name,
                  kind: tool.safety,
                })),
              },
            }),
          });
          if (action.type === "retry") return preparedPreview();
          // Always pass the explicit selection; omission must never select all tools.
          const payload = InstallApiIntegrationRequest.parse({
            ...previewRequest,
            expectedRevisionId: action.previewId,
            expectedContentSha256: action.contentHash,
            allowedTools: action.operationIds,
            ...attempt.installationTarget,
          });
          let installation: ReturnType<typeof validatedIntegrationInstallInput>;
          try {
            installation = validatedIntegrationInstallInput(
              authorization.grant,
              workspaceId,
              payload,
              resolved,
            );
          } catch (error) {
            // The shared validator's 409 means the reviewed source changed.
            // No installation write has run; persist a fresh, unselected preview.
            if (error instanceof HTTPException && error.status === 409)
              return preparedPreview(true);
            throw error;
          }
          return {
            commit: async (tx) => {
              await installApiIntegration(tx, installation);
              return {
                ...attempt,
                error: undefined,
                revision: attempt.revision + 1,
                state: "complete" as const,
                integrationInstalled: true,
                nextAction: { type: "none" as const },
              };
            },
          };
        },
      }),
    );
  });
  app.post("/v1/workspaces/:workspaceId/connect/attempts/:attemptId/cancel", async (c) => {
    const input = ConnectOperationRequest.parse(await c.req.json());
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const continuation = externalActorContinuationForAuthorization(authorization);
    if (!authorization.contextIntegrity)
      throw new HTTPException(403, { message: "Verified Connect authority required" });
    const scope = {
      accountId: authorization.grant.accountId,
      workspaceId,
      subjectId: authorization.grant.subjectId,
      personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
      ...(continuation ? { externalContinuation: continuation } : {}),
    };
    return c.json(
      await executeConnectOperation({
        db: deps.db,
        scope,
        attemptId: c.req.param("attemptId"),
        expectedRevision: input.expectedRevision,
        operationId: input.idempotencyKey,
        inputDigest: createHash("sha256")
          .update(stableJson({ ...input, action: "cancel" }))
          .digest("hex"),
        authorize: async (tx, attempt, origin) => {
          const permission =
            attempt.providerId === "mcp-install"
              ? "capabilities:manage"
              : ["x", "reddit"].includes(attempt.providerId)
                ? attempt.ownership === "workspace"
                  ? "workspace:admin"
                  : "workspace:read"
                : attempt.providerId === "github-app"
                  ? "github:manage"
                  : attempt.providerId === "github-lens"
                    ? "workspace:admin"
                    : "connections:write";
          if (
            !hasPermission(authorization.grant.permissions, permission) ||
            (attempt.providerId === "github-lens" &&
              !hasPermission(authorization.grant.permissions, "secrets:write"))
          )
            throw new HTTPException(403, { message: "Connect management permission required" });
          await requireConnectOwnerAuthority(tx, scope, permission, origin);
          if (attempt.providerId === "github-lens")
            await requireConnectOwnerAuthority(tx, scope, "secrets:write", origin);
        },
        execute: async () => ({
          commit: async (_tx, current) => ({
            ...current,
            revision: current.revision + 1,
            state: "cancelled",
            nextAction: { type: "none" },
          }),
        }),
      }),
    );
  });
  app.post("/v1/workspaces/:workspaceId/connect/attempts", async (c) => {
    if (!deps.settings.integrationsEnabled)
      throw new HTTPException(403, { message: "integrations disabled" });
    const workspaceId = c.req.param("workspaceId");
    const input = BeginConnectRequest.parse(await c.req.json());
    const setupPermission =
      input.providerId === "mcp-install"
        ? "capabilities:manage"
        : ["x", "reddit"].includes(input.providerId)
          ? input.ownership === "workspace"
            ? "workspace:admin"
            : "workspace:read"
          : input.providerId === "github-app"
            ? "github:manage"
            : input.providerId === "github-lens"
              ? "workspace:admin"
              : "connections:write";
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      setupPermission,
    );
    const continuation = externalActorContinuationForAuthorization(authorization);
    if (!authorization.contextIntegrity)
      throw new HTTPException(403, {
        message: "Verified Connect authority required",
      });
    let target: URL;
    try {
      target = new URL(input.returnUrl);
    } catch {
      throw new HTTPException(400, { message: "invalid return URL" });
    }
    if (
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      /[\u0000-\u0020\u007f]/.test(input.returnUrl)
    )
      throw new HTTPException(400, { message: "invalid return URL" });
    const scope = {
      accountId: authorization.grant.accountId,
      workspaceId,
      subjectId: authorization.grant.subjectId,
      personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
      ...(continuation ? { externalContinuation: continuation } : {}),
    };
    return c.json(
      await withWorkspaceSubjectRls(deps.db, workspaceId, scope.subjectId, async (tx) => {
        await requireConnectOwnerAuthority(tx, scope, setupPermission);
        const id = randomUUID();
        if (input.providerId === "mcp-install") {
          if (
            input.ownership !== "workspace" ||
            input.reconnectAccountId ||
            input.installationTarget
          )
            throw new HTTPException(422, {
              message: "MCP capabilities are workspace installations, not credential accounts",
            });
          const catalog = await buildCapabilityCatalog({
            db: tx,
            workspaceId,
            settings: deps.settings,
            subjectId: scope.subjectId,
          });
          const options = catalog.items
            .filter(
              (item) =>
                item.kind === "mcp" &&
                item.surfaceType !== "codex_apps" &&
                item.runtime.available &&
                item.authKind === "none",
            )
            .map((item) => ({ value: item.id, label: item.name }));
          if (options.length > 1000)
            throw new HTTPException(422, {
              message: "MCP catalog exceeds the setup chooser limit",
            });
          return beginConnectAttempt(tx, scope, {
            ...(continuation ? { externalContinuation: continuation } : {}),
            idempotencyKey: input.idempotencyKey,
            requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
            returnUrl: input.returnUrl,
            attempt: {
              id,
              workspaceId,
              providerId: input.providerId,
              ownership: "workspace",
              revision: 1,
              state: "credential_input",
              credentialsCommitted: false,
              integrationInstalled: false,
              completionRequirement: "provider_setup",
              nextAction: {
                type: "credentials",
                fields: [
                  {
                    name: "capabilityId",
                    label: "MCP capability",
                    required: true,
                    secret: false,
                    options,
                  },
                ],
              },
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            },
          });
        }
        if (input.providerId === "x" || input.providerId === "reddit") {
          if (input.installationTarget)
            throw new HTTPException(422, {
              message: "Social setup does not create an API installation",
            });
          if (input.ownership === "personal" && !scope.personalOwnerVerified)
            throw new HTTPException(403, { message: "Personal ownership unavailable" });
          const reconnectId = input.reconnectAccountId?.startsWith("social:")
            ? input.reconnectAccountId.slice("social:".length)
            : null;
          const existing =
            reconnectId && z.string().uuid().safeParse(reconnectId).success
              ? await getSocialConnection(tx, workspaceId, reconnectId, scope.subjectId)
              : null;
          if (
            input.reconnectAccountId &&
            (!existing ||
              existing.provider !== input.providerId ||
              existing.ownership !== input.ownership ||
              !existing.version ||
              !existing.externalAccountId)
          )
            throw new HTTPException(409, {
              message: "Social account changed or cannot be safely reconnected",
            });
          const started = await startSocialOAuth(
            { db: tx, settings: deps.settings, observability: deps.observability },
            {
              accountId: scope.accountId,
              workspaceId,
              subjectId: scope.subjectId,
              personalOwnershipAllowed: scope.personalOwnerVerified,
              connectAttemptId: id,
              requestUrl: c.req.url,
              payload: { provider: input.providerId, ownership: input.ownership },
            },
          );
          if (!started.authorizationUrl)
            throw new HTTPException(503, { message: "Social authorization is unavailable" });
          return beginConnectAttempt(tx, scope, {
            ...(continuation ? { externalContinuation: continuation } : {}),
            idempotencyKey: input.idempotencyKey,
            requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
            returnUrl: input.returnUrl,
            attempt: {
              id,
              workspaceId,
              providerId: input.providerId,
              ownership: input.ownership,
              revision: 1,
              state: "requires_user_action",
              credentialsCommitted: false,
              integrationInstalled: false,
              completionRequirement: "connection",
              ...(existing
                ? {
                    account: {
                      id: `social:${existing.id}`,
                      version: existing.version!,
                      providerId: input.providerId,
                      label: existing.accountHandle,
                      ownership: input.ownership,
                      status: "auth_needed" as const,
                    },
                  }
                : {}),
              nextAction: { type: "authorize", url: started.authorizationUrl },
              expiresAt: started.expiresAt,
            },
          });
        }
        if (["github-app", "github-lens"].includes(input.providerId)) {
          if (
            input.ownership !== "workspace" ||
            input.installationTarget ||
            input.reconnectAccountId
          )
            throw new HTTPException(422, {
              message:
                "GitHub App setup requires workspace ownership and explicit installation selection",
            });
          if (input.providerId === "github-lens") {
            if (!hasPermission(authorization.grant.permissions, "secrets:write"))
              throw new HTTPException(403, { message: "secrets:write required" });
            await requireConnectOwnerAuthority(tx, scope, "secrets:write");
            await requireGitHubLensConnect({ ...deps, db: tx }, workspaceId);
          }
          const navigation = githubAppConnectNavigation(
            deps,
            scope,
            id,
            c.req.url,
            "discover",
            undefined,
            input.providerId === "github-lens" ? "github-lens" : "github-app",
          );
          return beginConnectAttempt(tx, scope, {
            ...(continuation ? { externalContinuation: continuation } : {}),
            idempotencyKey: input.idempotencyKey,
            requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
            returnUrl: input.returnUrl,
            attempt: {
              id,
              workspaceId,
              providerId: input.providerId,
              ownership: "workspace",
              revision: 1,
              state: "requires_user_action",
              credentialsCommitted: false,
              integrationInstalled: false,
              completionRequirement: "provider_setup",
              nextAction: { type: "authorize", url: navigation.authorizationUrl },
              expiresAt: navigation.expiresAt,
            },
          });
        }
        if (["openapi", "graphql"].includes(input.providerId)) {
          if (input.reconnectAccountId)
            throw new HTTPException(422, { message: "Select the service connection during setup" });
          if (input.ownership === "personal" && !isPersonalConnectionOwnerPrincipal(authorization))
            throw new HTTPException(403, { message: "personal ownership unavailable" });
          const choices = hasPermission(authorization.grant.permissions, "connections:read")
            ? (await listConnectionsMetadata(tx, workspaceId, scope.subjectId))
                .filter(
                  (connection) =>
                    connection.status === "active" &&
                    (input.ownership === "workspace"
                      ? connection.subjectId === null
                      : connection.subjectId === scope.subjectId),
                )
                .map((connection) => ({
                  value: connection.id,
                  label: `${connection.providerDomain} · ${connection.id}`,
                }))
            : [];
          if (choices.length > 1000)
            throw new HTTPException(422, {
              message: "Account inventory exceeds the setup chooser limit",
            });
          return beginConnectAttempt(tx, scope, {
            ...(continuation ? { externalContinuation: continuation } : {}),
            idempotencyKey: input.idempotencyKey,
            requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
            returnUrl: input.returnUrl,
            attempt: {
              id,
              workspaceId,
              providerId: input.providerId,
              ownership: input.ownership,
              revision: 1,
              state: "credential_input",
              credentialsCommitted: false,
              integrationInstalled: false,
              completionRequirement: "integration",
              installationTarget: input.installationTarget ?? {
                instanceKey: `account-${id}`,
                displayName: input.providerId === "openapi" ? "OpenAPI service" : "GraphQL service",
              },
              nextAction: {
                type: "credentials",
                fields: [
                  {
                    name: "url",
                    label:
                      input.providerId === "openapi"
                        ? "OpenAPI document URL"
                        : "GraphQL endpoint URL",
                    required: true,
                    secret: false,
                  },
                  {
                    name: "connectionId",
                    label: "Service account (optional for public services)",
                    required: false,
                    secret: false,
                    options: choices,
                  },
                ],
              },
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          });
        }
        if (
          input.installationTarget &&
          [
            "mcp-oauth",
            "slack-personal",
            "mcp-bearer",
            "mcp-headers",
            "fiken-token",
            "fiken-oauth",
            "atlassian",
            "google-drive-knowledge",
            "google-drive-publish",
            "slack-bot",
            "github-personal",
          ].includes(input.providerId)
        )
          throw new HTTPException(422, {
            message: "MCP credential setup does not install an API integration instance",
          });
        if (
          ["mcp-oauth", "slack-personal", "mcp-bearer", "mcp-headers", "fiken-token"].includes(
            input.providerId,
          )
        ) {
          if (input.providerId === "slack-personal" && input.ownership !== "personal")
            throw new HTTPException(422, {
              message: "Hosted Slack MCP requires personal ownership",
            });
          if (input.providerId === "fiken-token" && input.ownership !== "workspace")
            throw new HTTPException(422, { message: "Fiken is workspace-owned" });
          requireEnvironmentEncryption(deps.settings);
          if (["mcp-oauth", "slack-personal"].includes(input.providerId))
            requireIntegrationsStateSecret(deps.settings);
          const existing = input.reconnectAccountId
            ? await getConnectionMetadata(
                tx,
                workspaceId,
                input.reconnectAccountId,
                scope.subjectId,
              )
            : null;
          if (
            input.reconnectAccountId &&
            (!existing ||
              (input.providerId === "fiken-token"
                ? !isFikenConnection(existing)
                : ["mcp-oauth", "slack-personal"].includes(input.providerId)
                  ? existing.kind !== "oauth2" ||
                    !existing.metadata.oauthDiscovery ||
                    (input.providerId === "slack-personal" &&
                      existing.metadata.mcpUrl !== OPENGENI_PERSONAL_SLACK_MCP_URL)
                  : existing.kind !== "api_key" ||
                    existing.metadata.connectAdapter !== input.providerId) ||
              (existing.subjectId === null ? "workspace" : "personal") !== input.ownership)
          )
            throw new HTTPException(404, { message: "MCP account not found for this ownership" });
          if (input.ownership === "personal" && !isPersonalConnectionOwnerPrincipal(authorization))
            throw new HTTPException(403, { message: "personal ownership unavailable" });
          return beginConnectAttempt(tx, scope, {
            ...(continuation ? { externalContinuation: continuation } : {}),
            idempotencyKey: input.idempotencyKey,
            requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
            returnUrl: input.returnUrl,
            attempt: {
              id,
              workspaceId,
              providerId: input.providerId,
              ownership: input.ownership,
              revision: 1,
              state: "credential_input",
              credentialsCommitted: false,
              integrationInstalled: false,
              completionRequirement: "connection",
              ...(existing
                ? {
                    account: {
                      id: existing.id,
                      version: existing.version,
                      providerId: input.providerId,
                      label: existing.providerDomain,
                      ownership: input.ownership,
                      status: "auth_needed" as const,
                    },
                  }
                : {}),
              nextAction: {
                type: "credentials",
                fields:
                  input.providerId === "slack-personal"
                    ? []
                    : input.providerId === "fiken-token"
                      ? [
                          {
                            name: "apiToken",
                            label: "Fiken API token",
                            required: true,
                            secret: true,
                          },
                          {
                            name: "defaultCompanySlug",
                            label: "Default company slug (optional)",
                            required: false,
                            secret: false,
                          },
                        ]
                      : [
                          {
                            name: "mcpUrl",
                            label: "MCP server URL",
                            required: true,
                            secret: false,
                          },
                          ...(input.providerId === "mcp-bearer"
                            ? [
                                {
                                  name: "token",
                                  label: "Bearer credential",
                                  required: true,
                                  secret: true,
                                },
                              ]
                            : input.providerId === "mcp-headers"
                              ? [
                                  {
                                    name: "headers",
                                    label: "Credential headers (JSON)",
                                    required: true,
                                    secret: true,
                                  },
                                ]
                              : []),
                        ],
              },
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            },
          });
        }
        if (
          ["fiken-oauth", "slack-bot"].includes(input.providerId) &&
          input.ownership !== "workspace"
        )
          throw new HTTPException(422, { message: "This connector is workspace-owned" });
        if (
          [
            "atlassian",
            "google-drive-knowledge",
            "google-drive-publish",
            "github-personal",
          ].includes(input.providerId) &&
          (input.ownership !== "personal" || !isPersonalConnectionOwnerPrincipal(authorization))
        )
          throw new HTTPException(422, { message: "This connector requires personal ownership" });
        const started =
          input.providerId === "github-personal"
            ? await startPersonalGitHubOAuth(
                { ...deps, db: tx },
                {
                  access: authorization,
                  workspaceId,
                  connectAttemptId: id,
                  ...(input.reconnectAccountId ? { connectionId: input.reconnectAccountId } : {}),
                },
              )
            : input.providerId === "slack-bot"
              ? await startSlackBotInstall(
                  { ...deps, db: tx },
                  {
                    ...scope,
                    requestUrl: c.req.url,
                    connectAttemptId: id,
                    ...(input.reconnectAccountId ? { connectionId: input.reconnectAccountId } : {}),
                  },
                )
              : ["google-drive-knowledge", "google-drive-publish"].includes(input.providerId)
                ? await startGoogleDriveOAuth(
                    { ...deps, db: tx },
                    {
                      ...scope,
                      requestUrl: c.req.url,
                      connectAttemptId: id,
                      payload: {
                        capability:
                          input.providerId === "google-drive-publish" ? "publish" : "source_read",
                        ...(input.reconnectAccountId
                          ? { connectionId: input.reconnectAccountId }
                          : {}),
                      },
                    },
                  )
                : input.providerId === "atlassian"
                  ? await startAtlassianOAuth(
                      { ...deps, db: tx },
                      {
                        ...scope,
                        requestUrl: c.req.url,
                        connectAttemptId: id,
                        payload: input.reconnectAccountId
                          ? { connectionId: input.reconnectAccountId }
                          : {},
                      },
                    )
                  : input.providerId === "fiken-oauth"
                    ? await startFikenOAuth(
                        { ...deps, db: tx },
                        {
                          ...scope,
                          requestUrl: c.req.url,
                          connectAttemptId: id,
                          payload: input.reconnectAccountId
                            ? { connectionId: input.reconnectAccountId }
                            : {},
                        },
                      )
                    : await startApiIntegrationProviderOAuth(
                        { ...deps, db: tx },
                        {
                          ...scope,
                          personalOwnershipAllowed:
                            isPersonalConnectionOwnerPrincipal(authorization),
                          ...(continuation ? { externalContinuation: continuation } : {}),
                          connectAttemptId: id,
                          requestUrl: c.req.url,
                          payload: {
                            definitionId: input.providerId,
                            ownership: input.ownership,
                            ...(input.reconnectAccountId
                              ? { connectionId: input.reconnectAccountId }
                              : {}),
                          },
                        },
                      );
        if (!started.authorizationUrl)
          throw new HTTPException(502, { message: "provider did not return an authorization URL" });
        const reconnect = input.reconnectAccountId
          ? await getConnectionMetadata(tx, workspaceId, input.reconnectAccountId, scope.subjectId)
          : null;
        return beginConnectAttempt(tx, scope, {
          ...(continuation ? { externalContinuation: continuation } : {}),
          idempotencyKey: input.idempotencyKey,
          requestDigest: createHash("sha256").update(stableJson(input)).digest("hex"),
          returnUrl: input.returnUrl,
          attempt: {
            id,
            workspaceId,
            providerId: input.providerId,
            ownership: input.ownership,
            revision: 1,
            state: "requires_user_action",
            credentialsCommitted: false,
            integrationInstalled: false,
            completionRequirement: [
              "github-personal",
              "slack-bot",
              "fiken-oauth",
              "atlassian",
              "google-drive-knowledge",
              "google-drive-publish",
            ].includes(input.providerId)
              ? "connection"
              : "integration",
            ...([
              "github-personal",
              "slack-bot",
              "fiken-oauth",
              "atlassian",
              "google-drive-knowledge",
              "google-drive-publish",
            ].includes(input.providerId)
              ? {}
              : {
                  installationTarget: input.installationTarget ?? {
                    instanceKey: `account-${id}`,
                    displayName: input.providerId,
                  },
                }),
            ...(reconnect
              ? {
                  account: {
                    id: reconnect.id,
                    version: reconnect.version,
                    providerId: input.providerId,
                    label: reconnect.providerDomain,
                    ownership: input.ownership,
                    status: "auth_needed" as const,
                  },
                }
              : {}),
            nextAction: { type: "authorize", url: started.authorizationUrl },
            expiresAt: started.expiresAt,
          },
        });
      }),
    );
  });
  app.get("/v1/workspaces/:workspaceId/connect/attempts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant } = await requireAccessGrantAuthorization(c, deps, workspaceId);
    return c.json(
      (
        await listPendingConnectAttempts(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
        })
      ).filter((attempt) => canReadAttempt(grant.permissions, attempt.providerId)),
    );
  });
  app.get("/v1/workspaces/:workspaceId/connect/attempts/:attemptId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { grant } = await requireAccessGrantAuthorization(c, deps, workspaceId);
    const { attempt } = await getConnectAttempt(
      deps.db,
      { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
      c.req.param("attemptId"),
    );
    if (!canReadAttempt(grant.permissions, attempt.providerId))
      throw new HTTPException(403, { message: "Connect read permission required" });
    return c.json(attempt);
  });
}
