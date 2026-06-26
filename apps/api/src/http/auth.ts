import type { Settings } from "@opengeni/config";
import type { Context, MiddlewareHandler } from "hono";
import { installExactPaths, isInstallRedirectPath } from "../routes/install";

const githubConnectPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/connect$/;

export function requireAccessKey(settings: Settings): MiddlewareHandler {
  return async (c, next) => {
    if (!settings.authRequired || isAuthExempt(c, settings)) {
      await next();
      return;
    }
    if (isAuthorized(c, settings.accessKey)) {
      await next();
      return;
    }
    return c.json({ error: "unauthorized" }, 401);
  };
}

function isAuthExempt(c: Context, settings: Settings): boolean {
  if (c.req.method === "OPTIONS") {
    return true;
  }
  const path = new URL(c.req.url).pathname;
  if (path === "/v1/config/client") {
    return true;
  }
  if (path === "/v1/auth" || path.startsWith("/v1/auth/")) {
    return true;
  }
  if (path === "/v1/webhooks/stripe") {
    return true;
  }
  if (
    path === "/v1/github/setup" ||
    path === "/v1/github/install/callback" ||
    path === "/v1/github/oauth/callback" ||
    path === "/v1/github/app-manifest/callback"
  ) {
    return true;
  }
  // Browser entry for MCP-issued GitHub install links: opened in a browser
  // that holds no API credentials, like the callbacks above. The route itself
  // verifies the signed workspace-bound state before doing anything.
  if (githubConnectPathPattern.test(path)) {
    return true;
  }
  // The get.<domain> install-serving routes (install.sh/.ps1/uninstall.sh/
  // minisign pub + the release-binary redirects). Reached by a fresh machine
  // with no credentials; the bodies carry no secrets (dossier §23.1).
  if (installExactPaths.has(path) || isInstallRedirectPath(path)) {
    return true;
  }
  if (settings.authAllowHealth && path === "/healthz") {
    return true;
  }
  if (settings.authAllowMetrics && path === "/metrics") {
    return true;
  }
  return false;
}

function isAuthorized(c: Context, expected: string | undefined): boolean {
  if (!expected) {
    return false;
  }
  const explicit = c.req.header("x-opengeni-access-key");
  return constantTimeEqual(explicit, expected);
}

function constantTimeEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== "string") {
    return false;
  }
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    diff |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return diff === 0;
}
