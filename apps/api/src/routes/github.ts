import {
  GitHubActionPoliciesResponse,
  GitHubActionPolicyActorState,
  GitHubAppManifestCreate,
  OrganizationIntegrationDeniedError,
  UpdateGitHubActionPolicyRequest,
  type AccessGrant,
  type GitHubInstallationBindingCandidate,
} from "@opengeni/contracts";
import { PersonalGitHubConnectionMetadata } from "@opengeni/contracts/personal-github";
import { withOrganizationIntegrationAcquisition } from "@opengeni/db/organization-integration-policy";
import {
  ListGitHubRepositoryBranchesQuery,
  VerifyPublicGitHubRepositoryRefRequest,
} from "@opengeni/contracts/github-repository-contracts";
import { parseCanonicalGitHubRepositoryUrl } from "@opengeni/contracts/github-repository";
import {
  bindAuthorizedGitHubInstallationRepositories,
  deleteGitHubInstallationBinding,
  GitHubInstallationAuthorityCommitError,
  listGitHubInstallationAccessForWorkspace,
} from "@opengeni/db";
import {
  authorizeGitHubInstallationBinding,
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  discoverGitHubInstallationBindingCandidates,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  GitHubInstallationAuthorityError,
  GitHubPublicRepositoryVerificationError,
  githubAppMissingSettings,
  githubOAuthAuthorizeUrl,
  inspectSignedState,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  readSignedState,
  stateMaxAgeSeconds,
  verifyPublicGitHubRepositoryRef,
  type GitHubSignedStatePayload,
  verifySignedState,
} from "@opengeni/github";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  githubAppActionPolicyActor,
  hasPermission,
  listGitHubActionPolicyActors,
  personalGitHubActionPolicyActor,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  isVerifiedDelegatedHumanAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  verifiedDelegatedHumanAuthorizationForRequest,
  updateGitHubActionPolicyGroup,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  continuedGitHubBrowserGrantClaims,
  githubBrowserBaseUrl,
  githubBrowserGrantClaims,
  githubBrowserGrantFromState,
  githubSessionReturnPath,
} from "../github-browser-flow";
import {
  githubBindingStatus,
  GitHubRepositoryBranchAuthorityError,
  listWorkspaceGitHubInstallationBindings,
  listWorkspaceGitHubRepositoryBranches,
  listWorkspaceGitHubRepositories,
} from "../github-access";
import {
  assertPersonalConnectionOwnerPrincipal,
  requireLegacyOAuthActor,
} from "../connection-ownership";
import { workspaceIntegrationsPathForUntrusted } from "../integrations/oauth-client";
import { listPersonalGitHubConnections } from "../integrations/personal-github";
import {
  integrationCommitGrant,
  type IntegrationCommitGrant,
} from "../integrations/integration-commit-authority";
import {
  isConsistentGitHubBindingCandidates,
  isConsistentGitHubBindingProof,
} from "../integrations/github-installation-proof";
import {
  githubConnectFailureHtml,
  githubInstallationChooserHtml,
  githubSetupPendingHtml,
  githubSetupSuccessHtml,
  githubSuccessHtml,
  type GitHubConnectFailure,
} from "./github-browser-pages";
import {
  completeGitHubAppConnect,
  isGitHubAppConnectState,
} from "../integrations/github-app-connect";
import { parseRequestJson } from "../http/request-body";
import {
  requirePersonPresentRouteAuthorization,
  requireUserOrOrganizationRouteAuthorization,
} from "../http/human-route-authorization";

const githubStateCookie = "opengeni_github_state";
const githubBindingStateMaxAgeSeconds = 10 * 60;
const legacyInstallationChooserDisabledMessage =
  "The legacy repository-admin GitHub installation chooser is disabled; use the GitHub owner-consent connect flow";
/**
 * GitHub routes a browser navigates to (not the JSON API). A page-load link
 * opened after it expired, GitHub's Cancel button, or a non-owner all land on
 * one of these, so their failures render a readable page instead of JSON.
 */
const GITHUB_BROWSER_ROUTES = [
  "/v1/workspaces/:workspaceId/github/connect",
  "/v1/workspaces/:workspaceId/github/installations/select",
  "/v1/workspaces/:workspaceId/github/installations/:installationId/configure",
  "/v1/github/app-manifest/callback",
  "/v1/github/setup",
  "/v1/github/install/callback",
  "/v1/github/oauth/callback",
] as const;

/** An HTTP failure that already knows which browser page explains it. */
class GitHubBrowserFailure extends HTTPException {
  constructor(
    status: 400 | 403,
    message: string,
    readonly failure: GitHubConnectFailure,
  ) {
    super(status, { message });
    this.name = "GitHubBrowserFailure";
  }
}

