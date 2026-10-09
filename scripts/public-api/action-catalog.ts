/**
 * The organization MCP server's action catalog: every API route a person can
 * use, as one callable action. It starts from every route the API registers
 * (all deployment flags on), takes names and schemas from the public surface
 * manifest where it has them, and leaves out only the exemptions below.
 * Regenerate with `bun scripts/public-api/action-catalog.ts --write`; a test
 * fails when a registered route is neither in the catalog nor exempt.
 */
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";

import { createApp } from "../../apps/api/src/app";
import surface from "./surface.gen.json";

export type { ActionCatalogEntry } from "../../apps/api/src/mcp/action-catalog-types";
import type { ActionCatalogEntry } from "../../apps/api/src/mcp/action-catalog-types";

/**
 * Routes that are not actions a person takes, each with the reason. Provider
 * consent steps stay in the catalog: an agent calling one is told to finish it
 * in the browser.
 */
export const ACTION_CATALOG_EXEMPTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/v1\/auth\//, reason: "Opengeni sign-in itself" },
  {
    pattern: /^\/v1\/native-app\//,
    reason: "signing the native app in and out, and its push device: the app's own credential",
  },
  { pattern: /^\/v1\/identity(\/|$)/, reason: "sign-in methods and account recovery" },
  { pattern: /^\/v1\/mcp-connections\//, reason: "approving an agent sign-in" },
  {
    pattern: /^\/v1\/organizations\/:organizationId\/mcp-connections/,
    reason: "managing connected agents: an agent can't widen its own access",
  },
  {
    pattern: /\/callback$|^\/v1\/(pr-review\/)?github\/setup$|\/client-metadata\.json$/,
    reason: "a provider's browser redirect back to Opengeni",
  },
  {
    pattern: /^\/v1\/webhooks\/|^\/v1\/integrations\/slack\/(commands|events|interactions)$/,
    reason: "calls from other services, signed by them",
  },
  { pattern: /^\/v1\/git\//, reason: "git protocol for sandboxes" },
  { pattern: /^\/v1\/enrollments\//, reason: "a machine enrolling itself" },
  { pattern: /^\/v1\/(analytics-consent|client-errors)$/, reason: "browser telemetry" },
  { pattern: /^\/v1\/catalog-assets\//, reason: "static files" },
];

export function isActionCatalogExempt(path: string): boolean {
  return ACTION_CATALOG_EXEMPTIONS.some((exemption) => exemption.pattern.test(path));
}

/**
 * Registered actions no MCP caller can ever complete: they need the person's
 * own Opengeni browser session, which neither a connected agent (MCP OAuth)
 * nor an organization API key has. They stay in the catalog, so every route is
 * accounted for, but the MCP server hides them from search and describe and a
 * direct call answers with this reason instead of a bare 401. Matched against
 * "METHOD /path".
 */
export const ACTION_CATALOG_BROWSER_ONLY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^\w+ \/v1\/inbox(\/|$)/,
    reason: "the person's inbox requires their own signed-in browser session",
  },
  {
    pattern:
      /^(POST \/v1\/organizations(\/additional)?|GET \/v1\/organization-(memberships|invitations)|POST \/v1\/organization-invitations\/:invitationId\/accept)$/,
    reason:
      "it acts on the person's own account across organizations (creating an organization, listing their memberships or invitations, accepting an invitation), and a connection is limited to one organization",
  },
  {
    pattern: /^\w+ \/v1\/organizations\/:organizationId\/recovery(\/|$)/,
    reason: "organization recovery is a ceremony in the person's own browser session",
  },
  {
    pattern: /^\w+ \/v1\/workspaces\/:workspaceId\/identity-links(\/|$)/,
    reason:
      "linking a product user to an Opengeni account is confirmed by that person signed in to Opengeni, or started by the embedding product as its user",
  },
];

export function actionCatalogBrowserOnlyReason(method: string, path: string): string | undefined {
  const key = `${method} ${path}`;
  return ACTION_CATALOG_BROWSER_ONLY.find((rule) => rule.pattern.test(key))?.reason;
}

export type RegisteredRoute = { method: string; path: string };

/**
 * Every callable /v1 route the API registers, with every route-gating flag on,
 * in both managed and configured deployments. Middleware and catch-all mounts
 * (including the MCP servers themselves) are not actions.
 */
export function registeredApiRoutes(): RegisteredRoute[] {
  const seen = new Map<string, RegisteredRoute>();
  for (const productAccessMode of ["managed", "configured"] as const) {
    const settings = testSettings({
      authRequired: true,
      accessKey: "action-catalog",
      productAccessMode,
      betterAuthSecret: "action-catalog-inventory-secret-32-bytes",
      publicBaseUrl: "http://opengeni.test",
      integrationsEnabled: true,
      codexSubscriptionEnabled: true,
      supergrokSubscriptionEnabled: true,
      claudeSubscriptionEnabled: true,
      sandboxSelfhostedEnabled: true,
      sandboxDesktopEnabled: true,
      streamControlEnabled: true,
      mcpOauthEnabled: true,
    });
    const observability = createObservability(settings, { component: "api" });
    observability.info = () => undefined;
    observability.warn = () => undefined;
    const app = createApp({
      settings,
      observability,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    for (const route of app.routes) {
      if (route.method === "ALL" || route.handler.length >= 2) continue;
      if (!route.path.startsWith("/v1/")) continue;
      seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
    }
  }
  return [...seen.values()];
}

/** SDK helpers that wrap many routes; they never name one action. */
const GENERIC_SDK_NAMES = new Set([
  "createSessionProxyHandler",
  "connectTransport",
  "forWorkspace",
]);

/**
 * SDK methods that read a route through an opt-in query variant. The route's
 * plain method names the action: `findGoal` is `getGoal` with `?absent=null`.
 */
const QUERY_VARIANT_SDK_NAMES = new Set(["findGoal"]);

type ManifestRoute = {
  method: string;
  path: string;
  sdk: string[];
  request: string[];
  response: string[];
};

export function buildActionCatalog(
  registered: ReadonlyArray<RegisteredRoute>,
  manifest: ReadonlyArray<ManifestRoute> = surface.routes,
): ActionCatalogEntry[] {
  const described = new Map(manifest.map((route) => [`${route.method} ${route.path}`, route]));
  const keys = new Set(registered.map((route) => `${route.method} ${route.path}`));
  for (const route of manifest) keys.add(`${route.method} ${route.path}`);
  const included = [...keys]
    .map((key) => {
      const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
      const route = described.get(key);
      return {
        method,
        path,
        sdk: route?.sdk ?? [],
        request: route?.request ?? [],
        response: route?.response ?? [],
      };
    })
    .filter((route) => !isActionCatalogExempt(route.path));
  const preferred = included.map((route) => {
    const names = route.sdk.map((name) => name.split(".").pop()!);
    return (
      names.find((name) => !GENERIC_SDK_NAMES.has(name) && !QUERY_VARIANT_SDK_NAMES.has(name)) ??
      names[0] ??
      null
    );
  });
  const counts = new Map<string, number>();
  for (const name of preferred) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  return included
    .map((route, index) => {
      const name = preferred[index];
      const browserOnly = actionCatalogBrowserOnlyReason(route.method, route.path);
      return {
        id: name && counts.get(name) === 1 ? name : `${route.method} ${route.path}`,
        method: route.method,
        path: route.path,
        request: [...route.request],
        response: [...route.response],
        ...(browserOnly ? { browserOnly } : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function renderActionCatalog(entries: ActionCatalogEntry[]): string {
  return `// Generated by scripts/public-api/action-catalog.ts from the registered API routes. Do not edit.
import type { ActionCatalogEntry } from "./action-catalog-types";

export const ACTION_CATALOG: readonly ActionCatalogEntry[] = ${JSON.stringify(entries, null, 2)};
`;
}

export const ACTION_CATALOG_PATH = new URL(
  "../../apps/api/src/mcp/action-catalog.gen.ts",
  import.meta.url,
);

if (import.meta.main && process.argv.includes("--write")) {
  await Bun.write(
    ACTION_CATALOG_PATH,
    renderActionCatalog(buildActionCatalog(registeredApiRoutes())),
  );
  console.log(`[action-catalog] wrote ${ACTION_CATALOG_PATH.pathname}`);
}
