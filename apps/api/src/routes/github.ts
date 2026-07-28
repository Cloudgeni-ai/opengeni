import {
  GitHubAppManifestCreate,
  type AccessGrant,
  type GitHubInstallationBindingProof,
} from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  deleteGitHubInstallationBinding,
  GitHubInstallationAuthorityCommitError,
} from "@opengeni/db";
import {
  authorizeGitHubInstallationBinding,
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  GitHubInstallationAuthorityError,
  githubAppMissingSettings,
  githubOAuthAuthorizeUrl,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  readSignedState,
  stateMaxAgeSeconds,
  type GitHubSignedStatePayload,
  verifySignedState,
} from "@opengeni/github";
import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  continuedGitHubBrowserGrantClaims,
  githubBrowserBaseUrl,
  githubBrowserGrantClaims,
  githubBrowserGrantFromState,
} from "../github-browser-flow";
import {
  githubBindingStatus,
  listWorkspaceGitHubInstallationBindings,
  listWorkspaceGitHubRepositories,
} from "../github-access";

const githubStateCookie = "opengeni_github_state";
const githubBindingStateMaxAgeSeconds = 10 * 60;
const legacyInstallationChooserDisabledMessage =
  "The legacy repository-admin GitHub installation chooser is disabled; use the GitHub owner-consent connect flow";

export function registerGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  app.get("/v1/workspaces/:workspaceId/github/app", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:use");
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    const installations =
      missing.length === 0
        ? await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId)
        : [];
    const status = githubBindingStatus(missing.length === 0, installations);
    const canManage = hasPermission(grant.permissions, "github:manage");
    const connectState =
      missing.length === 0 && slug && canManage
        ? createSignedState(githubStateSecret, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            intent: "installation_authority",
            ...githubBrowserGrantClaims(settings, grant),
          })
        : null;
    const connectUrl = connectState
      ? `${openGeniBaseUrl(settings, c)}/v1/workspaces/${grant.workspaceId}/github/connect?state=${encodeURIComponent(connectState)}`
      : null;
    return c.json({
      configured: missing.length === 0,
      status,
      appId: settings.githubAppId ?? null,
      clientId: settings.githubClientId ?? null,
      appSlug: slug,
      installUrl: connectUrl,
      linkUrl: connectUrl,
      installations,
      missing,
    });
  });

  // The signed state is a short browser handoff minted only for an OpenGeni
  // github:manage grant. GitHub remains responsible for installation/config
  // consent; the later OAuth callback independently proves current owner
  // authority before any workspace binding write.
  app.get("/v1/workspaces/:workspaceId/github/connect", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
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
    const slug = settings.githubAppSlug?.trim();
    if (!slug || githubAppMissingSettings(settings).length > 0) {
      throw new HTTPException(409, {
        message: JSON.stringify({
          message: "GitHub App is not configured",
          missing: githubAppMissingSettings(settings),
        }),
      });
    }
    setGitHubStateCookie(c, deps, state);
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
      setGitHubStateCookie(c, deps, state);
      return c.html(githubSuccessHtml(envLines));
    } catch (error) {
      const message = error instanceof GitHubAppApiError ? error.message : String(error);
      throw new HTTPException(502, { message });
    }
  });

  const handleGitHubInstallCallback = async (c: Context) => {
    const state = c.req.query("state");
    if (!state) {
      throw new HTTPException(400, { message: "missing GitHub installation state" });
    }
    const statePayload = readSignedState(state, githubStateSecret);
    if (
      !statePayload ||
      statePayload.intent !== "installation_authority" ||
      typeof statePayload.accountId !== "string" ||
      typeof statePayload.workspaceId !== "string" ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireGitHubManageGrant(c, deps, statePayload.workspaceId, statePayload);
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
      ...continuedGitHubBrowserGrantClaims(statePayload),
    });
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
      statePayload.intent !== "installation_authority_oauth" ||
      typeof statePayload.accountId !== "string" ||
      typeof statePayload.workspaceId !== "string" ||
      !isFreshGitHubBindingState(statePayload)
    ) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    const installationId = parsePositiveInteger(String(statePayload.installationId ?? ""));
    if (installationId === null) {
      throw new HTTPException(400, { message: "invalid GitHub installation id" });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireGitHubManageGrant(c, deps, statePayload.workspaceId, statePayload);
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, {
        message: "GitHub OAuth state does not match this workspace",
      });
    }
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
      bound = await bindAuthorizedGitHubInstallationRepositories(db, {
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
        openGeniReturnUrl(settings, c, grant.workspaceId),
      ),
    );
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
    throw legacyInstallationChooserDisabled();
  });
}

