/**
 * The organization MCP server's action catalog: every API route a person can
 * use, as one callable action. It starts from every route the API registers
 * (all deployment flags on), takes names and schemas from the public surface
 * manifest where it has them, and leaves out only the exemptions below.
 * Regenerate with `bun scripts/public-api/action-catalog.ts --write`; a test
 * fails when a registered route is neither in the catalog nor exempt.
 */
import * as contracts from "@opengeni/contracts";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { parseSync } from "oxc-parser";
import { z } from "zod";

import { createApp } from "../../apps/api/src/app";
import surface from "./surface.gen.json";
import { ACTION_SCHEMA_IMPORTS_PATH, renderActionSchemaImports } from "./action-schema-imports";
import { actionSecretFields } from "./action-secrets";

export type { ActionCatalogEntry } from "../../packages/contracts/src/app-action-catalog-types";
import type { ActionCatalogEntry } from "../../packages/contracts/src/app-action-catalog-types";

/**
 * Routes that are not actions a person takes, each with the reason. Provider
 * consent steps stay in the catalog: an agent calling one is told to finish it
 * in the browser.
 */
export const ACTION_CATALOG_EXEMPTIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/v1\/auth\//, reason: "Opengeni sign-in itself" },
  {
    pattern: /^\/v1\/site-auth\//,
    reason: "signing a person in to a published Site, from their own signed-in browser",
  },
  {
    pattern: /^\/v1\/site-runtime(\/|$)/,
    reason: "published Site gateway calls, signed by the gateway",
  },
  {
    pattern: /^\/v1\/native-app\//,
    reason: "signing the native app in and out, and its push device: the app's own credential",
  },
  { pattern: /^\/v1\/identity(\/|$)/, reason: "sign-in methods and account recovery" },
  {
    pattern: /\/callback$|^\/v1\/(pr-review\/)?github\/setup$|\/client-metadata\.json$/,
    reason: "a provider's browser redirect back to Opengeni",
  },
  {
    pattern:
      /^\/v1\/webhooks\/|^\/v1\/integrations\/(slack\/(commands|events|interactions)|teams\/messages)$/,
    reason: "calls from other services, signed by them",
  },
  { pattern: /^\/v1\/git\//, reason: "git protocol for sandboxes" },
  { pattern: /^\/v1\/enrollments\//, reason: "a machine enrolling itself" },
  {
    pattern: /^\/v1\/office\/workbook-tickets$/,
    reason: "the Office add-in connecting its own workbook socket",
  },
  { pattern: /^\/v1\/(analytics-consent|client-errors)$/, reason: "browser telemetry" },
  { pattern: /^\/v1\/catalog-assets\//, reason: "static files" },
  {
    pattern:
      /^\/v1\/workspaces\/:workspaceId\/(recordings|recording-people|recording-models)(\/|$)/,
    reason: "meeting recordings reach agents through the meetings_search and meeting_read tools",
  },
];

export function isActionCatalogExempt(path: string): boolean {
  return ACTION_CATALOG_EXEMPTIONS.some((exemption) => exemption.pattern.test(path));
}

/**
 * Registered actions no MCP caller can ever complete: they act on the
 * person's own account across organizations, or are an identity ceremony in
 * their own signed-in browser, which neither a connected agent (MCP OAuth),
 * an agent with session admin access nor an organization API key has. They
 * stay in the catalog, so every route is accounted for, but the MCP server
 * hides them from search and describe and a direct call answers with this
 * reason instead of a bare 401. Everything else an agent with the person's
 * full access can do as them. Matched against "METHOD /path".
 */
export const ACTION_CATALOG_BROWSER_ONLY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /^(PUT|DELETE) \/v1\/workspaces\/:workspaceId\/integrations\/teams\/bot$|^(POST|DELETE) \/v1\/workspaces\/:workspaceId\/integrations\/teams\/link$/,
    reason:
      "connecting or disconnecting Teams and linking an account requires the person's own signed-in Opengeni browser",
  },
  {
    pattern:
      /^(POST \/v1\/organizations(\/additional)?|GET \/v1\/organization-(memberships|invitations)|POST \/v1\/organization-invitations\/:invitationId\/accept)$/,
    reason:
      "it acts on the person's own account across organizations (creating an organization, listing their memberships or invitations, accepting an invitation), and an agent works in one organization",
  },
  {
    pattern: /^\w+ \/v1\/organizations\/:organizationId\/recovery(\/|$)/,
    reason:
      "organization recovery is for when someone can't sign in, so each step is proven by that person's own browser sign-in",
  },
  {
    pattern: /^\w+ \/v1\/workspaces\/:workspaceId\/identity-links(\/|$)/,
    reason:
      "linking a product user to an Opengeni account is confirmed by that person signed in to Opengeni, or started by the embedding product as its user",
  },
  {
    pattern: /^PUT \/v1\/workspaces\/:workspaceId\/sessions\/:sessionId\/usage-limit$/,
    reason:
      "a task's usage limit bounds what agents may spend, so only a person in the Opengeni app or the embedding product's server can change it, never an agent",
  },
];

