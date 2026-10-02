import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { withOrganizationIntegrationAcquisition } from "@opengeni/db/organization-integration-policy";
import {
  AUTOMATION_WEBHOOK_MAX_BYTES,
  PrReviewManagedGitHubSetup,
  type AccessGrant,
  type GitHubInstallationBindingCandidate,
  type GitHubInstallationBindingProof,
} from "@opengeni/contracts";
import {
  automationRequestDigest,
  hasPermission,
  requireAutomationAdapter,
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  isVerifiedDelegatedHumanAuthorization,
  isVerifiedOrganizationServiceAuthorization,
  verifiedDelegatedHumanAuthorizationForRequest,
  requirePermission,
  verifyPrReviewWebhook,
  type ApiRouteDeps,
  PR_REVIEW_AUTOMATION_SETUP,
} from "@opengeni/core";
import {
  AutomationDeliveryConflictError,
  encryptVariableSetValue,
  getAutomationSourceSecret,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
  nestedPostgresSqlState,
  PrReviewDispatchAuthorityError,
  recordAuditEvent,
  resolveManagedGitHubPrReviewRoute,
  syncManagedGitHubPrReviewInstallation,
} from "@opengeni/db";
import {
  authorizeGitHubInstallationBinding,
  createSignedState,
  discoverGitHubInstallationBindingCandidates,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  GitHubInstallationAuthorityError,
  githubOAuthAuthorizeUrl,
  prReviewGitHubAppMissingSettings,
  readSignedState,
  settingsForPrReviewGitHubApp,
  stateMaxAgeSeconds,
  type GitHubSignedStatePayload,
} from "@opengeni/github";
import type { Context, Hono } from "hono";
import {
  requirePersonPresentRouteAuthorization,
  requireUserOrOrganizationRouteAuthorization,
} from "../http/human-route-authorization";
import {
  integrationCommitGrant,
  type IntegrationCommitGrant,
} from "../integrations/integration-commit-authority";
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { githubBrowserBaseUrl } from "../github-browser-flow";
import { acceptAutomationEvent, readAutomationWebhookBody } from "./automations";
import {
  completeGitHubAppConnect,
  isGitHubAppConnectState,
} from "../integrations/github-app-connect";

const stateCookie = "opengeni_pr_review_github_state";
const bindingStateMaxAgeSeconds = 10 * 60;
const appName = "OpenGeni Lens" as const;

