import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  AUTOMATION_WEBHOOK_MAX_BYTES,
  OPENGENI_PR_REVIEW_PACK_ID,
  PrReviewManagedGitHubSetup,
  type AccessGrant,
  type GitHubInstallationBindingCandidate,
  type GitHubInstallationBindingProof,
} from "@opengeni/contracts";
import {
  automationRequestDigest,
  getCapabilityPack,
  hasPermission,
  PR_REVIEW_AUTOMATION_TEMPLATE_ID,
  prReviewPackConnectorId,
  requireAutomationAdapter,
  requireAccessGrant,
  requirePermission,
  verifyPrReviewWebhook,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  AutomationDeliveryConflictError,
  encryptVariableSetValue,
  getAutomationSourceSecret,
  getPackInstallation,
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
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { githubBrowserBaseUrl } from "../github-browser-flow";
import { acceptAutomationEvent, readAutomationWebhookBody } from "./automations";

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
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await requireActivePack(deps, workspaceId);
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
    const payload = requireFreshState(state, deps, "pr_review_github_authority", workspaceId);
    await requirePrReviewManageGrant(c, deps, workspaceId, payload);
    await requireActivePack(deps, workspaceId);
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
      await requireActivePack(deps, workspaceId);
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
    const state =
      c.req.query("state") ??
      allCookieValues(c, stateCookie).find((candidate) => {
        const payload = readSignedState(candidate, deps.githubStateSecret);
        return payload?.intent === "pr_review_github_install" && isFreshState(payload);
      });
    if (!state) throw new HTTPException(400, { message: "missing OpenGeni Lens state" });
    const payload = requireFreshState(state, deps, "pr_review_github_install");
    requireStateCookie(c, state);
    await requirePrReviewManageGrant(c, deps, payload.workspaceId!, payload);
    await requireActivePack(deps, payload.workspaceId!);
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
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      throw new HTTPException(400, { message: "missing OpenGeni Lens OAuth code or state" });
    }
    const payload = requireFreshState(state, deps);
    requireStateCookie(c, state);
    const grant = await requirePrReviewManageGrant(c, deps, payload.workspaceId!, payload);
    const packInstallation = await requireActivePack(deps, grant.workspaceId);
    assertManagedCompute(deps);
    requireConfiguredApp(deps);

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
    const template = getCapabilityPack(OPENGENI_PR_REVIEW_PACK_ID)?.automationTemplates?.find(
      (candidate) => candidate.id === PR_REVIEW_AUTOMATION_TEMPLATE_ID,
    );
    if (!template) {
      throw new HTTPException(503, { message: "PR Review automation template is unavailable" });
    }
    const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
    if (!encryptionKey) {
      throw new HTTPException(503, {
        message: "OpenGeni Lens requires configured secret encryption",
      });
    }
    let synchronized;
    try {
      synchronized = await syncManagedGitHubPrReviewInstallation(deps.db, {
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
        packInstallationId: packInstallation.id,
        packConnectorId: prReviewPackConnectorId("github"),
        packTemplateId: template.id,
        adapterId: template.adapterId,
        eventTypes: template.eventTypes,
        configuration: template.configuration,
        sessionTemplate: template.sessionTemplate,
      });
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
    await requireActivePack(deps, workspaceId);
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

async function requireActivePack(deps: ApiRouteDeps, workspaceId: string) {
  const installation = await getPackInstallation(deps.db, workspaceId, OPENGENI_PR_REVIEW_PACK_ID);
  if (installation?.status !== "active") {
    throw new HTTPException(409, {
      message: "Install and enable the OpenGeni Review Bot Pack first",
    });
  }
  return installation;
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
): Promise<AccessGrant> {
  let grant: AccessGrant;
  try {
    grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
  } catch (error) {
    if (!(error instanceof HTTPException) || error.status !== 401) throw error;
    const handedOff = prReviewBrowserGrantFromState(deps, state, workspaceId);
    if (!handedOff) throw error;
    grant = handedOff;
  }
  requirePermission(grant, "secrets:write");
  if (grant.accountId !== state.accountId) {
    throw new HTTPException(403, { message: "OpenGeni Lens state does not match this workspace" });
  }
  return grant;
}

function prReviewBrowserGrantClaims(deps: ApiRouteDeps, grant: AccessGrant) {
  if (
    deps.settings.productAccessMode !== "configured" ||
    !hasPermission(grant.permissions, "workspace:admin") ||
    !hasPermission(grant.permissions, "secrets:write")
  ) {
    return {};
  }
  return {
    prReviewBrowserGrantSubjectId: grant.subjectId,
    prReviewBrowserGrantExpiresAt: Math.floor(Date.now() / 1_000) + bindingStateMaxAgeSeconds,
  };
}

function continuedBrowserGrantClaims(payload: GitHubSignedStatePayload) {
  return typeof payload.prReviewBrowserGrantSubjectId === "string" &&
    typeof payload.prReviewBrowserGrantExpiresAt === "number"
    ? {
        prReviewBrowserGrantSubjectId: payload.prReviewBrowserGrantSubjectId,
        prReviewBrowserGrantExpiresAt: payload.prReviewBrowserGrantExpiresAt,
      }
    : {};
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