export function registerGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;
  // Registered before the routes so it wraps them. The status code is kept, so
  // automation still sees the same outcome; only the body becomes a page. Every
  // failure is rendered, not only HTTP ones: an organization policy denial or an
  // unexpected fault must not reach the browser as the JSON error envelope.
  const browserFailurePage: MiddlewareHandler = async (c, next) => {
    let failure: unknown;
    let handledStatus: number | undefined;
    try {
      await next();
      if (!c.error) return;
      failure = c.error;
      // The app error handler has already answered this failure.
      handledStatus = c.res.status;
    } catch (error) {
      failure = error;
    }
    c.res = c.html(
      githubConnectFailureHtml(
        githubBrowserFailureKind(failure),
        githubFailureReturnUrl(deps, c),
        githubBrowserFailureDetail(failure),
      ),
      githubBrowserFailureStatus(failure, handledStatus) as ContentfulStatusCode,
    );
  };
  for (const path of GITHUB_BROWSER_ROUTES) app.use(path, browserFailurePage);

  app.get("/v1/workspaces/:workspaceId/github/app", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "github:use");
    const grant = access.grant;
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    const installations =
      missing.length === 0
        ? await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId)
        : [];
    const status = githubBindingStatus(missing.length === 0, installations);
    const setupMode = settings.productAccessMode === "managed" ? "platform" : "operator";
    const canManage =
      !externalActorContinuationForAuthorization(access) &&
      hasPermission(grant.permissions, "github:manage");
    const returnPath = githubSessionReturnPath(c.req.query("returnPath"), grant.workspaceId);
    const connectState =
      missing.length === 0 && slug && canManage
        ? createSignedState(githubStateSecret, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            intent: "installation_authority",
            ...(returnPath ? { returnPath } : {}),
            ...githubInstallationInitiatorClaims(deps, grant),
          })
        : null;
    const connectUrl = connectState
      ? `${openGeniBaseUrl(settings, c)}/v1/workspaces/${grant.workspaceId}/github/connect?state=${encodeURIComponent(connectState)}`
      : null;
    const installationViews = installations.map((installation) => ({
      ...installation,
      configureUrl: connectState
        ? `${openGeniBaseUrl(settings, c)}/v1/workspaces/${grant.workspaceId}/github/installations/${installation.installationId}/configure?state=${encodeURIComponent(connectState)}`
        : null,
    }));
    return c.json({
      configured: missing.length === 0,
      status,
      setupMode,
      appId: setupMode === "operator" ? (settings.githubAppId ?? null) : null,
      clientId: setupMode === "operator" ? (settings.githubClientId ?? null) : null,
      appSlug: setupMode === "operator" ? slug : null,
      installUrl: connectUrl,
      linkUrl: connectUrl,
      installations: installationViews,
      missing: setupMode === "operator" ? missing : [],
    });
  });

  app.get("/v1/workspaces/:workspaceId/github/action-policies", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:use");
    const [installations, personalConnections] = await Promise.all([
      listGitHubInstallationAccessForWorkspace(db, grant.workspaceId),
      listPersonalGitHubConnections(deps, {
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
      }),
    ]);
    const personalConnection = canonicalPersonalGitHubPolicyConnection(personalConnections);
    const actors = [
      ...installations.map(githubAppActionPolicyActor),
      ...(personalConnection
        ? [
            personalGitHubActionPolicyActor({
              connectionId: personalConnection.id,
              githubLogin: PersonalGitHubConnectionMetadata.parse(personalConnection.metadata)
                .githubLogin,
            }),
          ]
        : []),
    ];
    return c.json(
      GitHubActionPoliciesResponse.parse({
        enabled: settings.githubRestMcpEnabled,
        actors: await listGitHubActionPolicyActors(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          actors,
        }),
      }),
    );
  });

  app.patch("/v1/workspaces/:workspaceId/github/action-policies", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const payload = await parseRequestJson(c, UpdateGitHubActionPolicyRequest);
    const actor = payload.actor;
    if (actor.kind === "workspace_app") {
      const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
      const installations = await listGitHubInstallationAccessForWorkspace(db, grant.workspaceId);
      const installation = installations.find(
        (candidate) => candidate.installationId === actor.installationId,
      );
      if (!installation || installation.accountId !== grant.accountId) {
        throw new HTTPException(404, { message: "GitHub installation not found" });
      }
      return c.json(
        GitHubActionPolicyActorState.parse(
          await updateGitHubActionPolicyGroup(db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            actor: githubAppActionPolicyActor(installation),
            group: payload.group,
            decision: payload.decision,
          }),
        ),
      );
    }

    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write");
    assertPersonalConnectionOwnerPrincipal(access, "My GitHub action policy");
    const connections = await listPersonalGitHubConnections(deps, {
      workspaceId: access.grant.workspaceId,
      subjectId: access.grant.subjectId,
    });
    const connection = connections.find((candidate) => candidate.id === actor.connectionId);
    if (!connection) {
      throw new HTTPException(404, { message: "personal GitHub connection not found" });
    }
    return c.json(
      GitHubActionPolicyActorState.parse(
        await updateGitHubActionPolicyGroup(db, {
          accountId: access.grant.accountId,
          workspaceId: access.grant.workspaceId,
          subjectId: access.grant.subjectId,
          actor: personalGitHubActionPolicyActor({
            connectionId: connection.id,
            githubLogin: PersonalGitHubConnectionMetadata.parse(connection.metadata).githubLogin,
          }),
          group: payload.group,
          decision: payload.decision,
        }),
      ),
    );
  });

  // Start with user authorization, not GitHub's install/configure selector.
  // This lets an owner link an already-installed App without relying on
  // GitHub's Configure page to preserve or return OpenGeni state.
  app.get("/v1/workspaces/:workspaceId/github/connect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
    if (isGitHubAppConnectState(deps, state))
      return redirectNativeGitHubConnectBrowser(c, deps, state, workspaceId);
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      statePayload.intent !== "installation_authority" ||
      statePayload.workspaceId !== workspaceId ||
      typeof statePayload.accountId !== "string" ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    await requireGitHubManageGrant(c, deps, workspaceId, statePayload);
    const clientId = settings.githubClientId?.trim();
    if (!clientId || githubAppMissingSettings(settings).length > 0) {
      throw new HTTPException(409, {
        message: JSON.stringify({
          message: "GitHub App is not configured",
          missing: githubAppMissingSettings(settings),
        }),
      });
    }
    const discoveryState = createSignedState(githubStateSecret, {
      accountId: statePayload.accountId,
      workspaceId,
      intent: "installation_authority_discovery",
      ...continuedGitHubInstallationClaims(statePayload),
    });
    setGitHubStateCookie(c, deps, discoveryState);
    return c.redirect(
      githubOAuthAuthorizeUrl({
        clientId,
        state: discoveryState,
        redirectUri: `${openGeniBaseUrl(settings, c)}/v1/github/oauth/callback`,
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/github/repositories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "github:use");
    try {
      return c.json({ repositories: await listWorkspaceGitHubRepositories(deps, workspaceId) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, {
          message: JSON.stringify({ message: error.message, missing: error.missing }),
        });
      }
      throw new HTTPException(502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/v1/workspaces/:workspaceId/github/repositories/sync", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "github:use");
    try {
      return c.json({ repositories: await listWorkspaceGitHubRepositories(deps, workspaceId) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, {
          message: JSON.stringify({ message: error.message, missing: error.missing }),
        });
      }
      throw new HTTPException(502, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/v1/workspaces/:workspaceId/github/public-repositories/verify", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId);
    requirePublicGitHubRepositoryVerificationPermission(grant);
    const request = await parseRequestJson(c, VerifyPublicGitHubRepositoryRefRequest);
    let repository: ReturnType<typeof parseCanonicalGitHubRepositoryUrl>;
    try {
      repository = parseCanonicalGitHubRepositoryUrl(request.url);
    } catch (error) {
      throw new HTTPException(422, {
        message: error instanceof Error ? error.message : "GitHub repository URL is invalid.",
      });
    }
    try {
      return c.json(
        await verifyPublicGitHubRepositoryRef(
          { repository, ref: request.ref },
          deps.githubAnonymousFetch ?? fetch,
        ),
      );
    } catch (error) {
      if (error instanceof GitHubPublicRepositoryVerificationError) {
        throw new HTTPException(error.code === "provider_unavailable" ? 503 : 422, {
          message: error.message,
        });
      }
      throw new HTTPException(503, {
        message: "GitHub public repository verification is temporarily unavailable.",
      });
    }
  });

  app.get(
    "/v1/workspaces/:workspaceId/github/installations/:installationId/repositories/:repositoryId/branches",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "github:use");
      const installationId = parsePositiveInteger(c.req.param("installationId"));
      const repositoryId = parsePositiveInteger(c.req.param("repositoryId"));
      if (installationId === null || repositoryId === null) {
        throw new HTTPException(400, { message: "invalid GitHub repository identity" });
      }
      const query = ListGitHubRepositoryBranchesQuery.parse(c.req.query());
      try {
        return c.json(
          await listWorkspaceGitHubRepositoryBranches(deps, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            installationId,
            repositoryId,
            query,
          }),
        );
      } catch (error) {
        throw githubRepositoryBranchesRouteError(error);
      }
    },
  );

  app.delete("/v1/workspaces/:workspaceId/github/installations/:installationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
    const installationId = parsePositiveInteger(c.req.param("installationId"));
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation id" });
    }
    await deleteGitHubInstallationBinding(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId,
    });
    return c.body(null, 204);
  });

  app.get(
    "/v1/workspaces/:workspaceId/github/installations/:installationId/configure",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const installationId = parsePositiveInteger(c.req.param("installationId"));
      const state = c.req.query("state");
      if (installationId === null || !state) {
        throw new HTTPException(400, { message: "invalid GitHub installation configuration" });
      }
      const statePayload = readSignedState(state, githubStateSecret);
      if (
        !statePayload ||
        statePayload.intent !== "installation_authority" ||
        statePayload.workspaceId !== workspaceId ||
        typeof statePayload.accountId !== "string" ||
        !isFreshGitHubBindingState(statePayload)
      ) {
        throw new HTTPException(400, {
          message: "invalid or expired GitHub installation configuration state",
        });
      }
      const grant = await requireGitHubManageGrant(c, deps, workspaceId, statePayload);
      if (grant.accountId !== statePayload.accountId) {
        throw new HTTPException(403, {
          message: "GitHub installation state does not match this workspace",
        });
      }
      const installation = (
        await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId)
      ).find((candidate) => candidate.installationId === installationId);
      if (!installation) {
        throw new HTTPException(404, { message: "GitHub installation binding not found" });
      }
      const configureState = createSignedState(githubStateSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        expectedInstallationId: installationId,
        intent: "installation_authority_install",
        ...continuedGitHubInstallationClaims(statePayload),
      });
      setGitHubStateCookie(c, deps, configureState);
      const configureUrl = githubInstallationSettingsUrl(installation);
      configureUrl.searchParams.set("state", configureState);
      return c.redirect(configureUrl.toString());
    },
  );

  app.post("/v1/workspaces/:workspaceId/github/app-manifest", async (c) => {
    assertOperatorGitHubAppSetup(settings);
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "github:manage");
    requireLegacyOAuthActor(access);
    const grant = access.grant;
    const payload = await parseRequestJson(c, GitHubAppManifestCreate);
    const baseUrl = (settings.githubAppManifestBaseUrl ?? new URL(c.req.url).origin).replace(
      /\/+$/,
      "",
    );
    const state = createSignedState(githubStateSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    setGitHubStateCookie(c, deps, state);
    const appName = payload.appName?.trim() || "OpenGeni";
    const manifest = buildGitHubAppManifest({
      appName,
      baseUrl,
      public: payload.public,
      includeCiPermissions: payload.includeCiPermissions,
      setupUrl: `${baseUrl}/v1/github/setup`,
    });
    const organization = payload.organization?.trim();
    return c.json({
      actionUrl: organization
        ? organizationAppManifestUrl(organization, state)
        : personalAppManifestUrl(state),
      state,
      manifest,
    });
  });

  app.get("/v1/github/app-manifest/callback", async (c) => {
    assertOperatorGitHubAppSetup(settings);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code) {
      throw new HTTPException(400, { message: "missing GitHub manifest code" });
    }
    if (!state || !verifySignedState(state, githubStateSecret)) {
      throw new HTTPException(400, { message: "invalid or expired GitHub manifest state" });
    }
    try {
      const conversion = await convertGitHubAppManifest(code);
      const envLines = envLinesFromGitHubManifestConversion(conversion);
      setGitHubStateCookie(c, deps, state);
      return c.html(githubSuccessHtml(envLines));
    } catch (error) {
      const message = error instanceof GitHubAppApiError ? error.message : String(error);
      throw new HTTPException(502, { message });
    }
  });

  const handleGitHubInstallCallback = async (c: Context) => {
    if (isGitHubAppConnectState(deps, c.req.query("state"))) {
      const nativeBrowser = await requireGitHubConnectSetup(c, deps);
      const response = await completeGitHubAppConnect(deps, {
        state: c.req.query("state"),
        installationId: c.req.query("installation_id"),
        setupAction: c.req.query("setup_action"),
        error: c.req.query("error"),
        requestUrl: c.req.url,
      });
      if (nativeBrowser) {
        c.res = response;
        seedGitHubConnectBrowserState(c, deps, response);
        return c.res;
      }
      return response;
    }
    const state =
      c.req.query("state") ??
      allCookieValues(c, githubStateCookie).find((candidate) => {
        const payload = readSignedState(candidate, githubStateSecret);
        return (
          payload?.intent === "installation_authority_install" && isFreshGitHubBindingState(payload)
        );
      });
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      statePayload.intent !== "installation_authority_install" ||
      typeof statePayload.accountId !== "string" ||
      typeof statePayload.workspaceId !== "string" ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    const grant = await requireGitHubManageGrant(
      c,
      deps,
      statePayload.workspaceId,
      statePayload,
      state,
    );
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, {
        message: "GitHub installation state does not match this workspace",
      });
    }
    const setupAction = c.req.query("setup_action");
    if (setupAction === "request") {
      return c.html(githubSetupPendingHtml());
    }
    if (setupAction !== "install" && setupAction !== "update") {
      throw new HTTPException(400, { message: "unsupported GitHub setup action" });
    }
    const installationId = parsePositiveInteger(c.req.query("installation_id"));
    if (installationId === null) {
      throw new HTTPException(400, { message: "missing or invalid GitHub installation_id" });
    }
    if (
      statePayload.expectedInstallationId !== undefined &&
      statePayload.expectedInstallationId !== installationId
    ) {
      throw new HTTPException(409, {
        message: "GitHub returned a different installation than the one being configured",
      });
    }
    const clientId = settings.githubClientId?.trim();
    if (!clientId) {
      throw new HTTPException(409, {
        message: JSON.stringify({
          message: "GitHub App is not configured",
          missing: ["OPENGENI_GITHUB_CLIENT_ID"],
        }),
      });
    }
    const oauthState = createSignedState(githubStateSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId,
      intent: "installation_authority_oauth",
      ...continuedGitHubInstallationClaims(statePayload),
    });
    if (await canSeedGitHubSetupBrowserState(c, deps, grant.workspaceId))
      setGitHubStateCookie(c, deps, oauthState);
    return c.redirect(
      githubOAuthAuthorizeUrl({
        clientId,
        state: oauthState,
        redirectUri: `${openGeniBaseUrl(settings, c)}/v1/github/oauth/callback`,
      }),
    );
  };

  app.get("/v1/github/setup", handleGitHubInstallCallback);
  app.get("/v1/github/install/callback", handleGitHubInstallCallback);

  app.get("/v1/github/oauth/callback", async (c) => {
    if (isGitHubAppConnectState(deps, c.req.query("state"))) {
      const sourceState = await requireGitHubConnectConsent(c, deps);
      return completeGitHubAppConnect(deps, {
        state: sourceState,
        code: c.req.query("code"),
        error: c.req.query("error"),
        requestUrl: c.req.url,
      });
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (c.req.query("error") === "access_denied") {
      throw new GitHubBrowserFailure(400, "GitHub authorization was cancelled", "cancelled");
    }
    if (!code) {
      throw new HTTPException(400, { message: "missing GitHub OAuth code" });
    }
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub OAuth state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      typeof statePayload.accountId !== "string" ||
      typeof statePayload.workspaceId !== "string" ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    if (statePayload.intent === "installation_authority_discovery") {
      requireGitHubStateCookie(c, state);
      const grant = await requireGitHubManageGrant(
        c,
        deps,
        statePayload.workspaceId,
        statePayload,
        undefined,
        true,
      );
      if (grant.accountId !== statePayload.accountId) {
        throw new HTTPException(403, {
          message: "GitHub OAuth state does not match this workspace",
        });
      }
      await withOrganizationIntegrationAcquisition(db, grant, ["github-app"], async () => {});
      let candidates: GitHubInstallationBindingCandidate[] | null;
      try {
        candidates = deps.githubAppApi?.discoverInstallationBindingCandidates
          ? await deps.githubAppApi.discoverInstallationBindingCandidates({ code })
          : deps.githubAppApi
            ? null
            : await discoverGitHubInstallationBindingCandidates(settings, { code });
      } catch (error) {
        throw githubAuthorityHttpError(error);
      }
      if (!candidates) {
        throw new HTTPException(409, {
          message: "The configured GitHub provider cannot discover owner-authorized installations",
        });
      }
      if (!isConsistentGitHubBindingCandidates(candidates)) {
        throw new HTTPException(409, {
          message: "GitHub installation discovery proof is stale or invalid",
        });
      }
      const selectionState = createSignedState(githubStateSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        intent: "installation_authority_selection",
        allowedInstallationIds: candidates.map(({ installation }) => installation.installationId),
        ...continuedGitHubInstallationClaims(statePayload),
      });
      if (candidates.length === 0) {
        return redirectToGitHubInstallation(c, deps, selectionState);
      }
      setGitHubStateCookie(c, deps, selectionState);
      return c.html(
        githubInstallationChooserHtml(
          candidates,
          selectionState,
          grant.workspaceId,
          openGeniBaseUrl(settings, c),
        ),
      );
    }
    if (statePayload.intent !== "installation_authority_oauth") {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    const installationId = parsePositiveInteger(String(statePayload.installationId ?? ""));
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation id" });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireGitHubManageGrant(
      c,
      deps,
      statePayload.workspaceId,
      statePayload,
      undefined,
      true,
    );
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, {
        message: "GitHub OAuth state does not match this workspace",
      });
    }
    await withOrganizationIntegrationAcquisition(db, grant, ["github-app"], async () => {});
    let proof;
    try {
      proof = deps.githubAppApi?.authorizeInstallationBinding
        ? await deps.githubAppApi.authorizeInstallationBinding({ code, installationId })
        : deps.githubAppApi
          ? null
          : await authorizeGitHubInstallationBinding(settings, { code, installationId });
    } catch (error) {
      throw githubAuthorityHttpError(error);
    }
    if (!proof) {
      throw new HTTPException(409, {
        message:
          "The configured GitHub provider cannot prove personal-owner or organization-owner authority",
      });
    }
    if (!isConsistentGitHubBindingProof(proof, installationId)) {
      throw new HTTPException(409, { message: "GitHub installation proof is stale or invalid" });
    }
    const repositoryIds = [...new Set(proof.repositories.map((repository) => repository.id))];
    if (repositoryIds.length !== proof.repositories.length) {
      throw new HTTPException(409, { message: "GitHub returned duplicate repository identities" });
    }
    // The provider contract revalidates organization ownership after its final
    // repository read, so this commit-near timestamp records that live check.
    const authorityCheckedAt = new Date();
    const expiresAt = new Date((statePayload.iat + githubBindingStateMaxAgeSeconds) * 1_000);
    let bound;
    try {
      bound = await withOrganizationIntegrationAcquisition(
        db,
        grant,
        ["github-app"],
        async (tx) => {
          await grant.authorizeCommit(tx);
          return bindAuthorizedGitHubInstallationRepositories(tx, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            installationId,
            githubAccountId: proof.installation.accountId,
            accountLogin: proof.installation.accountLogin,
            accountType: proof.installation.accountType,
            linkedBySubjectId: grant.subjectId,
            githubActorId: proof.actorId,
            githubActorLogin: proof.actorLogin,
            authorityKind: proof.authorityKind,
            authorityCheckedAt,
            authorityExpiresAt: expiresAt,
            authorityNonce: statePayload.nonce,
            repositoryIds,
          });
        },
      );
    } catch (error) {
      if (error instanceof GitHubInstallationAuthorityCommitError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
    if (!bound) {
      throw new HTTPException(409, {
        message: "GitHub installation authorization was already used",
      });
    }
    deleteCookie(c, githubStateCookie, { path: "/v1" });
    return c.html(
      githubSetupSuccessHtml(
        proof.installation.accountLogin ?? `installation ${installationId}`,
        openGeniReturnUrl(
          settings,
          c,
          grant.workspaceId,
          typeof statePayload.returnPath === "string" ? statePayload.returnPath : null,
        ),
      ),
    );
  });

  // This is browser navigation, like /github/connect and the OAuth callbacks.
  // Keep it GET: a native HTML form cannot attach the API contract header that
  // protects product mutations, and no durable binding is written here.
  app.get("/v1/workspaces/:workspaceId/github/installations/select", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation selection state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      statePayload.intent !== "installation_authority_selection" ||
      typeof statePayload.accountId !== "string" ||
      statePayload.accountId.length === 0 ||
      statePayload.workspaceId !== workspaceId ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, {
        message: "invalid or expired GitHub installation selection state",
      });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireGitHubManageGrant(c, deps, workspaceId, statePayload);
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, {
        message: "GitHub installation state does not match this workspace",
      });
    }
    const selected = c.req.query("installation_id");
    if (selected === "new") {
      return redirectToGitHubInstallation(c, deps, state);
    }
    const installationId = parsePositiveInteger(selected);
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation selection" });
    }
    if (
      !Array.isArray(statePayload.allowedInstallationIds) ||
      !statePayload.allowedInstallationIds.includes(installationId)
    ) {
      throw new HTTPException(403, {
        message: "GitHub installation was not in the owner-authorized selection",
      });
    }
    return redirectToExactGitHubAuthorization(c, deps, state, installationId);
  });

  app.post("/v1/workspaces/:workspaceId/github/installations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const form = new URLSearchParams(await c.req.text());
    const state = form.get("oauth_state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub OAuth state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      typeof statePayload.accountId !== "string" ||
      statePayload.accountId.length === 0 ||
      statePayload.workspaceId !== workspaceId
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    throw new HTTPException(410, { message: legacyInstallationChooserDisabledMessage });
  });
}