export function registerPrReviewGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/webhooks/pr-review/github", async (c) => {
    const secret = deps.settings.prReviewGithubWebhookSecret?.trim();
    if (!secret) {
      throw new HTTPException(503, { message: "OpenGeni Lens webhook is unavailable" });
    }
    const rawBody = await readAutomationWebhookBody(c.req.raw, AUTOMATION_WEBHOOK_MAX_BYTES);
    if (
      !verifyPrReviewWebhook({
        provider: "github",
        rawBody,
        headers: c.req.raw.headers,
        secret,
        webhookUsername: null,
      })
    ) {
      throw new HTTPException(401, { message: "OpenGeni Lens signature is invalid" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new HTTPException(400, { message: "OpenGeni Lens payload is invalid JSON" });
    }
    const record = asRecord(payload);
    const installationId = positiveInteger(asRecord(record?.installation)?.id);
    const repositoryId = positiveInteger(asRecord(record?.repository)?.id);
    if (installationId === null || repositoryId === null) {
      return c.json(ignoredWebhook("unsupported_event"), 202);
    }
    const route = await resolveManagedGitHubPrReviewRoute(deps.db, {
      installationId: String(installationId),
      providerRepositoryId: String(repositoryId),
    });
    if (!route) return c.json(ignoredWebhook("repository_not_connected"), 202);
    const source = await getAutomationSourceSecret(deps.db, route);
    if (!source || source.status !== "active") {
      return c.json(ignoredWebhook("source_disabled"), 202);
    }
    const adapter = requireAutomationAdapter(source.adapterId);
    const requestDigest = automationRequestDigest(source.adapterId, rawBody);
    try {
      return c.json(
        await acceptAutomationEvent(deps, source, {
          deliveryKey: adapter.deliveryKey({
            headers: c.req.raw.headers,
            requestDigest,
          }),
          requestDigest,
          normalizedEvent: adapter.normalize({
            rawBody,
            headers: c.req.raw.headers,
            sourceConfiguration: source.configuration,
          }),
        }),
        202,
      );
    } catch (error) {
      if (error instanceof AutomationDeliveryConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/pr-review/github", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const grant = access.grant;

    const missing = prReviewGitHubAppMissingSettings(deps.settings);
    const configured = missing.length === 0;
    const registrations = (
      await listPrReviewAppRegistrations(deps.db, grant.accountId, workspaceId)
    ).filter((registration) => registration.credentialKind === "managed_github_app");
    const repositories = await listPrReviewRepositoryBindings(
      deps.db,
      grant.accountId,
      workspaceId,
    );
    const canManage =
      !externalActorContinuationForAuthorization(access) &&
      hasPermission(grant.permissions, "workspace:admin") &&
      hasPermission(grant.permissions, "secrets:write");
    const connectState =
      configured && canManage
        ? createSignedState(deps.githubStateSecret, {
            accountId: grant.accountId,
            workspaceId,
            intent: "pr_review_github_authority",
            ...prReviewBrowserGrantClaims(deps, grant),
          })
        : null;
    const baseUrl = openGeniBaseUrl(deps, c);
    const connectUrl = connectState
      ? `${baseUrl}/v1/workspaces/${workspaceId}/pr-review/github/connect?state=${encodeURIComponent(connectState)}`
      : null;
    return c.json(
      PrReviewManagedGitHubSetup.parse({
        configured,
        status: !configured
          ? "unavailable"
          : registrations.some((registration) => registration.status === "active")
            ? "connected"
            : "not_connected",
        appName,
        connectUrl,
        installations: registrations.map((registration) => {
          const installationId = registration.installationId!;
          const configureState = connectState
            ? createSignedState(deps.githubStateSecret, {
                accountId: grant.accountId,
                workspaceId,
                expectedInstallationId: Number(installationId),
                intent: "pr_review_github_install",
                ...prReviewBrowserGrantClaims(deps, grant),
              })
            : null;
          return {
            registrationId: registration.id,
            installationId,
            accountLogin: registration.providerAccountLogin,
            configureUrl: configureState
              ? `${baseUrl}/v1/workspaces/${workspaceId}/pr-review/github/installations/${installationId}/configure?state=${encodeURIComponent(configureState)}`
              : null,
            repositoryCount: repositories.filter(
              (repository) =>
                repository.registrationId === registration.id && repository.status === "active",
            ).length,
          };
        }),
        missing: deps.settings.productAccessMode === "managed" ? [] : missing,
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/pr-review/github/connect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = requireStateQuery(c, "missing OpenGeni Lens installation state");
    if (isGitHubAppConnectState(deps, state))
      return redirectNativePrReviewConnectBrowser(c, deps, state, workspaceId);
    const payload = requireFreshState(state, deps, "pr_review_github_authority", workspaceId);
    await requirePrReviewManageGrant(c, deps, workspaceId, payload);

    assertManagedCompute(deps);
    requireConfiguredApp(deps);
    const discoveryState = createSignedState(deps.githubStateSecret, {
      accountId: payload.accountId,
      workspaceId,
      intent: "pr_review_github_discovery",
      ...continuedBrowserGrantClaims(payload),
    });
    setStateCookie(c, deps, discoveryState);
    return c.redirect(
      githubOAuthAuthorizeUrl({
        clientId: deps.settings.prReviewGithubClientId!,
        state: discoveryState,
        redirectUri: `${openGeniBaseUrl(deps, c)}/v1/pr-review/github/oauth/callback`,
      }),
    );
  });

  app.get(
    "/v1/workspaces/:workspaceId/pr-review/github/installations/:installationId/configure",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const installationId = positiveInteger(c.req.param("installationId"));
      const state = requireStateQuery(c, "missing OpenGeni Lens configuration state");
      const payload = requireFreshState(state, deps, "pr_review_github_install", workspaceId);
      if (installationId === null || payload.expectedInstallationId !== installationId) {
        throw new HTTPException(400, { message: "invalid OpenGeni Lens installation" });
      }
      await requirePrReviewManageGrant(c, deps, workspaceId, payload);

      assertManagedCompute(deps);
      const registrations = await listPrReviewAppRegistrations(
        deps.db,
        payload.accountId!,
        workspaceId,
      );
      const registration = registrations.find(
        (candidate) =>
          candidate.credentialKind === "managed_github_app" &&
          candidate.installationId === String(installationId),
      );
      if (!registration) {
        throw new HTTPException(404, { message: "OpenGeni Lens installation is not connected" });
      }
      setStateCookie(c, deps, state);
      const configureUrl = githubInstallationSettingsUrl(
        installationId,
        registration.providerAccountLogin,
        registration.providerAccountType,
      );
      configureUrl.searchParams.set("state", state);
      return c.redirect(configureUrl.toString());
    },
  );

  const handleInstallCallback = async (c: Context) => {
    if (isGitHubAppConnectState(deps, c.req.query("state"))) {
      const nativeBrowser = await requirePrReviewConnectSetup(c, deps);
      const response = await completeGitHubAppConnect(deps, {
        expectedProvider: "github-lens",
        state: c.req.query("state"),
        installationId: c.req.query("installation_id"),
        setupAction: c.req.query("setup_action"),
        error: c.req.query("error"),
        requestUrl: c.req.url,
      });
      if (nativeBrowser) {
        c.res = response;
        seedPrReviewConnectBrowserState(c, deps, response);
        return c.res;
      }
      return response;
    }
    const state =
      c.req.query("state") ??
      allCookieValues(c, stateCookie).find((candidate) => {
        const payload = readSignedState(candidate, deps.githubStateSecret);
        return payload?.intent === "pr_review_github_install" && isFreshState(payload);
      });
    if (!state) throw new HTTPException(400, { message: "missing OpenGeni Lens state" });
    const payload = requireFreshState(state, deps, "pr_review_github_install");
    await requirePrReviewManageGrant(c, deps, payload.workspaceId!, payload, state);

    assertManagedCompute(deps);
    const setupAction = c.req.query("setup_action");
    if (setupAction === "request") return c.html(setupPendingHtml());
    if (setupAction !== "install" && setupAction !== "update") {
      throw new HTTPException(400, { message: "unsupported GitHub setup action" });
    }
    const installationId = positiveInteger(c.req.query("installation_id"));
    if (installationId === null) {
      throw new HTTPException(400, { message: "missing or invalid GitHub installation_id" });
    }
    if (
      payload.expectedInstallationId !== undefined &&
      payload.expectedInstallationId !== installationId
    ) {
      throw new HTTPException(409, {
        message: "GitHub returned a different OpenGeni Lens installation",
      });
    }
    requireConfiguredApp(deps);
    const oauthState = createSignedState(deps.githubStateSecret, {
      accountId: payload.accountId,
      workspaceId: payload.workspaceId,
      installationId,
      intent: "pr_review_github_oauth",
      ...continuedBrowserGrantClaims(payload),
    });
    if (await canSeedPrReviewSetupBrowserState(c, deps, payload.workspaceId!))
      setStateCookie(c, deps, oauthState);
    return c.redirect(
      githubOAuthAuthorizeUrl({
        clientId: deps.settings.prReviewGithubClientId!,
        state: oauthState,
        redirectUri: `${openGeniBaseUrl(deps, c)}/v1/pr-review/github/oauth/callback`,
      }),
    );
  };

  app.get("/v1/pr-review/github/setup", handleInstallCallback);
  app.get("/v1/pr-review/github/install/callback", handleInstallCallback);

  app.get("/v1/pr-review/github/oauth/callback", async (c) => {
    if (isGitHubAppConnectState(deps, c.req.query("state"))) {
      const sourceState = await requirePrReviewConnectConsent(c, deps);
      return completeGitHubAppConnect(deps, {
        expectedProvider: "github-lens",
        state: sourceState,
        code: c.req.query("code"),
        error: c.req.query("error"),
        requestUrl: c.req.url,
      });
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      throw new HTTPException(400, { message: "missing OpenGeni Lens OAuth code or state" });
    }
    const payload = requireFreshState(state, deps);
    requireStateCookie(c, state);
    const grant = await requirePrReviewManageGrant(
      c,
      deps,
      payload.workspaceId!,
      payload,
      undefined,
      true,
    );

    assertManagedCompute(deps);
    requireConfiguredApp(deps);

    await withOrganizationIntegrationAcquisition(deps.db, grant, ["github-lens"], async () => {});
    if (payload.intent === "pr_review_github_discovery") {
      let candidates: GitHubInstallationBindingCandidate[] | null;
      try {
        candidates = deps.prReviewGithubAppApi?.discoverInstallationBindingCandidates
          ? await deps.prReviewGithubAppApi.discoverInstallationBindingCandidates({ code })
          : deps.prReviewGithubAppApi
            ? null
            : await discoverGitHubInstallationBindingCandidates(
                settingsForPrReviewGitHubApp(deps.settings),
                { code },
              );
      } catch (error) {
        throw authorityHttpError(error);
      }
      if (!candidates || !consistentCandidates(candidates)) {
        throw new HTTPException(409, {
          message: "OpenGeni Lens could not prove owner-authorized installations",
        });
      }
      const selectionState = createSignedState(deps.githubStateSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        intent: "pr_review_github_selection",
        allowedInstallationIds: candidates.map(({ installation }) => installation.installationId),
        ...continuedBrowserGrantClaims(payload),
      });
      if (candidates.length === 0) return redirectToInstallation(c, deps, selectionState);
      if (candidates.length === 1) {
        return redirectToExactAuthorization(
          c,
          deps,
          selectionState,
          candidates[0]!.installation.installationId,
        );
      }
      setStateCookie(c, deps, selectionState);
      return c.html(
        installationChooserHtml(candidates, selectionState, grant.workspaceId, deps, c),
      );
    }

    if (payload.intent !== "pr_review_github_oauth") {
      throw new HTTPException(400, { message: "invalid or expired OpenGeni Lens OAuth state" });
    }
    const installationId = positiveInteger(payload.installationId);
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid OpenGeni Lens installation id" });
    }
    let proof: GitHubInstallationBindingProof | null;
    try {
      proof = deps.prReviewGithubAppApi?.authorizeInstallationBinding
        ? await deps.prReviewGithubAppApi.authorizeInstallationBinding({ code, installationId })
        : deps.prReviewGithubAppApi
          ? null
          : await authorizeGitHubInstallationBinding(settingsForPrReviewGitHubApp(deps.settings), {
              code,
              installationId,
            });
    } catch (error) {
      throw authorityHttpError(error);
    }
    if (!proof || !consistentProof(proof, installationId)) {
      throw new HTTPException(409, {
        message: "OpenGeni Lens installation proof is stale or invalid",
      });
    }
    const repositoryIds = new Set(proof.repositories.map((repository) => repository.id));
    if (repositoryIds.size !== proof.repositories.length) {
      throw new HTTPException(409, { message: "GitHub returned duplicate repository identities" });
    }
    const template = PR_REVIEW_AUTOMATION_SETUP;

    const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
    if (!encryptionKey) {
      throw new HTTPException(503, {
        message: "OpenGeni Lens requires configured secret encryption",
      });
    }
    let synchronized;
    try {
      synchronized = await withOrganizationIntegrationAcquisition(
        deps.db,
        grant,
        ["github-lens"],
        async (tx) => {
          await grant.authorizeCommit(tx);
          return syncManagedGitHubPrReviewInstallation(tx, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            installationId,
            providerAccountLogin: proof.installation.accountLogin,
            providerAccountType: proof.installation.accountType as "User" | "Organization",
            githubActorId: proof.actorId,
            authorityKind: proof.authorityKind,
            authorityCheckedAt: new Date(),
            authorityExpiresAt: new Date((payload.iat + bindingStateMaxAgeSeconds) * 1_000),
            authorityNonce: payload.nonce,
            appId: deps.settings.prReviewGithubAppId!,
            webhookSecretEncrypted: encryptVariableSetValue(
              encryptionKey,
              deps.settings.prReviewGithubWebhookSecret!,
            ),
            repositories: proof.repositories,
            createdBySubjectId: grant.subjectId,

            adapterId: template.adapterId,
            eventTypes: template.eventTypes,
            configuration: template.configuration,
            sessionTemplate: template.sessionTemplate,
          });
        },
      );
    } catch (error) {
      if (error instanceof PrReviewDispatchAuthorityError) {
        throw new HTTPException(409, { message: error.message });
      }
      if (nestedPostgresSqlState(error) === "23505") {
        throw new HTTPException(409, {
          message:
            "One of these repositories is already connected to OpenGeni Lens in another workspace",
        });
      }
      throw error;
    }
    await recordAuditEvent(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      action: "prReview.managed_github.connected",
      targetType: "pr_review_app_registration",
      targetId: synchronized.registration.id,
      metadata: {
        installationId,
        providerAccountLogin: proof.installation.accountLogin,
        repositoryCount: synchronized.repositories.length,
        authorityKind: proof.authorityKind,
        githubActorId: proof.actorId,
      },
    });
    deleteCookie(c, stateCookie, { path: "/v1" });
    return c.html(
      setupSuccessHtml(
        proof.installation.accountLogin ?? `installation ${installationId}`,
        `${openGeniBaseUrl(deps, c)}/workspaces/${grant.workspaceId}/capabilities`,
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/pr-review/github/installations/select", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = requireStateQuery(c, "missing OpenGeni Lens selection state");
    const payload = requireFreshState(state, deps, "pr_review_github_selection", workspaceId);
    requireStateCookie(c, state);
    await requirePrReviewManageGrant(c, deps, workspaceId, payload);

    const selected = c.req.query("installation_id");
    if (selected === "new") return redirectToInstallation(c, deps, state);
    const installationId = positiveInteger(selected);
    if (
      installationId === null ||
      !Array.isArray(payload.allowedInstallationIds) ||
      !payload.allowedInstallationIds.includes(installationId)
    ) {
      throw new HTTPException(403, {
        message: "GitHub installation was not in the owner-authorized selection",
      });
    }
    return redirectToExactAuthorization(c, deps, state, installationId);
  });
}

function requireConfiguredApp(deps: ApiRouteDeps): void {
  const missing = prReviewGitHubAppMissingSettings(deps.settings);
  if (missing.length > 0) {
    throw new HTTPException(409, {
      message: JSON.stringify({ message: "OpenGeni Lens is not configured", missing }),
    });
  }
}

function assertManagedCompute(deps: ApiRouteDeps): void {
  if (deps.settings.sandboxBackend === "selfhosted") {
    throw new HTTPException(409, { message: "OpenGeni Lens requires managed compute" });
  }
}

async function requirePrReviewManageGrant(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  state: GitHubSignedStatePayload,
  setupState?: string,
  personPresent = false,
): Promise<IntegrationCommitGrant> {
  let grant: IntegrationCommitGrant;
  try {
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:admin");
    if (personPresent) requirePersonPresentRouteAuthorization(access);
    else requireUserOrOrganizationRouteAuthorization(access);
    const nonBrowser =
      isVerifiedDelegatedHumanAuthorization(access) ||
      isVerifiedOrganizationServiceAuthorization(access);
    requirePrReviewInstallationInitiator(state, access.grant, nonBrowser);
    if (setupState && !nonBrowser && !allCookieValues(c, stateCookie).includes(setupState)) {
      if (
        !(access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) ||
        c.req.header("authorization")
      )
        requireStateCookie(c, setupState);
      requirePersonPresentRouteAuthorization(access);
      requirePrReviewInstallationInitiator(state, access.grant, true);
    }
    grant = await integrationCommitGrant(access, ["workspace:admin", "secrets:write"], {
      settings: deps.settings,
      authorizationHeader: c.req.header("authorization"),
    });
  } catch (error) {
    if (personPresent || !(error instanceof HTTPException) || error.status !== 401) throw error;
    const handedOff = prReviewBrowserGrantFromState(deps, state, workspaceId);
    if (!handedOff) throw error;
    requirePrReviewInstallationInitiator(state, handedOff);
    if (setupState) requireStateCookie(c, setupState);
    grant = {
      ...handedOff,
      authorizeCommit: async () => {
        const current = prReviewBrowserGrantFromState(deps, state, workspaceId);
        if (
          !current ||
          current.accountId !== handedOff.accountId ||
          current.subjectId !== handedOff.subjectId
        )
          throw new HTTPException(403, {
            message: "OpenGeni Lens browser handoff expired or changed",
          });
      },
    };
  }
  requirePermission(grant, "secrets:write");
  if (grant.accountId !== state.accountId) {
    throw new HTTPException(403, { message: "OpenGeni Lens state does not match this workspace" });
  }
  return grant;
}

function prReviewBrowserGrantClaims(deps: ApiRouteDeps, grant: AccessGrant) {
  const initiator = {
    initiatingSubjectId: grant.subjectId,
    initiatingExpiresAt: Math.floor(Date.now() / 1_000) + bindingStateMaxAgeSeconds,
  };
  if (
    deps.settings.productAccessMode !== "configured" ||
    !hasPermission(grant.permissions, "workspace:admin") ||
    !hasPermission(grant.permissions, "secrets:write")
  ) {
    return initiator;
  }
  return {
    ...initiator,
    prReviewBrowserGrantSubjectId: grant.subjectId,
    prReviewBrowserGrantExpiresAt: Math.floor(Date.now() / 1_000) + bindingStateMaxAgeSeconds,
  };
}

function continuedBrowserGrantClaims(payload: GitHubSignedStatePayload) {
  return {
    ...(typeof payload.prReviewBrowserGrantSubjectId === "string" &&
    typeof payload.prReviewBrowserGrantExpiresAt === "number"
      ? {
          prReviewBrowserGrantSubjectId: payload.prReviewBrowserGrantSubjectId,
          prReviewBrowserGrantExpiresAt: payload.prReviewBrowserGrantExpiresAt,
        }
      : {}),
    ...(typeof payload.initiatingSubjectId === "string" &&
    typeof payload.initiatingExpiresAt === "number"
      ? {
          initiatingSubjectId: payload.initiatingSubjectId,
          initiatingExpiresAt: payload.initiatingExpiresAt,
        }
      : {}),
  };
}

function requirePrReviewInstallationInitiator(
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
        payload.initiatingExpiresAt > payload.iat + bindingStateMaxAgeSeconds))
  ) {
    throw new HTTPException(403, { message: "OpenGeni Lens initiator expired or changed" });
  }
}