function legacyInstallationChooserDisabled(): HTTPException {
  return new HTTPException(410, { message: legacyInstallationChooserDisabledMessage });
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
): Promise<AccessGrant> {
  try {
    return await requireAccessGrant(c, deps, workspaceId, "github:manage");
  } catch (error) {
    if (!(error instanceof HTTPException) || error.status !== 401) {
      throw error;
    }
    const grant = githubBrowserGrantFromState(deps.settings, expectedState, workspaceId);
    if (grant) {
      return grant;
    }
    throw error;
  }
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
  return new HTTPException(502, { message: "GitHub authority verification failed" });
}

function isSecureRequest(c: Context, deps: ApiRouteDeps): boolean {
  return (
    deps.settings.publicBaseUrl?.startsWith("https://") ||
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:"
  );
}

function githubSuccessHtml(envLines: string[]): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Created</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(760px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0 0 18px;color:#d4d4d8}.env-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:22px 0 8px}.env-header h2{margin:0;font-size:13px;line-height:1.2;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa}pre{white-space:pre-wrap;word-break:break-word;max-height:380px;overflow:auto;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:16px;font-size:13px;line-height:1.5}button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border-radius:6px;border:1px solid #3f3f46;padding:0 12px;background:#f4f4f5;color:#09090b;font:600 14px system-ui,sans-serif;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.7}</style></head><body><main><h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><div class="env-header"><h2>Environment variables</h2><button id="copy-env" type="button">Copy env</button></div><pre id="env-lines">${escaped}</pre><script>(()=>{const button=document.getElementById("copy-env");const env=document.getElementById("env-lines");async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}const area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.inset="-9999px";document.body.append(area);area.select();document.execCommand("copy");area.remove();}button?.addEventListener("click",async()=>{try{await copyText(env?.textContent||"");button.textContent="Copied";setTimeout(()=>button.textContent="Copy env",1600);}catch{button.textContent="Copy failed";setTimeout(()=>button.textContent="Copy env",2200);}});})();</script></main></body></html>`;
}

function githubSetupSuccessHtml(account: string, returnUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Connected</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0 0 18px;color:#d4d4d8}.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border-radius:6px;border:1px solid #3f3f46;padding:0 12px;background:#f4f4f5;color:#09090b;font:600 14px system-ui,sans-serif;text-decoration:none}</style></head><body><main><h1>GitHub App connected</h1><p>${escapeHtml(account)} is now available to this OpenGeni workspace through an explicit repository allowlist.</p><a class="button" href="${escapeHtml(returnUrl)}">Back to OpenGeni</a></main></body></html>`;
}

function githubSetupPendingHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Requested</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(640px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}h1{margin:0 0 10px;font-size:24px;line-height:1.2}p{margin:0;color:#d4d4d8}</style></head><body><main><h1>GitHub App request sent</h1><p>A GitHub organization owner must approve the installation. OpenGeni has not created a workspace binding.</p></main></body></html>`;
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

function isConsistentGitHubBindingProof(
  proof: GitHubInstallationBindingProof,
  installationId: number,
): boolean {
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
  workspaceId: string,
): string {
  const url = new URL(openGeniBaseUrl(settings, c) || new URL(c.req.url).origin);
  url.searchParams.set("workspaceId", workspaceId);
  return url.toString();
}

function openGeniBaseUrl(settings: ApiRouteDeps["settings"], c: Context): string {
  return githubBrowserBaseUrl(settings, new URL(c.req.url).origin);
}
