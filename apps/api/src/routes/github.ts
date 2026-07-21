import { GitHubAppManifestCreate, type GitHubUserInstallationAccess } from "@opengeni/contracts";
import { bindGitHubInstallationRepositories, deleteGitHubInstallationBinding } from "@opengeni/db";
import {
  authorizeGitHubAppUser,
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  getGitHubAppInstallationSummary,
  githubOAuthAuthorizeUrl,
  githubAppMissingSettings,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  readSignedState,
  stateMaxAgeSeconds,
  verifySignedState,
} from "@opengeni/github";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  listWorkspaceGitHubInstallationBindings,
  listWorkspaceGitHubRepositories,
} from "../github-access";

const githubStateCookie = "opengeni_github_state";
const githubLinkTicketMaxAgeSeconds = 10 * 60;

export function registerGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  app.get("/v1/workspaces/:workspaceId/github/app", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:use");
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    const installState = createSignedState(githubStateSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      intent: "install",
    });
    const linkState = createSignedState(githubStateSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      intent: "link_existing",
    });
    const baseUrl = openGeniBaseUrl(settings, c);
    const connectBase = `${baseUrl}/v1/workspaces/${grant.workspaceId}/github/connect`;
    return c.json({
      configured: missing.length === 0,
      appId: settings.githubAppId ?? null,
      clientId: settings.githubClientId ?? null,
      appSlug: slug,
      installUrl: slug ? `${connectBase}?state=${encodeURIComponent(installState)}` : null,
      linkUrl:
        missing.length === 0 && slug
          ? `${connectBase}?state=${encodeURIComponent(linkState)}`
          : null,
      installations: await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId),
      missing,
    });
  });

  // Browser entry point for install links issued outside a browser context
  // (the first-party MCP github_connect_link tool): it plants the CSRF state
  // cookie the install/OAuth callbacks require and forwards to GitHub.
  // Deliberately unauthenticated: the signed state is only ever minted for
  // grants holding github:use, expires after stateMaxAgeSeconds, and is bound
  // to this workspace; completing the installation binding still requires an
  // authenticated github:manage grant in the same browser at the callback.
  app.get("/v1/workspaces/:workspaceId/github/connect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (!statePayload || statePayload.workspaceId !== workspaceId) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    const slug = settings.githubAppSlug?.trim();
    if (!slug) {
      throw new HTTPException(409, {
        message: JSON.stringify({
          message: "GitHub App is not configured",
          missing: githubAppMissingSettings(settings),
        }),
      });
    }
    setGitHubStateCookie(c, deps, state);
    if (statePayload.intent === "link_existing") {
      const clientId = settings.githubClientId?.trim();
      if (!clientId) {
        throw new HTTPException(409, {
          message: JSON.stringify({
            message: "GitHub App is not configured",
            missing: ["OPENGENI_GITHUB_CLIENT_ID"],
          }),
        });
      }
      const baseUrl = openGeniBaseUrl(settings, c);
      return c.redirect(
        githubOAuthAuthorizeUrl({
          clientId,
          state,
          redirectUri: `${baseUrl}/v1/github/oauth/callback`,
        }),
      );
    }
    return c.redirect(
      `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
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

  app.delete("/v1/workspaces/:workspaceId/github/installations/:installationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
    const installationId = parsePositiveInteger(c.req.param("installationId"));
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation id" });
    }
    const deleted = await deleteGitHubInstallationBinding(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId,
    });
    if (!deleted) {
      throw new HTTPException(404, { message: "GitHub installation binding not found" });
    }
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/github/app-manifest", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
    const payload = GitHubAppManifestCreate.parse(await c.req.json());
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
      const slug = String(conversion.slug ?? "");
      const installUrl = slug
        ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
        : "";
      setGitHubStateCookie(c, deps, state);
      return c.html(githubSuccessHtml(envLines, installUrl));
    } catch (error) {
      const message = error instanceof GitHubAppApiError ? error.message : String(error);
      throw new HTTPException(502, { message });
    }
  });

  const handleGitHubInstallCallback = async (c: Context) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const installationIdRaw = c.req.query("installation_id");
    const setupAction = c.req.query("setup_action") ?? null;
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      typeof statePayload.accountId !== "string" ||
      typeof statePayload.workspaceId !== "string"
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireAccessGrant(c, deps, statePayload.workspaceId, "github:manage");
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, {
        message: "GitHub installation state does not match this workspace",
      });
    }
    if (setupAction === "request" && !installationIdRaw) {
      return c.html(githubSetupPendingHtml());
    }
    const installationId = parsePositiveInteger(installationIdRaw);
    if (installationId === null) {
      throw new HTTPException(400, { message: "missing or invalid GitHub installation_id" });
    }
    if (!code) {
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
      });
      const baseUrl = openGeniBaseUrl(settings, c);
      setGitHubStateCookie(c, deps, oauthState);
      return c.redirect(
        githubOAuthAuthorizeUrl({
          clientId,
          state: oauthState,
          redirectUri: `${baseUrl}/v1/github/oauth/callback`,
        }),
      );
    }
    return await completeGitHubInstallationBinding(deps, c, {
      code,
      statePayload,
      installationId,
    });
  };

  app.get("/v1/github/setup", handleGitHubInstallCallback);
  app.get("/v1/github/install/callback", handleGitHubInstallCallback);

  app.get("/v1/github/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
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
      typeof statePayload.workspaceId !== "string"
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    requireGitHubStateCookie(c, state);
    if (statePayload.intent === "link_existing") {
      const grant = await requireAccessGrant(c, deps, statePayload.workspaceId, "github:manage");
      if (grant.accountId !== statePayload.accountId) {
        throw new HTTPException(403, {
          message: "GitHub installation state does not match this workspace",
        });
      }
      try {
        const installations = await authorizeGitHubUser(deps, code);
        const existing = new Set(
          (await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId)).map(
            (installation) => installation.installationId,
          ),
        );
        return c.html(
          githubExistingInstallationsHtml({
            stateSecret: githubStateSecret,
            oauthState: state,
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            parentNonce: statePayload.nonce,
            installations,
            existingInstallationIds: existing,
          }),
        );
      } catch (error) {
        throw githubHttpError(error);
      }
    }
    const installationId = parsePositiveInteger(
      String(statePayload.installationId ?? c.req.query("installation_id") ?? ""),
    );
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    return await completeGitHubInstallationBinding(deps, c, {
      code,
      statePayload,
      installationId,
    });
  });

  app.post("/v1/workspaces/:workspaceId/github/installations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
    const form = new URLSearchParams(await c.req.text());
    const oauthState = form.get("oauth_state");
    const installationTicket = form.get("installation_ticket");
    const repositoryTickets = form.getAll("repository_ticket");
    if (!oauthState || !installationTicket || repositoryTickets.length === 0) {
      throw new HTTPException(400, { message: "select at least one authorized GitHub repository" });
    }
    requireGitHubStateCookie(c, oauthState);
    const oauthPayload = readSignedState(oauthState, githubStateSecret);
    const installationPayload = readGitHubLinkTicket(
      installationTicket,
      githubStateSecret,
      "link_installation",
    );
    if (
      !oauthPayload ||
      oauthPayload.intent !== "link_existing" ||
      oauthPayload.workspaceId !== grant.workspaceId ||
      oauthPayload.accountId !== grant.accountId ||
      installationPayload.workspaceId !== grant.workspaceId ||
      installationPayload.accountId !== grant.accountId ||
      installationPayload.parentNonce !== oauthPayload.nonce
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation selection" });
    }
    const installationId = parsePositiveInteger(String(installationPayload.installationId ?? ""));
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation selection" });
    }
    const repositoryIds = repositoryTickets.map((ticket) => {
      const payload = readGitHubLinkTicket(ticket, githubStateSecret, "link_repository");
      const repositoryId = parsePositiveInteger(String(payload.repositoryId ?? ""));
      if (
        payload.workspaceId !== grant.workspaceId ||
        payload.accountId !== grant.accountId ||
        payload.parentNonce !== oauthPayload.nonce ||
        payload.installationId !== installationId ||
        repositoryId === null
      ) {
        throw new HTTPException(400, { message: "invalid GitHub repository selection" });
      }
      return repositoryId;
    });
    let liveInstallation;
    try {
      liveInstallation = await getLiveGitHubInstallation(deps, {
        installationId,
        accountLogin:
          typeof installationPayload.accountLogin === "string"
            ? installationPayload.accountLogin
            : null,
        accountType:
          typeof installationPayload.accountType === "string"
            ? installationPayload.accountType
            : null,
      });
    } catch (error) {
      throw githubHttpError(error);
    }
    if (!liveInstallation) {
      throw new HTTPException(404, {
        message: "GitHub App installation was not found for this app",
      });
    }
    if (liveInstallation.suspended) {
      throw new HTTPException(409, { message: "GitHub App installation is suspended" });
    }
    await bindGitHubInstallationRepositories(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId,
      accountLogin: liveInstallation.accountLogin,
      accountType: liveInstallation.accountType,
      linkedBySubjectId: grant.subjectId,
      repositoryIds,
    });
    deleteCookie(c, githubStateCookie, { path: "/v1" });
    return c.html(
      githubSetupSuccessHtml(
        liveInstallation.accountLogin ?? `installation ${installationId}`,
        openGeniReturnUrl(settings, c, grant.workspaceId),
      ),
    );
  });
}

async function completeGitHubInstallationBinding(
  deps: ApiRouteDeps,
  c: Context,
  input: {
    code: string;
    statePayload: { accountId?: string; workspaceId?: string };
    installationId: number;
  },
) {
  const { db, settings } = deps;
  if (!input.statePayload.workspaceId || !input.statePayload.accountId) {
    throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
  }
  const grant = await requireAccessGrant(c, deps, input.statePayload.workspaceId, "github:manage");
  if (grant.accountId !== input.statePayload.accountId) {
    throw new HTTPException(403, {
      message: "GitHub installation state does not match this workspace",
    });
  }
  try {
    const installation = await authorizeGitHubInstallationForBinding(
      deps,
      input.code,
      input.installationId,
    );
    if (!installation) {
      throw new HTTPException(404, {
        message: "GitHub App installation was not found for this app",
      });
    }
    if (installation.suspended) {
      throw new HTTPException(409, { message: "GitHub App installation is suspended" });
    }
    const repositoryIds = installation.repositories
      .filter((repository) => repository.permissions.admin)
      .map((repository) => repository.id);
    if (repositoryIds.length === 0) {
      throw new HTTPException(403, {
        message:
          "Linking a GitHub App installation requires admin access to at least one repository",
      });
    }
    await bindGitHubInstallationRepositories(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId: input.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      linkedBySubjectId: grant.subjectId,
      repositoryIds,
    });
    const returnUrl = openGeniReturnUrl(settings, c, input.statePayload.workspaceId);
    deleteCookie(c, githubStateCookie, { path: "/v1" });
    return c.html(
      githubSetupSuccessHtml(
        installation.accountLogin ?? `installation ${input.installationId}`,
        returnUrl,
      ),
    );
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw githubHttpError(error);
  }
}

async function authorizeGitHubUser(
  deps: ApiRouteDeps,
  code: string,
): Promise<GitHubUserInstallationAccess[]> {
  if (deps.githubAppApi?.authorizeUser) {
    return await deps.githubAppApi.authorizeUser({ code });
  }
  if (deps.githubAppApi) {
    throw new HTTPException(409, {
      message:
        "The configured GitHub App API provider does not support linking existing installations",
    });
  }
  return await authorizeGitHubAppUser(deps.settings, { code });
}

async function authorizeGitHubInstallationForBinding(
  deps: ApiRouteDeps,
  code: string,
  installationId: number,
): Promise<GitHubUserInstallationAccess | null> {
  if (deps.githubAppApi?.authorizeUser || !deps.githubAppApi) {
    const installations = await authorizeGitHubUser(deps, code);
    return (
      installations.find((installation) => installation.installationId === installationId) ?? null
    );
  }
  if (!deps.githubAppApi.verifyInstallationAccessForUser) {
    throw new HTTPException(409, {
      message: "The configured GitHub App API provider cannot verify installations",
    });
  }
  const installation = await deps.githubAppApi.verifyInstallationAccessForUser({
    code,
    installationId,
  });
  const repositories = deps.githubAppApi.listRepositories
    ? await deps.githubAppApi.listRepositories({ installationIds: [installationId] })
    : [];
  return {
    ...installation,
    // This compatibility branch is reached only from GitHub's install/update
    // callback, where GitHub already enforced installation authority. New
    // providers should implement authorizeUser so per-repository permission
    // bits remain explicit.
    repositories: repositories.map((repository) => ({
      ...repository,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    })),
  };
}

async function getLiveGitHubInstallation(
  deps: ApiRouteDeps,
  fallback: { installationId: number; accountLogin: string | null; accountType: string | null },
) {
  if (deps.githubAppApi?.getInstallation) {
    return await deps.githubAppApi.getInstallation({ installationId: fallback.installationId });
  }
  if (deps.githubAppApi) {
    return { ...fallback, suspended: false };
  }
  return await getGitHubAppInstallationSummary(deps.settings, fallback.installationId);
}

function githubHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) {
    return error;
  }
  if (error instanceof GitHubAppConfigurationError) {
    return new HTTPException(409, {
      message: JSON.stringify({ message: error.message, missing: error.missing }),
    });
  }
  return new HTTPException(502, {
    message: error instanceof Error ? error.message : String(error),
  });
}

function readGitHubLinkTicket(
  ticket: string,
  secret: string,
  intent: "link_installation" | "link_repository",
) {
  const payload = readSignedState(ticket, secret);
  const age = payload ? Math.floor(Date.now() / 1000) - payload.iat : Number.POSITIVE_INFINITY;
  if (!payload || payload.intent !== intent || age < 0 || age > githubLinkTicketMaxAgeSeconds) {
    throw new HTTPException(400, { message: "invalid or expired GitHub installation selection" });
  }
  return payload;
}

function githubExistingInstallationsHtml(input: {
  stateSecret: string;
  oauthState: string;
  accountId: string;
  workspaceId: string;
  parentNonce: string;
  installations: GitHubUserInstallationAccess[];
  existingInstallationIds: Set<number>;
}): string {
  const cards = input.installations
    .map((installation) => {
      const repositories = installation.repositories.filter(
        (repository) => repository.permissions.admin,
      );
      const installationTicket = createSignedState(input.stateSecret, {
        intent: "link_installation",
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        parentNonce: input.parentNonce,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
      });
      const repositoryInputs = repositories
        .map((repository) => {
          const repositoryTicket = createSignedState(input.stateSecret, {
            intent: "link_repository",
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            parentNonce: input.parentNonce,
            installationId: installation.installationId,
            repositoryId: repository.id,
          });
          return `<label class="repo"><input type="checkbox" name="repository_ticket" value="${escapeHtml(repositoryTicket)}" checked><span><strong>${escapeHtml(repository.fullName)}</strong><small>${repository.private ? "Private" : "Public"} · repository admin</small></span></label>`;
        })
        .join("");
      const connected = input.existingInstallationIds.has(installation.installationId);
      const disabled = installation.suspended || repositories.length === 0;
      const status = installation.suspended
        ? "Suspended on GitHub"
        : repositories.length === 0
          ? "No repositories where this user has admin access"
          : `${repositories.length} repositories available`;
      return `<form method="post" action="/v1/workspaces/${escapeHtml(input.workspaceId)}/github/installations" class="card">
      <input type="hidden" name="oauth_state" value="${escapeHtml(input.oauthState)}">
      <input type="hidden" name="installation_ticket" value="${escapeHtml(installationTicket)}">
      <div class="card-head"><div><h2>${escapeHtml(installation.accountLogin ?? `Installation ${installation.installationId}`)}</h2><p>${escapeHtml(status)}</p></div>${connected ? '<span class="badge">Linked</span>' : ""}</div>
      ${repositoryInputs ? `<div class="repos">${repositoryInputs}</div>` : ""}
      <button type="submit" ${disabled ? "disabled" : ""}>${connected ? "Update workspace access" : "Link selected repositories"}</button>
    </form>`;
    })
    .join("");
  const body =
    cards ||
    '<div class="empty"><h2>No existing installations found</h2><p>Install the GitHub App on a personal account or organization first, then return here.</p></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link GitHub installation</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;background:#0b0b0d;color:#f4f4f5}main{width:min(780px,calc(100vw - 32px));margin:48px auto}h1{margin:0 0 8px;font-size:26px}main>p{margin:0 0 24px;color:#a1a1aa}.grid{display:grid;gap:14px}.card,.empty{border:1px solid #27272a;border-radius:10px;padding:18px;background:#111114}.card-head{display:flex;justify-content:space-between;gap:16px}.card h2,.empty h2{margin:0;font-size:17px}.card p,.empty p{margin:5px 0 0;color:#a1a1aa;font-size:13px}.badge{height:fit-content;border:1px solid #3f3f46;border-radius:999px;padding:3px 8px;color:#d4d4d8;font-size:11px}.repos{max-height:320px;overflow:auto;margin:16px 0;border:1px solid #27272a;border-radius:8px}.repo{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-bottom:1px solid #27272a;cursor:pointer}.repo:last-child{border-bottom:0}.repo strong,.repo small{display:block}.repo strong{font-size:13px}.repo small{margin-top:2px;color:#a1a1aa;font-size:11px}button{min-height:38px;border:1px solid #3f3f46;border-radius:7px;padding:0 13px;background:#f4f4f5;color:#09090b;font:600 14px system-ui;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}</style></head><body><main><h1>Link an existing GitHub installation</h1><p>Choose the repositories this OpenGeni workspace may use. Only repositories where your GitHub user has administrator access are eligible.</p><div class="grid">${body}</div></main></body></html>`;
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
  if (getCookie(c, githubStateCookie) !== state) {
    throw new HTTPException(400, {
      message: "invalid or expired GitHub installation browser state",
    });
  }
}

function isSecureRequest(c: Context, deps: ApiRouteDeps): boolean {
  return (
    deps.settings.publicBaseUrl?.startsWith("https://") ||
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:"
  );
}

function githubSuccessHtml(envLines: string[], installUrl: string): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  const install = installUrl
    ? `<a class="button secondary" href="${escapeHtml(installUrl)}">Install on repositories</a>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Created</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(760px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0 0 18px;color:#d4d4d8}.env-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 8px}.env-header h2{margin:0;font-size:13px;line-height:1.2;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa}pre{white-space:pre-wrap;word-break:break-word;max-height:380px;overflow:auto;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:16px;font-size:13px;line-height:1.5}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border-radius:6px;border:1px solid #3f3f46;padding:0 12px;background:#f4f4f5;color:#09090b;font:600 14px system-ui,sans-serif;text-decoration:none;cursor:pointer}.button.secondary{background:transparent;color:#fafafa}.button.secondary:hover,button.secondary:hover{background:#27272a}button:disabled{cursor:not-allowed;opacity:.7}</style></head><body><main><h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><div class="env-header"><h2>Environment variables</h2><button id="copy-env" type="button">Copy env</button></div><pre id="env-lines">${escaped}</pre><div class="actions">${install}</div><script>(()=>{const button=document.getElementById("copy-env");const env=document.getElementById("env-lines");async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}const area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.inset="-9999px";document.body.append(area);area.select();document.execCommand("copy");area.remove();}button?.addEventListener("click",async()=>{try{await copyText(env?.textContent||"");button.textContent="Copied";setTimeout(()=>button.textContent="Copy env",1600);}catch{button.textContent="Copy failed";setTimeout(()=>button.textContent="Copy env",2200);}});})();</script></main></body></html>`;
}