async function requirePrReviewConnectConsent(c: Context, deps: ApiRouteDeps): Promise<string> {
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw))
    throw new HTTPException(403, {
      message: "Finish OpenGeni Lens consent in your signed-in browser",
    });
  const state = c.req.query("state")!;
  const payload = readSignedState(state, deps.githubStateSecret)!;
  if (payload.phase !== "discover" && payload.phase !== "bind")
    throw new HTTPException(400, { message: "invalid OpenGeni Lens consent stage" });
  // External Connect callbacks retain the separately verified stored origin.
  if (
    typeof payload.subjectId === "string" &&
    payload.subjectId.startsWith("external_user:") &&
    payload.nativeBrowserSourceState === undefined &&
    !c.req.header("authorization")
  )
    return state;
  if (c.req.header("authorization"))
    throw new HTTPException(403, {
      message: "Finish OpenGeni Lens consent in your signed-in browser",
    });
  requireStateCookie(c, state);
  const sourceState = requireNativePrReviewConnectBrowserSourceState(deps, state);
  const source = readSignedState(sourceState, deps.githubStateSecret)!;
  const access = await requireAccessGrantAuthorization(
    c,
    deps,
    source.workspaceId!,
    "workspace:admin",
  );
  requirePersonPresentRouteAuthorization(access);
  requirePermission(access.grant, "secrets:write");
  if (access.grant.accountId !== source.accountId || access.grant.subjectId !== source.subjectId)
    throw new HTTPException(403, { message: "OpenGeni Lens connection initiator changed" });
  return sourceState;
}

