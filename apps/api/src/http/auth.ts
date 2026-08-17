import { resolveFirstPartyDelegationSecret, type Settings } from "@opengeni/config";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { installExactPaths, isInstallRedirectPath } from "../routes/install";

const githubConnectPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/connect$/;
const githubInstallationLinkPathPattern = /^\/v1\/workspaces\/[^/]+\/github\/installations$/;
const lensWebhookPathPattern =
  /^\/v1\/webhooks\/lens\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (await isAuthorized(c, settings)) {
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
  if (c.req.method === "POST" && lensWebhookPathPattern.test(path)) {
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
    path === "/v1/integrations/provider-oauth/callback" ||
    path === "/v1/integrations/google-drive/callback" ||
    path === "/v1/integrations/oauth/client-metadata.json" ||
    path === "/v1/integrations/slack/callback" ||
    path === "/v1/integrations/slack/events" ||
    path === "/v1/integrations/slack/commands" ||
    path === "/v1/integrations/slack/interactions" ||
    // Fiken OAuth browser redirect: exact path only, protected by signed
    // single-use state plus a callback-time grant recheck.
    path === "/v1/integrations/fiken/callback"
  ) {
    return true;
  }
  // Social OAuth (X / Reddit) browser redirect: exact path only, protected by
  // signed single-use state plus a callback-time grant recheck.
  if (path === "/v1/social/oauth/callback") {
    return true;
  }
  // Catalog logos are rendered via bare <img> tags, which carry no credentials;
  // the images are public vendor logos, digest-keyed by content, and the route
  // itself enforces the catalog-assets/ prefix lock and extension whitelist.
  if (path.startsWith("/v1/catalog-assets/")) {
    return true;
  }
  // The GitHub owner-consent entry remains public like the callbacks above; it
  // verifies fresh signed workspace-bound state before redirecting to GitHub.
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
  if (
    settings.authAllowHealth &&
    (path === "/healthz" || path === "/readyz" || path === "/traffic-readyz")
  ) {
    return true;
  }
  if (settings.authAllowMetrics && path === "/metrics") {
    return true;
  }
  return false;
}

async function isAuthorized(c: Context, settings: Settings): Promise<boolean> {
  const expected = settings.accessKey;
  const explicit = c.req.header("x-opengeni-access-key");
  if (expected && constantTimeEqual(explicit, expected)) {
    return true;
  }
  const authorization = c.req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (expected && constantTimeEqual(bearer, expected)) {
    return true;
  }

  // This middleware is only the deployment perimeter. A valid first-party
  // delegated bearer is already authenticated with the deployment's separate
  // delegation authority, so admit it only to the product API's route-level
  // access resolver. Deployment-only surfaces such as /metrics still require
  // the static deployment key. The resolver enforces exact account, workspace,
  // principal, and permissions; attempt-bound surfaces add live-attempt fences.
  const delegationSecret = resolveFirstPartyDelegationSecret(settings);
  return Boolean(
    c.req.path.startsWith("/v1/") &&
    bearer &&
    delegationSecret &&
    (await verifyDelegatedAccessToken(delegationSecret, bearer)),
  );
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