export function actionCatalogBrowserOnlyReason(method: string, path: string): string | undefined {
  const key = `${method} ${path}`;
  return ACTION_CATALOG_BROWSER_ONLY.find((rule) => rule.pattern.test(key))?.reason;
}

/** A registered route and the source of its handlers, which name its inputs. */
export type RegisteredRoute = { method: string; path: string; sources?: readonly string[] };

/** What a route reads from the request, as its handler source shows. */
export type RouteInputs = {
  body: string[];
  query: string[];
  queryParameters: string[];
  /** The replacement a retired route names (`routeRetired("METHOD /path", ...)`). */
  retired?: string;
  /** The workspace permission the handler's first access check requires. */
  permission?: string;
};

/**
 * Request bodies neither the handler source nor the SDK names, because the
 * handler reads loose fields itself or hands the request to a shared helper.
 * Matched against "METHOD /path"; each names a schema exported by
 * @opengeni/contracts that the route accepts. A test keeps every entry needed.
 */
export const ACTION_REQUEST_SCHEMAS: ReadonlyArray<{ pattern: RegExp; request: string }> = [
  {
    pattern: /^PATCH \/v1\/\w+\/:\w+\/codex\/accounts\/:accountId$/,
    request: "SubscriptionAccountRenameRequest",
  },
  {
    pattern: /^PATCH \/v1\/workspaces\/:workspaceId\/codex\/settings$/,
    request: "SubscriptionRotationSettingsRequest",
  },
  {
    pattern: /^POST \/v1\/\w+\/:\w+\/codex\/connect\/poll$/,
    request: "SubscriptionConnectPollRequest",
  },
  {
    pattern: /^POST \/v1\/workspaces\/:workspaceId\/codex\/apps$/,
    request: "CodexAppsDesignationRequest",
  },
];

export function fallbackRequestSchemas(method: string, path: string): string[] {
  const key = `${method} ${path}`;
  const match = ACTION_REQUEST_SCHEMAS.find((rule) => rule.pattern.test(key));
  return match ? [match.request] : [];
}

const CONTRACTS = contracts as Record<string, unknown>;

function contractSchema(name: string): z.ZodType | null {
  const candidate = CONTRACTS[name];
  return candidate instanceof z.ZodType ? candidate : null;
}

// oxc-parser's ESTree nodes, loosely typed: only a few fields are read.
type AstNode = { type: string; [key: string]: any };