function readNativePrReviewConnectSourceState(
  deps: ApiRouteDeps,
  state: string,
): GitHubSignedStatePayload {
  const source = readSignedState(state, deps.githubStateSecret);
  if (
    !source ||
    source.kind !== "github_app_connect" ||
    !isFreshState(source) ||
    (source.phase !== "discover" && source.phase !== "bind") ||
    source.providerId !== "github-lens" ||
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
    throw new HTTPException(400, { message: "invalid OpenGeni Lens browser source state" });
  return source;
}

function createNativePrReviewConnectBrowserState(deps: ApiRouteDeps, state: string): string {
  const source = readNativePrReviewConnectSourceState(deps, state);
  return createSignedState(deps.githubStateSecret, {
    kind: "github_app_connect",
    accountId: source.accountId,
    workspaceId: source.workspaceId,
    subjectId: source.subjectId,
    personalOwnerVerified: source.personalOwnerVerified,
    connectAttemptId: source.connectAttemptId,
    phase: source.phase,
    providerId: "github-lens",
    ...(source.installationId !== undefined ? { installationId: source.installationId } : {}),
    nativeBrowserSourceState: state,
  });
}

function requireNativePrReviewConnectBrowserSourceState(deps: ApiRouteDeps, state: string): string {
  const browser = readSignedState(state, deps.githubStateSecret);
  if (!browser || !isFreshState(browser) || typeof browser.nativeBrowserSourceState !== "string")
    throw new HTTPException(400, { message: "independent OpenGeni Lens browser state required" });
  const source = readNativePrReviewConnectSourceState(deps, browser.nativeBrowserSourceState);
  if (
    browser.kind !== source.kind ||
    browser.accountId !== source.accountId ||
    browser.workspaceId !== source.workspaceId ||
    browser.subjectId !== source.subjectId ||
    browser.personalOwnerVerified !== source.personalOwnerVerified ||
    browser.connectAttemptId !== source.connectAttemptId ||
    browser.phase !== source.phase ||
    browser.providerId !== source.providerId ||
    browser.installationId !== source.installationId ||
    browser.nonce === source.nonce ||
    browser.iat < source.iat
  )
    throw new HTTPException(400, { message: "OpenGeni Lens browser source state changed" });
  return browser.nativeBrowserSourceState;
}

async function redirectNativePrReviewConnectBrowser(
  c: Context,
  deps: ApiRouteDeps,
  state: string,
  workspaceId: string,
): Promise<Response> {
  const payload = readNativePrReviewConnectSourceState(deps, state);
  if (payload.workspaceId !== workspaceId)
    throw new HTTPException(400, { message: "invalid OpenGeni Lens browser handoff state" });
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw) || c.req.header("authorization"))
    throw new HTTPException(403, {
      message: "Open OpenGeni Lens consent in your signed-in browser",
    });
  const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:admin");
  requirePersonPresentRouteAuthorization(access);
  requirePermission(access.grant, "secrets:write");
  if (
    !(access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) ||
    access.grant.accountId !== payload.accountId ||
    access.grant.subjectId !== payload.subjectId
  )
    throw new HTTPException(403, { message: "OpenGeni Lens browser handoff initiator changed" });
  assertManagedCompute(deps);
  requireConfiguredApp(deps);
  const browserState = createNativePrReviewConnectBrowserState(deps, state);
  setStateCookie(c, deps, browserState);
  return c.redirect(
    githubOAuthAuthorizeUrl({
      clientId: deps.settings.prReviewGithubClientId!,
      state: browserState,
      redirectUri: `${openGeniBaseUrl(deps, c)}/v1/pr-review/github/oauth/callback`,
    }),
  );
}