function assertOperatorGitHubAppSetup(settings: ApiRouteDeps["settings"]): void {
  if (settings.productAccessMode === "managed") {
    throw new HTTPException(404, {
      message: "GitHub App creation is unavailable in platform-managed deployments",
    });
  }
}

function redirectToGitHubInstallation(
  c: Context,
  deps: ApiRouteDeps,
  sourceState: string,
): Response {
  const payload = readSignedState(sourceState, deps.githubStateSecret);
  const slug = deps.settings.githubAppSlug?.trim();
  if (
    !payload ||
    typeof payload.accountId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    !slug
  ) {
    throw new HTTPException(409, { message: "GitHub App installation is unavailable" });
  }
  const installState = createSignedState(deps.githubStateSecret, {
    accountId: payload.accountId,
    workspaceId: payload.workspaceId,
    intent: "installation_authority_install",
    ...continuedGitHubInstallationClaims(payload),
  });
  setGitHubStateCookie(c, deps, installState);
  return c.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(installState)}`,
  );
}

function githubInstallationSettingsUrl(installation: {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
}): URL {
  if (installation.accountType === "Organization" && installation.accountLogin) {
    return new URL(
      `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installation.installationId}`,
    );
  }
  return new URL(`https://github.com/settings/installations/${installation.installationId}`);
}

