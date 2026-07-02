import { GitHubAppManifestCreate } from "@opengeni/contracts";
import {
  listGitHubInstallationIdsForWorkspace,
  upsertGitHubInstallation,
} from "@opengeni/db";
import {
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  githubOAuthAuthorizeUrl,
  githubAppMissingSettings,
  listGitHubAppRepositories,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  readSignedState,
  stateMaxAgeSeconds,
  verifyGitHubInstallationAccessForUser,
  verifySignedState,
} from "@opengeni/github";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";

const githubStateCookie = "opengeni_github_state";

export function registerGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, settings, githubStateSecret } = deps;

  app.get("/v1/workspaces/:workspaceId/github/app", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:use");
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    const state = createSignedState(githubStateSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    setGitHubStateCookie(c, deps, state);
    return c.json({
      configured: missing.length === 0,
      appId: settings.githubAppId ?? null,
      clientId: settings.githubClientId ?? null,
      appSlug: slug,
      installUrl: slug ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}` : null,
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
      throw new HTTPException(409, { message: JSON.stringify({ message: "GitHub App is not configured", missing: githubAppMissingSettings(settings) }) });
    }
    setGitHubStateCookie(c, deps, state);
    return c.redirect(`https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`);
  });

  app.get("/v1/workspaces/:workspaceId/github/repositories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "github:use");
    try {
      return c.json({ repositories: await listWorkspaceGitHubRepositories(deps, workspaceId) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/workspaces/:workspaceId/github/repositories/sync", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "github:use");
    try {
      return c.json({ repositories: await listWorkspaceGitHubRepositories(deps, workspaceId) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/workspaces/:workspaceId/github/app-manifest", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "github:manage");
    const payload = GitHubAppManifestCreate.parse(await c.req.json());
    const baseUrl = (settings.githubAppManifestBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
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
      actionUrl: organization ? organizationAppManifestUrl(organization, state) : personalAppManifestUrl(state),
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
      const installUrl = slug ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}` : "";
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
    if (!statePayload || typeof statePayload.accountId !== "string" || typeof statePayload.workspaceId !== "string") {
      throw new HTTPException(400, { message: "invalid or expired GitHub installation state" });
    }
    requireGitHubStateCookie(c, state);
    const grant = await requireAccessGrant(c, deps, statePayload.workspaceId, "github:manage");
    if (grant.accountId !== statePayload.accountId) {
      throw new HTTPException(403, { message: "GitHub installation state does not match this workspace" });
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
        throw new HTTPException(409, { message: JSON.stringify({ message: "GitHub App is not configured", missing: ["OPENGENI_GITHUB_CLIENT_ID"] }) });
      }
      const oauthState = createSignedState(githubStateSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        installationId,
      });
      const baseUrl = (settings.githubAppManifestBaseUrl ?? settings.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
      setGitHubStateCookie(c, deps, oauthState);
      return c.redirect(githubOAuthAuthorizeUrl({
        clientId,
        state: oauthState,
        redirectUri: `${baseUrl}/v1/github/oauth/callback`,
      }));
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
    const installationId = parsePositiveInteger(String(statePayload?.installationId ?? ""));
    if (!statePayload || typeof statePayload.accountId !== "string" || typeof statePayload.workspaceId !== "string" || installationId === null) {
      throw new HTTPException(400, { message: "invalid or expired GitHub OAuth state" });
    }
    requireGitHubStateCookie(c, state);
    return await completeGitHubInstallationBinding(deps, c, {
      code,
      statePayload,
      installationId,
    });
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
    throw new HTTPException(403, { message: "GitHub installation state does not match this workspace" });
  }
  try {
    const installation = await verifyGitHubInstallationAccessForUser(settings, { code: input.code, installationId: input.installationId });
    if (!installation) {
      throw new HTTPException(404, { message: "GitHub App installation was not found for this app" });
    }
    if (installation.suspended) {
      throw new HTTPException(409, { message: "GitHub App installation is suspended" });
    }
    await upsertGitHubInstallation(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      installationId: input.installationId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    });
    const returnUrl = openGeniReturnUrl(settings, c, input.statePayload.workspaceId);
    deleteCookie(c, githubStateCookie, { path: "/v1/github" });
    return c.html(githubSetupSuccessHtml(installation.accountLogin ?? `installation ${input.installationId}`, returnUrl));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
}

function setGitHubStateCookie(c: Context, deps: ApiRouteDeps, state: string): void {
  setCookie(c, githubStateCookie, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c, deps),
    path: "/v1/github",
    maxAge: stateMaxAgeSeconds,
  });
}

function requireGitHubStateCookie(c: Context, state: string): void {
  if (getCookie(c, githubStateCookie) !== state) {
    throw new HTTPException(400, { message: "invalid or expired GitHub installation browser state" });
  }
}

function isSecureRequest(c: Context, deps: ApiRouteDeps): boolean {
  return deps.settings.publicBaseUrl?.startsWith("https://")
    || c.req.header("x-forwarded-proto") === "https"
    || new URL(c.req.url).protocol === "https:";
}

export async function listWorkspaceGitHubRepositories(deps: ApiRouteDeps, workspaceId: string) {
  const installationIds = await listGitHubInstallationIdsForWorkspace(deps.db, workspaceId);
  return await listGitHubAppRepositories(deps.settings, { installationIds });
}

function githubSuccessHtml(envLines: string[], installUrl: string): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  const install = installUrl ? `<a class="button secondary" href="${escapeHtml(installUrl)}">Install on repositories</a>` : "";
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
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

function openGeniReturnUrl(settings: ApiRouteDeps["settings"], c: Context, workspaceId: string | undefined): string {
  const base = (settings.publicBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
  const url = new URL(base || new URL(c.req.url).origin);
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  return url.toString();
}