async function requirePrReviewConnectSetup(c: Context, deps: ApiRouteDeps): Promise<boolean> {
  const payload = readSignedState(c.req.query("state")!, deps.githubStateSecret)!;
  if (payload.phase !== "install" || !isFreshState(payload))
    throw new HTTPException(400, { message: "invalid OpenGeni Lens installation stage" });
  const delegated = verifiedDelegatedHumanAuthorizationForRequest(c.req.raw);
  if (
    deps.settings.productAccessMode !== "local" &&
    !delegated &&
    !c.req.header("authorization") &&
    !c.req.header("cookie")
  )
    return false;
  if (typeof payload.workspaceId !== "string")
    throw new HTTPException(400, { message: "invalid OpenGeni Lens connection workspace" });
  let access;
  try {
    access = await requireAccessGrantAuthorization(c, deps, payload.workspaceId, "workspace:admin");
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
  requirePermission(access.grant, "secrets:write");
  if (access.grant.accountId !== payload.accountId || access.grant.subjectId !== payload.subjectId)
    throw new HTTPException(403, { message: "OpenGeni Lens connection initiator changed" });
  const nativeBrowser =
    (access.canonicalManagedHumanSession || access.canonicalLocalHumanSession) &&
    !c.req.header("authorization") &&
    !delegated;
  if (nativeBrowser) requirePersonPresentRouteAuthorization(access);
  return nativeBrowser;
}

async function canSeedPrReviewSetupBrowserState(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<boolean> {
  if (verifiedDelegatedHumanAuthorizationForRequest(c.req.raw) || c.req.header("authorization"))
    return false;
  try {
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:admin");
    return access.canonicalManagedHumanSession || access.canonicalLocalHumanSession;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 401) return false;
    throw error;
  }
}

function seedPrReviewConnectBrowserState(c: Context, deps: ApiRouteDeps, response: Response): void {
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
    next.providerId !== "github-lens" ||
    !isFreshState(next) ||
    next.accountId !== source.accountId ||
    next.workspaceId !== source.workspaceId ||
    next.subjectId !== source.subjectId ||
    next.connectAttemptId !== source.connectAttemptId
  )
    throw new HTTPException(403, { message: "OpenGeni Lens browser handoff state changed" });
  const browserState = createNativePrReviewConnectBrowserState(deps, state!);
  url.searchParams.set("state", browserState);
  c.header("Location", url.toString());
  setStateCookie(c, deps, browserState);
}

