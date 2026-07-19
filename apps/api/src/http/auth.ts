import type { Settings } from "@opengeni/config";
import type { Context, MiddlewareHandler } from "hono";
import { installExactPaths, isInstallRedirectPath } from "../routes/install";

const githubConnectPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/connect$/;

// A newly-installed Connected Machine has neither a user session nor the shared
// deployment key. These exact POST endpoints have their own bootstrap credential
// (a device code, enroll token, or enrollment bearer) and are deliberately the
// only enrollment routes that may cross the deployment-key perimeter.
const enrollmentBootstrapRoutes = new Set([
  "POST /v1/enrollments/device/start",
  "POST /v1/enrollments/device/poll",
  "POST /v1/enrollments/token/exchange",
  "POST /v1/enrollments/self/refresh",
  "POST /v1/enrollments/self/revoke",
]);

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
  if (enrollmentBootstrapRoutes.has(`${c.req.method.toUpperCase()} ${path}`)) {
    return true;
  }
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