function astNodes(root: unknown): AstNode[] {
  const nodes: AstNode[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as AstNode;
    if (typeof node.type === "string") nodes.push(node);
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(root);
  return nodes;
}

function calleeName(call: AstNode): string | null {
  const callee = call.callee;
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return null;
}

function propertyName(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/** `<context>.req.query("name")`, `<context>.req.queries()` and the like. */
function requestQueryCall(call: AstNode): boolean {
  const callee = call.callee;
  return (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    (callee.property.name === "query" || callee.property.name === "queries") &&
    callee.object?.type === "MemberExpression" &&
    !callee.object.computed &&
    callee.object.property.name === "req"
  );
}

/** Top-level keys of an inline `z.object({...})` schema, through chained calls. */
function inlineObjectKeys(node: AstNode | undefined): string[] {
  let current = node;
  while (current?.type === "CallExpression") {
    const callee = current.callee;
    if (
      callee?.type === "MemberExpression" &&
      callee.property?.name === "object" &&
      current.arguments[0]?.type === "ObjectExpression"
    ) {
      return objectKeys(current.arguments[0]);
    }
    current = callee?.type === "MemberExpression" ? callee.object : undefined;
  }
  return [];
}

function objectKeys(node: AstNode | undefined): string[] {
  if (node?.type !== "ObjectExpression" && node?.type !== "ObjectPattern") return [];
  return node.properties.flatMap((property: AstNode) =>
    property.type === "Property" && !property.computed ? [propertyName(property.key)!] : [],
  );
}

/**
 * The inputs a route reads, from its handler source. Routes validate client
 * input with `parseRequestJson(c, Schema)`, `parseRequestBody(Schema, body)`
 * and `parseRequestQuery(Schema, query)` (apps/api/src/http/request-body.ts),
 * or a route-local helper that takes the context and a schema
 * (`parseBody(c, Schema)`), and read query parameters with
 * `c.req.query("name")` or from `c.req.query()`. Only body and query schemas
 * exported by @opengeni/contracts count: those are the ones describe can show.
 */
export function routeInputs(sources: readonly string[]): RouteInputs {
  const body: string[] = [];
  const looseBody: string[] = [];
  const query: string[] = [];
  const queryParameters = new Set<string>();
  let retired: string | undefined;
  for (const source of sources) {
    const parsed = parseSync("handler.js", `(${source});`);
    if (parsed.errors.length > 0) continue;
    const nodes = astNodes(parsed.program);
    const handler = nodes.find(
      (node) =>
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression" ||
        node.type === "FunctionDeclaration",
    );
    const context = handler?.params?.[0]?.type === "Identifier" ? handler.params[0].name : null;
    const readsBody = nodes.some(
      (node) =>
        node.type === "CallExpression" &&
        (calleeName(node) === "readRequestJson" ||
          (calleeName(node) === "json" &&
            node.callee.object?.type === "MemberExpression" &&
            node.callee.object.property?.name === "req")),
    );
    // Values bound to the whole query (`const query = c.req.query()`).
    const queryBindings = new Set<string>();
    for (const node of nodes) {
      if (node.type === "VariableDeclarator" && node.init?.type === "CallExpression") {
        if (requestQueryCall(node.init) && node.init.arguments.length === 0) {
          if (node.id.type === "Identifier") queryBindings.add(node.id.name);
          for (const key of objectKeys(node.id)) queryParameters.add(key);
        }
      }
      if (node.type !== "CallExpression") continue;
      const name = calleeName(node);
      const [first, second] = node.arguments as AstNode[];
      if (name === "routeRetired") {
        if (first?.type === "Literal" && typeof first.value === "string") retired = first.value;
        continue;
      }
      if (requestQueryCall(node)) {
        const parameter = propertyName(first);
        if (first?.type === "Literal" && parameter) queryParameters.add(parameter);
        continue;
      }
      if (name === "parseRequestQuery") {
        if (first?.type === "Identifier" && contractSchema(first.name)) {
          query.push(first.name);
          const schema = contractSchema(first.name);
          if (schema instanceof z.ZodObject) {
            for (const key of Object.keys(schema.shape)) queryParameters.add(key);
          }
        }
        for (const key of inlineObjectKeys(first)) queryParameters.add(key);
        continue;
      }
      // `parseRequestBody` also validates values a route assembles from its
      // path, so it names the body only when the handler reads one.
      if (name === "parseRequestBody" && first?.type === "Identifier" && readsBody) {
        if (contractSchema(first.name)) looseBody.push(first.name);
        continue;
      }
      if (
        context &&
        first?.type === "Identifier" &&
        first.name === context &&
        second?.type === "Identifier" &&
        contractSchema(second.name)
      ) {
        body.push(second.name);
      }
    }
    for (const node of nodes) {
      if (
        node.type === "MemberExpression" &&
        node.object?.type === "Identifier" &&
        queryBindings.has(node.object.name)
      ) {
        const key = node.computed ? propertyName(node.property) : node.property.name;
        if (key) queryParameters.add(key);
      }
    }
  }
  return {
    body: [...new Set([...body, ...looseBody])].slice(0, 1),
    query: [...new Set(query)],
    queryParameters: [...queryParameters].sort(),
    ...(retired ? { retired } : {}),
    ...gatePermission(sources),
  };
}

/** The shared access checks that take the permission a route needs as their last argument. */
const ACCESS_GATES = new Set([
  "requireAccessGrant",
  "requireAccessGrantAuthorization",
  "requireFreshAccessGrant",
  "requireMachineAccessGrant",
]);

/**
 * Timing wrappers a route may run its access check inside (`await
 * measureInsightsPhase(observe, "auth", () => requireAccessGrant(...))`).
 * Only these count: each always calls the work it is given, exactly once,
 * and passes on its refusal, so the check can't be skipped. A test runs each
 * one to keep that true; an unlisted wrapper names no permission.
 */
export const ACCESS_GATE_WRAPPERS: ReadonlySet<string> = new Set([
  "measureInsightsPhase",
  "measureSessionCreatePhase",
]);

/**
 * Route-local access helpers that take an operation name rather than a
 * permission (`await authorize(c, deps, "read")`), with the permission each
 * operation needs a person in the workspace to hold first, or null for none.
 * The usage and allowance routes (apps/api/src/routes/usage-allowances.ts):
 * reading the workspace's usage or budget and setting a member's allowance
 * need workspace:admin, setting the workspace budget needs an organization
 * admin, and reading one's own usage needs nothing. Organization keys have
 * their own way in; the route's own checks still decide. A test keeps the
 * operations equal to that file's `Operation` type and checks that every
 * route calling the helper gets its operation's permission.
 */
export const ACCESS_GATE_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, string | null>>>
> = {
  authorize: {
    read: "workspace:admin",
    "budget-read": "workspace:admin",
    "member-write": "workspace:admin",
    "workspace-write": "account:admin",
    own: null,
  },
};

/** The permission an access-check call names: a shared gate's last argument, or a helper operation's. */
function gateCallPermission(call: AstNode): string | null {
  const name = calleeName(call) ?? "";
  const args = call.arguments as AstNode[];
  const last = args.at(-1);
  const literal = last?.type === "Literal" && typeof last.value === "string" ? last.value : null;
  if (literal === null) return null;
  const operations = ACCESS_GATE_OPERATIONS[name];
  const permission = ACCESS_GATES.has(name)
    ? literal
    : operations && args.length === 3 && Object.hasOwn(operations, literal)
      ? operations[literal]!
      : null;
  return permission !== null && contracts.Permission.safeParse(permission).success
    ? permission
    : null;
}

function isGateCall(call: AstNode): boolean {
  const name = calleeName(call) ?? "";
  return (
    ACCESS_GATES.has(name) ||
    (Object.hasOwn(ACCESS_GATE_OPERATIONS, name) && (call.arguments as AstNode[]).length === 3)
  );
}

/**
 * The permission a route requires before it does anything else: the one its
 * handler passes to a shared access check (`await requireAccessGrant(c, deps,
 * workspaceId, "sessions:read")`) or the operation it passes to a listed
 * helper (`await authorize(c, deps, "read")`), in its opening declarations
 * and statements, before any branch, return or throw that could skip it. The
 * check may open a `try { } finally { }` block (no `catch` that could swallow
 * its refusal), or be what the arrow function given to a listed wrapper
 * returns. Every handler of the route must name the same one. Anything less
 * certain names none.
 */
function gatePermission(sources: readonly string[]): { permission?: string } {
  const gateCall = (expression: AstNode | null | undefined): AstNode | null => {
    const call = expression?.type === "AwaitExpression" ? expression.argument : expression;
    if (call?.type !== "CallExpression") return null;
    if (isGateCall(call)) return call;
    if (expression?.type !== "AwaitExpression" || !ACCESS_GATE_WRAPPERS.has(calleeName(call) ?? ""))
      return null;
    for (const argument of call.arguments as AstNode[]) {
      if (argument.type !== "ArrowFunctionExpression" || argument.body?.type === "BlockStatement")
        continue;
      const inner = gateCall(argument.body);
      if (inner) return inner;
    }
    return null;
  };
  // The gate's permission; null when something before it could skip it or it
  // names none; undefined when these statements hold no gate at all.
  const scan = (statements: readonly AstNode[]): string | null | undefined => {
    for (const statement of statements) {
      if (statement.type === "TryStatement")
        return statement.handler ? null : (scan(statement.block.body) ?? null);
      const expressions =
        statement.type === "VariableDeclaration"
          ? (statement.declarations as AstNode[]).map((declarator) => declarator.init)
          : statement.type === "ExpressionStatement"
            ? [statement.expression]
            : null;
      if (!expressions) return null;
      for (const expression of expressions) {
        const call = expression?.type === "AwaitExpression" ? gateCall(expression) : null;
        if (!call) continue;
        return gateCallPermission(call);
      }
    }
    return undefined;
  };
  const found = sources.map((source) => {
    const parsed = parseSync("handler.js", `(${source});`);
    if (parsed.errors.length > 0) return null;
    const handler = astNodes(parsed.program).find(
      (node) => node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression",
    );
    if (handler?.body?.type !== "BlockStatement") return null;
    return scan(handler.body.body as AstNode[]) ?? null;
  });
  const [first] = found;
  return first && found.every((permission) => permission === first) ? { permission: first } : {};
}

/**
 * Response bodies the public surface manifest can't name because the SDK
 * types them by hand, matched against "METHOD /path". Each names a schema
 * exported by @opengeni/contracts that describes what the route returns, so
 * a secret in it (a sign-in code) marks the action.
 */
export const ACTION_RESPONSE_SCHEMAS: ReadonlyArray<{ pattern: RegExp; response: string }> = [
  {
    pattern: /^POST \/v1\/\w+\/:\w+\/(codex|supergrok)\/connect\/start$/,
    response: "SubscriptionDeviceSignInStart",
  },
];

function inlineResponseSchemas(method: string, path: string): string[] {
  const key = `${method} ${path}`;
  const match = ACTION_RESPONSE_SCHEMAS.find((rule) => rule.pattern.test(key));
  return match ? [match.response] : [];
}

/**
 * Every callable /v1 route the API registers, with every route-gating flag on,
 * in both managed and configured deployments. Middleware and catch-all mounts
 * (including the MCP servers themselves) are not actions.
 */
export function registeredApiRoutes(): RegisteredRoute[] {
  const seen = new Map<string, { method: string; path: string; sources: string[] }>();
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
      const key = `${route.method} ${route.path}`;
      const known = seen.get(key) ?? { method: route.method, path: route.path, sources: [] };
      const source = route.handler.toString();
      if (!known.sources.includes(source)) known.sources.push(source);
      seen.set(key, known);
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
  const sources = new Map(
    registered.map((route) => [`${route.method} ${route.path}`, route.sources ?? []] as const),
  );
  const keys = new Set(sources.keys());
  for (const route of manifest) keys.add(`${route.method} ${route.path}`);
  const included = [...keys]
    .map((key) => {
      const [method, path] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
      const route = described.get(key);
      const inputs = routeInputs(sources.get(key) ?? []);
      const reads = method === "GET" || method === "HEAD";
      // What the handler validates is the action's input; the SDK's parameter
      // types name it only where the handler shows nothing.
      const derived = reads ? inputs.query : inputs.body;
      const manifested = route?.request ?? [];
      const request =
        derived.length > 0
          ? derived
          : manifested.length > 0
            ? manifested
            : fallbackRequestSchemas(method, path);
      const response = route?.response ?? [];
      return {
        method,
        path,
        sdk: route?.sdk ?? [],
        request,
        query: inputs.queryParameters,
        retired: inputs.retired,
        permission: inputs.permission,
        response: response.length > 0 ? response : inlineResponseSchemas(method, path),
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
      const secretFields = actionSecretFields(route);
      return {
        id: name && counts.get(name) === 1 ? name : `${route.method} ${route.path}`,
        method: route.method,
        path: route.path,
        request: [...route.request],
        ...(route.query.length > 0 ? { query: [...route.query] } : {}),
        response: [...route.response],
        ...(browserOnly ? { browserOnly } : {}),
        ...(route.retired ? { retired: route.retired } : {}),
        ...(route.permission ? { permission: route.permission } : {}),
        ...(secretFields.length > 0 ? { secretFields } : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function renderActionCatalog(entries: ActionCatalogEntry[]): string {
  return `// Generated by scripts/public-api/action-catalog.ts from the registered API routes. Do not edit.
import type { ActionCatalogEntry } from "./app-action-catalog-types";

export const ACTION_CATALOG: readonly ActionCatalogEntry[] = ${JSON.stringify(entries, null, 2)};
`;
}

export const ACTION_CATALOG_PATH = new URL(
  "../../packages/contracts/src/app-action-catalog.gen.ts",
  import.meta.url,
);

if (import.meta.main && process.argv.includes("--write")) {
  const catalog = buildActionCatalog(registeredApiRoutes());
  await Bun.write(ACTION_CATALOG_PATH, renderActionCatalog(catalog));
  await Bun.write(ACTION_SCHEMA_IMPORTS_PATH, renderActionSchemaImports(catalog));
  console.log(`[action-catalog] wrote ${ACTION_CATALOG_PATH.pathname}`);
}