function prReviewBrowserGrantFromState(
  deps: ApiRouteDeps,
  payload: GitHubSignedStatePayload,
  workspaceId: string,
): AccessGrant | null {
  const subjectId = payload.prReviewBrowserGrantSubjectId;
  const expiresAt = payload.prReviewBrowserGrantExpiresAt;
  const now = Math.floor(Date.now() / 1_000);
  if (
    deps.settings.productAccessMode !== "configured" ||
    payload.workspaceId !== workspaceId ||
    typeof payload.accountId !== "string" ||
    typeof subjectId !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt) ||
    expiresAt < now ||
    expiresAt > payload.iat + bindingStateMaxAgeSeconds
  ) {
    return null;
  }
  return {
    accountId: payload.accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:admin", "secrets:write"],
    metadata: { prReviewGithubBrowserHandoff: true, expiresAt },
  };
}

function redirectToInstallation(c: Context, deps: ApiRouteDeps, sourceState: string): Response {
  const payload = readSignedState(sourceState, deps.githubStateSecret);
  const slug = deps.settings.prReviewGithubAppSlug?.trim();
  if (!payload?.accountId || !payload.workspaceId || !slug) {
    throw new HTTPException(409, { message: "OpenGeni Lens installation is unavailable" });
  }
  const installState = createSignedState(deps.githubStateSecret, {
    accountId: payload.accountId,
    workspaceId: payload.workspaceId,
    intent: "pr_review_github_install",
    ...continuedBrowserGrantClaims(payload),
  });
  setStateCookie(c, deps, installState);
  return c.redirect(
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(installState)}`,
  );
}

function redirectToExactAuthorization(
  c: Context,
  deps: ApiRouteDeps,
  sourceState: string,
  installationId: number,
): Response {
  const payload = readSignedState(sourceState, deps.githubStateSecret);
  const clientId = deps.settings.prReviewGithubClientId?.trim();
  if (!payload?.accountId || !payload.workspaceId || !clientId) {
    throw new HTTPException(409, { message: "OpenGeni Lens authorization is unavailable" });
  }
  const oauthState = createSignedState(deps.githubStateSecret, {
    accountId: payload.accountId,
    workspaceId: payload.workspaceId,
    installationId,
    intent: "pr_review_github_oauth",
    ...continuedBrowserGrantClaims(payload),
  });
  setStateCookie(c, deps, oauthState);
  return c.redirect(
    githubOAuthAuthorizeUrl({
      clientId,
      state: oauthState,
      redirectUri: `${openGeniBaseUrl(deps, c)}/v1/pr-review/github/oauth/callback`,
    }),
  );
}

function requireFreshState(
  state: string,
  deps: ApiRouteDeps,
  intent?: string,
  workspaceId?: string,
): GitHubSignedStatePayload {
  const payload = readSignedState(state, deps.githubStateSecret);
  if (
    !payload ||
    !isFreshState(payload) ||
    typeof payload.accountId !== "string" ||
    typeof payload.workspaceId !== "string" ||
    (intent !== undefined && payload.intent !== intent) ||
    (workspaceId !== undefined && payload.workspaceId !== workspaceId)
  ) {
    throw new HTTPException(400, { message: "invalid or expired OpenGeni Lens state" });
  }
  return payload;
}

function isFreshState(payload: GitHubSignedStatePayload): boolean {
  const age = Math.floor(Date.now() / 1_000) - payload.iat;
  return age >= 0 && age < bindingStateMaxAgeSeconds;
}

function requireStateQuery(c: Context, message: string): string {
  const state = c.req.query("state");
  if (!state) throw new HTTPException(400, { message });
  return state;
}

function setStateCookie(c: Context, deps: ApiRouteDeps, state: string): void {
  setCookie(c, stateCookie, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure:
      deps.settings.publicBaseUrl?.startsWith("https://") ||
      c.req.header("x-forwarded-proto") === "https" ||
      new URL(c.req.url).protocol === "https:",
    path: "/v1",
    maxAge: stateMaxAgeSeconds,
  });
}

function requireStateCookie(c: Context, state: string): void {
  if (!allCookieValues(c, stateCookie).includes(state)) {
    throw new HTTPException(400, { message: "invalid OpenGeni Lens browser state" });
  }
}

function allCookieValues(c: Context, name: string): string[] {
  const prefix = `${name}=`;
  return (c.req.header("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => {
      try {
        return decodeURIComponent(part.slice(prefix.length));
      } catch {
        return part.slice(prefix.length);
      }
    });
}

function consistentCandidates(candidates: GitHubInstallationBindingCandidate[]): boolean {
  const ids = new Set<number>();
  return candidates.every(({ installation, authorityKind }) => {
    if (
      !Number.isSafeInteger(installation.installationId) ||
      installation.installationId <= 0 ||
      !Number.isSafeInteger(installation.accountId) ||
      installation.accountId <= 0 ||
      !installation.accountLogin?.trim() ||
      installation.suspended ||
      ids.has(installation.installationId)
    ) {
      return false;
    }
    ids.add(installation.installationId);
    return authorityKind === "personal_owner"
      ? installation.accountType === "User"
      : installation.accountType === "Organization";
  });
}

function consistentProof(proof: GitHubInstallationBindingProof, installationId: number): boolean {
  const installation = proof.installation;
  if (
    installation.installationId !== installationId ||
    !Number.isSafeInteger(installation.accountId) ||
    installation.accountId <= 0 ||
    !installation.accountLogin?.trim() ||
    installation.suspended ||
    !Number.isSafeInteger(proof.actorId) ||
    proof.actorId <= 0 ||
    !proof.actorLogin.trim() ||
    proof.repositories.length === 0
  ) {
    return false;
  }
  if (
    proof.authorityKind === "personal_owner"
      ? installation.accountType !== "User" || proof.actorId !== installation.accountId
      : installation.accountType !== "Organization"
  ) {
    return false;
  }
  return proof.repositories.every(
    (repository) =>
      Number.isSafeInteger(repository.id) &&
      repository.id > 0 &&
      repository.installationId === installationId &&
      repository.accountLogin === installation.accountLogin &&
      repository.accountType === installation.accountType,
  );
}

function authorityHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof GitHubInstallationAuthorityError) {
    if (error.reason === "authority_denied") {
      return new HTTPException(403, { message: error.message });
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
  return new HTTPException(502, { message: "OpenGeni Lens authority verification failed" });
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ignoredWebhook(reason: string) {
  return {
    accepted: true,
    duplicate: false,
    ignoredReason: reason,
    eventId: null,
    runIds: [],
  };
}

function githubInstallationSettingsUrl(
  installationId: number,
  accountLogin: string | null,
  accountType: "User" | "Organization" | null,
): URL {
  return accountType === "Organization" && accountLogin
    ? new URL(
        `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`,
      )
    : new URL(`https://github.com/settings/installations/${installationId}`);
}