function canonicalPersonalGitHubPolicyConnection<
  T extends { id: string; status: string; updatedAt: string },
>(connections: T[]): T | null {
  const statusRank: Record<string, number> = {
    active: 0,
    needs_reauth: 1,
    error: 2,
    revoked: 3,
  };
  return (
    [...connections].sort((left, right) => {
      const rank = (statusRank[left.status] ?? 4) - (statusRank[right.status] ?? 4);
      if (rank !== 0) return rank;
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : right.id.localeCompare(left.id);
    })[0] ?? null
  );
}

function redirectToExactGitHubAuthorization(
  c: Context,
  deps: ApiRouteDeps,
  sourceState: string,
  installationId: number,
): Response {
  const payload = readSignedState(sourceState, deps.githubStateSecret);
  const clientId = deps.settings.githubClientId?.trim();
  if (
    !payload ||
    typeof payload.accountId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    !clientId
  ) {
    throw new HTTPException(409, { message: "GitHub user authorization is unavailable" });
  }
  const oauthState = createSignedState(deps.githubStateSecret, {
    accountId: payload.accountId,
    workspaceId: payload.workspaceId,
    installationId,
    intent: "installation_authority_oauth",
    ...continuedGitHubInstallationClaims(payload),
  });
  setGitHubStateCookie(c, deps, oauthState);
  return c.redirect(
    githubOAuthAuthorizeUrl({
      clientId,
      state: oauthState,
      redirectUri: `${openGeniBaseUrl(deps.settings, c)}/v1/github/oauth/callback`,
    }),
  );
}

