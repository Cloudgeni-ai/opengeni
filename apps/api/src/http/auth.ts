import type { Settings } from "@opengeni/config";
import type { Context, MiddlewareHandler } from "hono";
import { installExactPaths, isInstallRedirectPath } from "../routes/install";

const githubConnectPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/connect$/;
const githubInstallationLinkPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/installations$/;

export function requireAccessKey(settings: Settings): MiddlewareHandler {
  return async (c, next) => {
    // §7.2 P1: requireAccessKey is the coarse NETWORK perimeter, not the
    // per-tenant identity gate (that is resolveAccessContext). When
    // `authRequired:false` it is a NO-OP — the embedded (Path 2) case where the
    // host's own auth is the sole human gate and OpenGeni is mounted behind it.
    // Standalone/separate deployments set `authRequired:true` to keep this ON as
    // the shared-deployment-key perimeter.
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
  if (
    path === "/v1/integrations/oauth/callback" ||
    path === "/v1/integrations/oauth/client-metadata.json"
  ) {
    return true;
  }
  // Catalog logos are rendered via bare <img> tags, which carry no credentials;
  // the images are public vendor logos, digest-keyed by content, and the route
  // itself enforces the catalog-assets/ prefix lock and extension whitelist.
  if (path.startsWith("/v1/catalog-assets/")) {
    return true;
  }
  // Compatibility entry for already-issued GitHub install/link URLs. It stays
  // public like the callbacks above, verifies signed workspace-bound state,
  // and then terminates with 410 while new installation binding is disabled.
  if (githubConnectPathPattern.test(path)) {
    return true;
  }
  // Compatibility endpoint for stale chooser submissions. It remains public
  // only so already-rendered forms can authenticate their signed account and
  // workspace state locally before terminating with 410; it does not parse a
  // ticket, resolve browser authority, or write an installation binding.
  if (c.req.method === "POST" && githubInstallationLinkPathPattern.test(path)) {
    return true;
  }
  // The get.<domain> install-serving routes (install.sh/.ps1/uninstall.sh/
  // minisign pub + the release-binary redirects). Reached by a fresh machine
  // with no credentials; the bodies carry no secrets.
  if (installExactPaths.has(path) || isInstallRedirectPath(path)) {
    return true;
  }
  if (settings.authAllowHealth && (path === "/healthz" || path === "/readyz")) {
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
  if (constantTimeEqual(explicit, expected)) {
    return true;
  }
  const authorization = c.req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return constantTimeEqual(bearer, expected);
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