function openGeniBaseUrl(deps: ApiRouteDeps, c: Context): string {
  return githubBrowserBaseUrl(deps.settings, new URL(c.req.url).origin);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

function installationChooserHtml(
  candidates: GitHubInstallationBindingCandidate[],
  state: string,
  workspaceId: string,
  deps: ApiRouteDeps,
  c: Context,
): string {
  const action = `${openGeniBaseUrl(deps, c)}/v1/workspaces/${workspaceId}/pr-review/github/installations/select`;
  const options = candidates
    .map(
      ({ installation, authorityKind }) =>
        `<label class="option"><input type="radio" name="installation_id" value="${installation.installationId}" required><span><strong>${escapeHtml(installation.accountLogin!)}</strong><small>${authorityKind === "personal_owner" ? "Personal account" : "Organization owner"}</small></span></label>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose GitHub account</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:12px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px}p{color:#d4d4d8}.options{display:grid;gap:8px;margin-bottom:18px}.option{display:flex;gap:12px;border:1px solid #3f3f46;border-radius:8px;padding:12px}.option span{display:grid}.option small{color:#a1a1aa}button{min-height:38px;border-radius:7px;border:1px solid #3f3f46;padding:0 14px;font-weight:600}.secondary{margin-left:8px;background:transparent;color:#f4f4f5}</style></head><body><main><h1>Connect OpenGeni Lens</h1><p>Choose an account where GitHub proved you are the owner.</p><form method="get" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><div class="options">${options}</div><button type="submit">Connect selected</button><button class="secondary" type="submit" name="installation_id" value="new" formnovalidate>Install on another account</button></form></main></body></html>`;
}

function setupSuccessHtml(account: string, returnUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenGeni Lens Connected</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}p{color:#d4d4d8}.button{display:inline-flex;min-height:36px;align-items:center;border-radius:6px;padding:0 12px;background:#f4f4f5;color:#09090b;font-weight:600;text-decoration:none}</style></head><body><main><h1>OpenGeni Lens connected</h1><p>${escapeHtml(account)} and its selected repositories are ready for pull-request review.</p><a class="button" href="${escapeHtml(returnUrl)}">Back to OpenGeni</a></main></body></html>`;
}

function setupPendingHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenGeni Lens Requested</title></head><body><main><h1>Installation requested</h1><p>A GitHub organization owner must approve OpenGeni Lens. No repository was connected yet.</p></main></body></html>`;
}