function setGitHubStateCookie(c: Context, deps: ApiRouteDeps, state: string): void {
  setCookie(c, githubStateCookie, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c, deps),
    path: "/v1",
    maxAge: stateMaxAgeSeconds,
  });
}

function requireGitHubStateCookie(c: Context, state: string): void {
  if (!allCookieValues(c, githubStateCookie).includes(state)) {
    throw new HTTPException(400, {
      message: "invalid or expired GitHub installation browser state",
    });
  }
}

async function requireGitHubManageGrant(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  expectedState: GitHubSignedStatePayload,
  setupState?: string,
  personPresent = false,
): Promise<IntegrationCommitGrant> {
  try {
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "github:manage");
    if (personPresent) requirePersonPresentRouteAuthorization(access);
    else requireUserOrOrganizationRouteAuthorization(access);
    const nonBrowser =
      isVerifiedDelegatedHumanAuthorization(access) ||
      isVerifiedOrganizationServiceAuthorization(access);
    requireGitHubInstallationInitiator(expectedState, access.grant, nonBrowser);
    if (setupState && !nonBrowser && !allCookieValues(c, githubStateCookie).includes(setupState)) {
      // An agent may prepare installation; only the actual native initiator can
      // establish browser state at the non-redeeming setup return.
      if (
        !(access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) ||
        c.req.header("authorization")
      )
        requireGitHubStateCookie(c, setupState);
      requirePersonPresentRouteAuthorization(access);
      requireGitHubInstallationInitiator(expectedState, access.grant, true);
    }
    return integrationCommitGrant(access, ["github:manage"], {
      settings: deps.settings,
      authorizationHeader: c.req.header("authorization"),
    });
  } catch (error) {
    if (personPresent || !(error instanceof HTTPException) || error.status !== 401) {
      throw error;
    }
    const grant = githubBrowserGrantFromState(deps.settings, expectedState, workspaceId);
    if (grant) {
      requireGitHubInstallationInitiator(expectedState, grant);
      if (setupState) requireGitHubStateCookie(c, setupState);
      return {
        ...grant,
        authorizeCommit: async () => {
          const current = githubBrowserGrantFromState(deps.settings, expectedState, workspaceId);
          if (
            !current ||
            current.accountId !== grant.accountId ||
            current.subjectId !== grant.subjectId
          )
            throw new HTTPException(403, { message: "GitHub browser handoff expired or changed" });
        },
      };
    }
    throw error;
  }
}

