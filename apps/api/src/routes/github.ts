import { GitHubAppManifestCreate } from "@infra-agents/contracts";
import {
  buildGitHubAppManifest,
  convertGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  GitHubAppApiError,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
  listGitHubAppRepositories,
  organizationAppManifestUrl,
  personalAppManifestUrl,
  verifySignedState,
} from "@infra-agents/github";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";

export function registerGitHubRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, githubStateSecret } = deps;

  app.get("/v1/github/app", (c) => {
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    return c.json({
      configured: missing.length === 0,
      appId: settings.githubAppId ?? null,
      clientId: settings.githubClientId ?? null,
      appSlug: slug,
      installUrl: slug ? `https://github.com/apps/${slug}/installations/new` : null,
      missing,
    });
  });

  app.get("/v1/github/repositories", async (c) => {
    try {
      return c.json({ repositories: await listGitHubAppRepositories(settings) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/github/repositories/sync", async (c) => {
    try {
      return c.json({ repositories: await listGitHubAppRepositories(settings) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new HTTPException(409, { message: JSON.stringify({ message: error.message, missing: error.missing }) });
      }
      throw new HTTPException(502, { message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/v1/github/app-manifest", async (c) => {
    const payload = GitHubAppManifestCreate.parse(await c.req.json());
    const baseUrl = (settings.githubAppManifestBaseUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    const state = createSignedState(githubStateSecret);
    const appName = payload.appName?.trim() || "Infra Agents";
    const manifest = buildGitHubAppManifest({
      appName,
      baseUrl,
      public: payload.public,
      includeCiPermissions: payload.includeCiPermissions,
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
      const installUrl = slug ? `https://github.com/apps/${slug}/installations/new` : "";
      return c.html(githubSuccessHtml(envLines, installUrl));
    } catch (error) {
      const message = error instanceof GitHubAppApiError ? error.message : String(error);
      throw new HTTPException(502, { message });
    }
  });
}

function githubSuccessHtml(envLines: string[], installUrl: string): string {
  const envText = envLines.join("\n");
  const escaped = escapeHtml(envText);
  const install = installUrl ? `<a href="${escapeHtml(installUrl)}">Install on repositories</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App Created</title><style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#f4f4f5}main{width:min(720px,calc(100vw - 32px));border:1px solid #27272a;border-radius:8px;padding:28px;background:#111114}pre{white-space:pre-wrap;word-break:break-word;background:#09090b;border:1px solid #27272a;border-radius:8px;padding:16px}a{color:#fafafa}</style></head><body><main><h1>GitHub App created</h1><p>Add these values to .env, then restart API and worker.</p><pre>${escaped}</pre>${install}</main></body></html>`;
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