function githubSetupSuccessHtml(account: string, returnUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Connected</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0 0 18px;color:#d4d4d8}.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border-radius:6px;border:1px solid #3f3f46;padding:0 12px;background:#f4f4f5;color:#09090b;font:600 14px system-ui,sans-serif;text-decoration:none}.button:hover{background:#e4e4e7}</style></head><body><main><h1>GitHub App connected</h1><p>${escapeHtml(account)} is now available to this OpenGeni workspace.</p><a class="button" href="${escapeHtml(returnUrl)}">Back to OpenGeni</a></main></body></html>`;
}

function githubSetupPendingHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Requested</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0;color:#d4d4d8}</style></head><body><main><h1>GitHub App request sent</h1><p>An organization administrator must approve the installation before OpenGeni can connect it to this workspace.</p></main></body></html>`;
}

function parsePositiveInteger(value: string | undefined | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}

function openGeniReturnUrl(
  settings: ApiRouteDeps["settings"],
  c: Context,
  workspaceId: string | undefined,
): string {
  const base = openGeniBaseUrl(settings, c);
  const url = new URL(base || new URL(c.req.url).origin);
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  return url.toString();
}

function openGeniBaseUrl(settings: ApiRouteDeps["settings"], c: Context): string {
  return (
    settings.githubAppManifestBaseUrl ??
    settings.publicBaseUrl ??
    new URL(c.req.url).origin
  ).replace(/\/+$/, "");
}