function githubInstallationInitiatorClaims(deps: ApiRouteDeps, grant: AccessGrant) {
  return {
    ...githubBrowserGrantClaims(deps.settings, grant),
    initiatingSubjectId: grant.subjectId,
    initiatingExpiresAt: Math.floor(Date.now() / 1_000) + githubBindingStateMaxAgeSeconds,
  };
}

function continuedGitHubInstallationClaims(payload: GitHubSignedStatePayload) {
  return {
    ...continuedGitHubBrowserGrantClaims(payload),
    ...(typeof payload.initiatingSubjectId === "string" &&
    typeof payload.initiatingExpiresAt === "number"
      ? {
          initiatingSubjectId: payload.initiatingSubjectId,
          initiatingExpiresAt: payload.initiatingExpiresAt,
        }
      : {}),
  };
}

function requireGitHubInstallationInitiator(
  payload: GitHubSignedStatePayload,
  grant: AccessGrant,
  required = false,
): void {
  if (
    payload.accountId !== grant.accountId ||
    payload.workspaceId !== grant.workspaceId ||
    ((required || payload.initiatingSubjectId !== undefined) &&
      (payload.initiatingSubjectId !== grant.subjectId ||
        typeof payload.initiatingExpiresAt !== "number" ||
        !Number.isInteger(payload.initiatingExpiresAt) ||
        payload.initiatingExpiresAt < Math.floor(Date.now() / 1_000) ||
        payload.initiatingExpiresAt > payload.iat + githubBindingStateMaxAgeSeconds))
  ) {
    throw new HTTPException(403, { message: "GitHub installation initiator expired or changed" });
  }
}

async function requireGitHubConnectConsent(c: Context, deps: ApiRouteDeps): Promise<string> {
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw))
    throw new HTTPException(403, { message: "Finish GitHub consent in your signed-in browser" });
  const state = c.req.query("state")!;
  const payload = readSignedState(state, deps.githubStateSecret)!;
  if (payload.phase !== "discover" && payload.phase !== "bind")
    throw new HTTPException(400, { message: "invalid GitHub consent stage" });
  // External Connect continuations have their own stored origin and commit fence.
  // A signed native/service subject is not a substitute for native browser consent.
  if (
    typeof payload.subjectId === "string" &&
    payload.subjectId.startsWith("external_user:") &&
    payload.nativeBrowserSourceState === undefined &&
    !c.req.header("authorization")
  )
    return state;
  if (c.req.header("authorization"))
    throw new HTTPException(403, { message: "Finish GitHub consent in your signed-in browser" });
  requireGitHubStateCookie(c, state);
  const sourceState = requireNativeGitHubConnectBrowserSourceState(deps, state);
  const source = readSignedState(sourceState, deps.githubStateSecret)!;
  const access = await requireAccessGrantAuthorization(
    c,
    deps,
    source.workspaceId!,
    "github:manage",
  );
  requirePersonPresentRouteAuthorization(access);
  if (access.grant.accountId !== source.accountId || access.grant.subjectId !== source.subjectId)
    throw new HTTPException(403, { message: "GitHub connection initiator changed" });
  // The durable Connect stage retains its original revision/nonce fence. Only
  // browser OAuth sees the independent state; it is never a replacement stage.
  return sourceState;
}

function readNativeGitHubConnectSourceState(
  deps: ApiRouteDeps,
  state: string,
): GitHubSignedStatePayload {
  const source = readSignedState(state, deps.githubStateSecret);
  if (
    !source ||
    source.kind !== "github_app_connect" ||
    !isFreshGitHubBindingState(source) ||
    (source.phase !== "discover" && source.phase !== "bind") ||
    (source.providerId ?? "github-app") !== "github-app" ||
    typeof source.accountId !== "string" ||
    typeof source.workspaceId !== "string" ||
    typeof source.subjectId !== "string" ||
    !source.subjectId ||
    typeof source.connectAttemptId !== "string" ||
    !source.connectAttemptId ||
    typeof source.personalOwnerVerified !== "boolean" ||
    source.nativeBrowserSourceState !== undefined ||
    (source.installationId !== undefined &&
      (typeof source.installationId !== "number" ||
        !Number.isSafeInteger(source.installationId) ||
        source.installationId <= 0))
  )
    throw new HTTPException(400, { message: "invalid GitHub browser source state" });
  return source;
}

function createNativeGitHubConnectBrowserState(deps: ApiRouteDeps, state: string): string {
  const source = readNativeGitHubConnectSourceState(deps, state);
  // Deliberately copy only bounded stage claims, never the agent-known nonce/iat.
  return createSignedState(deps.githubStateSecret, {
    kind: "github_app_connect",
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    subjectId: source.subjectId,
    personalOwnerVerified: source.personalOwnerVerified,
    connectAttemptId: source.connectAttemptId,
    phase: source.phase,
    providerId: "github-app",
    ...(source.installationId !== undefined ? { installationId: source.installationId } : {}),
    nativeBrowserSourceState: state,
  });
}

function requireNativeGitHubConnectBrowserSourceState(deps: ApiRouteDeps, state: string): string {
  const browser = readSignedState(state, deps.githubStateSecret);
  if (
    !browser ||
    !isFreshGitHubBindingState(browser) ||
    typeof browser.nativeBrowserSourceState !== "string"
  )
    throw new HTTPException(400, { message: "independent GitHub browser state required" });
  const source = readNativeGitHubConnectSourceState(deps, browser.nativeBrowserSourceState);
  if (
    browser.kind !== source.kind ||
    browser.accountId !== source.accountId ||
    browser.workspaceId !== source.workspaceId ||
    browser.subjectId !== source.subjectId ||
    browser.personalOwnerVerified !== source.personalOwnerVerified ||
    browser.connectAttemptId !== source.connectAttemptId ||
    browser.phase !== source.phase ||
    browser.providerId !== (source.providerId ?? "github-app") ||
    browser.installationId !== source.installationId ||
    browser.nonce === source.nonce ||
    browser.iat < source.iat
  )
    throw new HTTPException(400, { message: "GitHub browser source state changed" });
  return browser.nativeBrowserSourceState;
}

async function redirectNativeGitHubConnectBrowser(
  c: Context,
  deps: ApiRouteDeps,
  state: string,
  workspaceId: string,
): Promise<Response> {
  const payload = readNativeGitHubConnectSourceState(deps, state);
  if (payload.workspaceId !== workspaceId)
    throw new HTTPException(400, { message: "invalid GitHub browser handoff state" });
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw) || c.req.header("authorization"))
    throw new HTTPException(403, { message: "Open GitHub consent in your signed-in browser" });
  const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "github:manage");
  requirePersonPresentRouteAuthorization(access);
  if (
    !(access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) ||
    access.grant.accountId !== payload.accountId ||
    access.grant.subjectId !== payload.subjectId
  )
    throw new HTTPException(403, { message: "GitHub browser handoff initiator changed" });
  const clientId = deps.settings.githubClientId?.trim();
  if (!clientId || githubAppMissingSettings(deps.settings).length > 0)
    throw new HTTPException(409, { message: "GitHub App is not configured" });
  // A native browser visit, not the agent's start response, owns this nonce.
  const browserState = createNativeGitHubConnectBrowserState(deps, state);
  setGitHubStateCookie(c, deps, browserState);
  return c.redirect(
    githubOAuthAuthorizeUrl({
      clientId,
      state: browserState,
      redirectUri: `${openGeniBaseUrl(deps.settings, c)}/v1/github/oauth/callback`,
    }),
  );
}

async function requireGitHubConnectSetup(c: Context, deps: ApiRouteDeps): Promise<boolean> {
  const payload = readSignedState(c.req.query("state")!, deps.githubStateSecret)!;
  if (payload.phase !== "install" || !isFreshGitHubBindingState(payload))
    throw new HTTPException(400, { message: "invalid GitHub installation stage" });
  // An anonymous provider redirect is authorized by the stored Connect origin.
  // An authenticated continuation cannot substitute a different initiator.
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (
    deps.settings.productAccessMode !== "local" &&
    !delegated &&
    !c.req.header("authorization") &&
    !c.req.header("cookie")
  )
    return false;
  if (typeof payload.workspaceId !== "string")
    throw new HTTPException(400, { message: "invalid GitHub connection workspace" });
  let access;
  try {
    access = await requireAccessGrantAuthorization(c, deps, payload.workspaceId, "github:manage");
  } catch (error) {
    if (
      !delegated &&
      !c.req.header("authorization") &&
      error instanceof HTTPException &&
      error.status === 401
    )
      return false;
    throw error;
  }
  requireUserOrOrganizationRouteAuthorization(access);
  if (access.grant.accountId !== payload.accountId || access.grant.subjectId !== payload.subjectId)
    throw new HTTPException(403, { message: "GitHub connection initiator changed" });
  const nativeBrowser =
    (access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) &&
    !c.req.header("authorization") &&
    !delegated;
  if (nativeBrowser) requirePersonPresentRouteAuthorization(access);
  return nativeBrowser;
}

async function canSeedGitHubSetupBrowserState(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<boolean> {
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw) || c.req.header("authorization"))
    return false;
  try {
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "github:manage");
    return access.canonicalManagedHumanSession || access.canonicalLocalHumanSession;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 401) return false;
    throw error;
  }
}

function seedGitHubConnectBrowserState(c: Context, deps: ApiRouteDeps, response: Response): void {
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) return;
  const url = new URL(location, c.req.url);
  if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") return;
  const state = url.searchParams.get("state");
  const next = state ? readSignedState(state, deps.githubStateSecret) : null;
  const source = readSignedState(c.req.query("state")!, deps.githubStateSecret)!;
  if (
    !next ||
    next.kind !== "github_app_connect" ||
    next.phase !== "bind" ||
    (next.providerId ?? "github-app") !== "github-app" ||
    !isFreshGitHubBindingState(next) ||
    next.accountId !== source.accountId ||
    next.workspaceId !== source.workspaceId ||
    next.subjectId !== source.subjectId ||
    next.connectAttemptId !== source.connectAttemptId
  )
    throw new HTTPException(403, { message: "GitHub browser handoff state changed" });
  const browserState = createNativeGitHubConnectBrowserState(deps, state!);
  url.searchParams.set("state", browserState);
  c.header("Location", url.toString());
  setGitHubStateCookie(c, deps, browserState);
}

function allCookieValues(c: Context, name: string): string[] {
  const prefix = `${name}=`;
  return (c.req.header("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => {
      const raw = part.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    });
}

function githubAuthorityHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) {
    return error;
  }
  if (error instanceof GitHubInstallationAuthorityError) {
    if (error.reason === "authority_denied") {
      return new GitHubBrowserFailure(403, error.message, "not_owner");
    }
    if (error.reason === "installation_missing") {
      return new HTTPException(404, { message: error.message });
    }
    return new HTTPException(409, { message: error.message });
  }
  if (error instanceof GitHubAppConfigurationError) {
    return new HTTPException(409, {
      message: JSON.stringify({ message: error.message, missing: error.missing }),
    });
  }
  if (error instanceof GitHubAppApiError) {
    return new HTTPException(502, { message: error.message });
  }
  return new HTTPException(502, { message: "GitHub authority verification failed" });
}

function githubRepositoryBranchesRouteError(error: unknown): Error {
  if (error instanceof HTTPException) {
    return error;
  }
  if (error instanceof GitHubRepositoryBranchAuthorityError) {
    return error.code === "not_authorized"
      ? new HTTPException(404, {
          message: "GitHub repository is not authorized for this workspace",
        })
      : new HTTPException(409, {
          message: "GitHub repository authorization changed; refresh and try again",
        });
  }
  if (error instanceof GitHubAppConfigurationError) {
    return new HTTPException(409, { message: "GitHub App is not configured" });
  }
  if (error instanceof GitHubAppApiError) {
    if (error.status === 429) {
      return new HTTPException(503, { message: "GitHub is temporarily rate limited" });
    }
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return new HTTPException(409, {
        message: "GitHub repository access changed; refresh and try again",
      });
    }
    return new HTTPException(502, { message: "GitHub branch discovery is unavailable" });
  }
  return new HTTPException(502, { message: "GitHub branch discovery is unavailable" });
}

export function requirePublicGitHubRepositoryVerificationPermission(
  grant: Pick<AccessGrant, "permissions">,
): void {
  if (
    hasPermission(grant.permissions, "sessions:create") ||
    hasPermission(grant.permissions, "sessions:control")
  ) {
    return;
  }
  throw new HTTPException(403, {
    message: "missing permission: sessions:create or sessions:control",
  });
}

function isSecureRequest(c: Context, deps: ApiRouteDeps): boolean {
  return (
    deps.settings.publicBaseUrl?.startsWith("https://") ||
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:"
  );
}

function parsePositiveInteger(value: string | undefined | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isFreshGitHubBindingState(payload: GitHubSignedStatePayload): boolean {
  const age = Math.floor(Date.now() / 1_000) - payload.iat;
  return age >= 0 && age < githubBindingStateMaxAgeSeconds;
}

function openGeniReturnUrl(
  settings: ApiRouteDeps["settings"],
  c: Context,
  workspaceId: string,
  returnPath: string | null = null,
): string {
  const baseUrl = openGeniBaseUrl(settings, c) || new URL(c.req.url).origin;
  const safeReturnPath = githubSessionReturnPath(returnPath, workspaceId);
  const url = safeReturnPath ? new URL(safeReturnPath, `${baseUrl}/`) : new URL(baseUrl);
  if (safeReturnPath) {
    url.searchParams.delete("capability_auth");
    url.searchParams.set("github", "connected");
    return url.toString();
  }
  url.searchParams.set("workspaceId", workspaceId);
  return url.toString();
}

function openGeniBaseUrl(settings: ApiRouteDeps["settings"], c: Context): string {
  return githubBrowserBaseUrl(settings, new URL(c.req.url).origin);
}

/** The status the app error handler gives this failure; the page keeps it. */
function githubBrowserFailureStatus(error: unknown, handledStatus: number | undefined): number {
  if (error instanceof HTTPException) return error.status;
  if (error instanceof OrganizationIntegrationDeniedError) return 403;
  // An unexpected fault keeps whatever the error handler answered (500 by default).
  return handledStatus ?? 500;
}

function githubBrowserFailureKind(error: unknown): GitHubConnectFailure {
  if (error instanceof OrganizationIntegrationDeniedError) return "policy_denied";
  if (!(error instanceof HTTPException)) return "failed";
  if (error instanceof GitHubBrowserFailure) return error.failure;
  if (error.status === 401) return "signed_out";
  if (error.status === 403) return "forbidden";
  // Every signed-state rejection names its state; they all mean "start again".
  if (error.status === 400 && /\bstate\b/iu.test(error.message)) return "expired";
  return "failed";
}

/**
 * Human-authored HTTP messages only; configuration errors carry a JSON
 * envelope. Anything else (an unexpected fault) shows no detail.
 */
function githubBrowserFailureDetail(error: unknown): string | null {
  if (!(error instanceof HTTPException)) return null;
  if (error instanceof GitHubBrowserFailure && error.failure === "cancelled") return null;
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown };
    return typeof parsed?.message === "string" ? parsed.message : null;
  } catch {
    return error.message || null;
  }
}

/**
 * The failure page links back to the workspace integrations page when the
 * request names a workspace (its path, or a correctly signed state even if it
 * aged out); otherwise to the OpenGeni home. This is only a link target, so an
 * expired state is acceptable evidence of where the user came from.
 */
function githubFailureReturnUrl(deps: ApiRouteDeps, c: Context): string {
  const baseUrl = (
    deps.settings.webBaseUrl ??
    (openGeniBaseUrl(deps.settings, c) || new URL(c.req.url).origin)
  ).replace(/\/+$/u, "");
  const rawState = c.req.query("state");
  const candidate =
    c.req.param("workspaceId") ??
    (rawState ? inspectSignedState(rawState, deps.githubStateSecret)?.workspaceId : undefined);
  return `${baseUrl}${workspaceIntegrationsPathForUntrusted(candidate) ?? "/"}`;
}
