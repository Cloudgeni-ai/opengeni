/**
 * Nango-backed integrations (docs/nango.md).
 *
 * Nango is an optional, operator-controlled connection backend. A catalog
 * integration is served by exactly one backend at a time: its native
 * Opengeni connector or Nango. Nango connections are ordinary `oauth2` rows in
 * the `connections` table under the `nango:<integration key>` provider domain,
 * so a native connection can never satisfy a Nango-backed reference and the
 * reverse. Their encrypted credential holds only the Nango connection id and
 * provider config key; the Nango secret key stays in deployment settings.
 *
 * Everything here is pure and browser-safe, so the API, worker, runtime and
 * React share one definition of identities, destinations and pricing.
 */

export const NANGO_PROVIDER_DOMAIN_PREFIX = "nango:";
export const NANGO_DEFAULT_API_BASE_URL = "https://api.nango.dev";
export const NANGO_INTEGRATION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const NANGO_PROVIDER_CONFIG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
/** The setting may change at any time; readers keep it at most this long. */
export const INTEGRATION_BACKEND_CACHE_TTL_MS = 30_000;

export type IntegrationBackend = "native" | "nango";

export type NangoDestination = Readonly<{ origin: string; pathPrefix: string }>;

/** A Google connector whose reviewed REST bridge can run over the Nango proxy. */
export type NativeNangoIntegration = Readonly<{
  integrationKey: "gmail" | "google-calendar" | "google-drive";
  displayName: string;
  /** Provider domain of the native connections (the catalog connection identity). */
  nativeProviderDomain: string;
  /** The catalog MCP identity; stored as the Nango connection's `mcpUrl` metadata. */
  mcpUrl: string;
  destinations: readonly NangoDestination[];
  /** Read-only provider request that names the connected account. */
  accountIdentity: Readonly<{ url: string; field: string }>;
  /** The fixed scopes Nango's managed app grants, unless the definition lists others. */
  managedScopes: readonly string[];
}>;

export const NATIVE_NANGO_INTEGRATIONS: readonly NativeNangoIntegration[] = Object.freeze([
  Object.freeze({
    integrationKey: "gmail",
    displayName: "Gmail",
    nativeProviderDomain: "gmailmcp.googleapis.com",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    destinations: Object.freeze([
      Object.freeze({ origin: "https://gmail.googleapis.com", pathPrefix: "/gmail/v1/users/me/" }),
    ]),
    accountIdentity: Object.freeze({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      field: "emailAddress",
    }),
    managedScopes: Object.freeze(["https://mail.google.com/"]),
  }),
  Object.freeze({
    integrationKey: "google-calendar",
    displayName: "Google Calendar",
    nativeProviderDomain: "calendarmcp.googleapis.com",
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    destinations: Object.freeze([
      Object.freeze({ origin: "https://www.googleapis.com", pathPrefix: "/calendar/v3/" }),
    ]),
    accountIdentity: Object.freeze({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary",
      field: "id",
    }),
    managedScopes: Object.freeze(["https://www.googleapis.com/auth/calendar"]),
  }),
  Object.freeze({
    integrationKey: "google-drive",
    displayName: "Google Drive",
    nativeProviderDomain: "drivemcp.googleapis.com",
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
    destinations: Object.freeze([
      Object.freeze({ origin: "https://www.googleapis.com", pathPrefix: "/drive/v3/" }),
      Object.freeze({
        origin: "https://www.googleapis.com",
        pathPrefix: "/upload/drive/v3/files/",
      }),
    ]),
    accountIdentity: Object.freeze({
      url: "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
      field: "user.emailAddress",
    }),
    managedScopes: Object.freeze(["https://www.googleapis.com/auth/drive"]),
  }),
]);

/**
 * Integrations whose native Opengeni connector is not an MCP catalog row. When
 * one is Nango-backed, its native card and tools are hidden so the catalog
 * never lists the service twice.
 */
export const NANGO_REPLACEABLE_NATIVE_SOCIAL_PROVIDERS: Readonly<Record<string, string>> =
  Object.freeze({ x: "x" });

export function isNangoIntegrationKey(value: unknown): value is string {
  return typeof value === "string" && NANGO_INTEGRATION_KEY_PATTERN.test(value);
}

export function nangoProviderDomain(integrationKey: string): string {
  if (!isNangoIntegrationKey(integrationKey)) throw new Error("Invalid Nango integration key");
  return `${NANGO_PROVIDER_DOMAIN_PREFIX}${integrationKey}`;
}

export function nangoIntegrationKeyFromProviderDomain(
  domain: string | null | undefined,
): string | null {
  if (typeof domain !== "string") return null;
  const lower = domain.toLowerCase();
  if (!lower.startsWith(NANGO_PROVIDER_DOMAIN_PREFIX)) return null;
  const key = lower.slice(NANGO_PROVIDER_DOMAIN_PREFIX.length);
  return isNangoIntegrationKey(key) ? key : null;
}

export function isNangoProviderDomain(domain: string | null | undefined): boolean {
  return nangoIntegrationKeyFromProviderDomain(domain) !== null;
}

function canonicalMcpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function nativeNangoIntegrationByKey(key: string | null | undefined) {
  return NATIVE_NANGO_INTEGRATIONS.find((entry) => entry.integrationKey === key) ?? null;
}

export function nativeNangoIntegrationForMcpUrl(url: string | null | undefined) {
  const canonical = canonicalMcpUrl(url);
  if (!canonical) return null;
  return NATIVE_NANGO_INTEGRATIONS.find((entry) => entry.mcpUrl === canonical) ?? null;
}

/** The reviewed Google connector whose native or Nango connections a domain names. */
export function nativeNangoIntegrationForProviderDomain(domain: string | null | undefined) {
  if (typeof domain !== "string") return null;
  const lower = domain.toLowerCase();
  const key = nangoIntegrationKeyFromProviderDomain(lower);
  return (
    NATIVE_NANGO_INTEGRATIONS.find(
      (entry) => entry.nativeProviderDomain === lower || entry.integrationKey === key,
    ) ?? null
  );
}

/** Whether a provider URL is one of the exact destinations an integration may proxy. */
export function nangoDestinationAllowed(
  destinations: readonly NangoDestination[],
  destinationUrl: string | URL,
): boolean {
  let url: URL;
  try {
    url = new URL(destinationUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  return destinations.some(
    (destination) =>
      url.origin === destination.origin && url.pathname.startsWith(destination.pathPrefix),
  );
}

// ---------------------------------------------------------------------------
// Operator setting (the allowlist)
// ---------------------------------------------------------------------------

export type NangoToolSourceDefinition = {
  source: "nango";
  /** Only these tool names are offered when present. */
  allow?: string[];
  /** Names that are always treated as writes (Ask first by default). */
  write?: string[];
  /** Names that are always treated as reads (allowed by default). */
  read?: string[];
};

/** Optional, config-only description of an integration Nango alone serves. */
export type NangoIntegrationDefinition = {
  displayName?: string;
  description?: string;
  logoUrl?: string;
  /** Nango connections are always the connecting person's own account. */
  ownership?: "personal";
  /** Read-only provider request through the Nango proxy that names the account. */
  accountIdentity?: { url: string; field: string };
  tools?: NangoToolSourceDefinition;
  /** Fixed scopes the Nango-managed app grants. */
  scopes?: string[];
};

export type IntegrationBackendSetting = {
  integrationKey: string;
  backend: IntegrationBackend;
  providerConfigKey: string | null;
  enabled: boolean;
  definition: NangoIntegrationDefinition | null;
  revision: number;
  changedAt: string;
};

/** A Nango-backed integration the deployment currently offers. */
export type EffectiveNangoIntegration = {
  integrationKey: string;
  providerConfigKey: string;
  providerDomain: string;
  definition: NangoIntegrationDefinition;
  native: NativeNangoIntegration | null;
  revision: number;
};

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function toolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [
    ...new Set(
      value.filter((name): name is string => typeof name === "string" && TOOL_NAME.test(name)),
    ),
  ];
}

/**
 * Parse the stored definition leniently: unknown or malformed fields are
 * dropped (the SQL setter already validates shape), never fatal for a turn.
 */
export function parseNangoIntegrationDefinition(value: unknown): NangoIntegrationDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const definition: NangoIntegrationDefinition = {};
  const displayName = boundedText(raw.displayName, 120);
  if (displayName) definition.displayName = displayName;
  const description = boundedText(raw.description, 1000);
  if (description) definition.description = description;
  const logoUrl = boundedText(raw.logoUrl, 2048);
  if (logoUrl && /^https:\/\//u.test(logoUrl)) definition.logoUrl = logoUrl;
  if (raw.ownership === "personal") definition.ownership = "personal";
  const identity = raw.accountIdentity as Record<string, unknown> | undefined;
  const identityUrl = boundedText(identity?.url, 2048);
  const identityField = boundedText(identity?.field, 200);
  if (identityUrl && identityField && /^https:\/\//u.test(identityUrl))
    definition.accountIdentity = { url: identityUrl, field: identityField };
  const tools = raw.tools as Record<string, unknown> | undefined;
  if (tools && typeof tools === "object" && tools.source === "nango") {
    const allow = toolNames(tools.allow);
    const write = toolNames(tools.write);
    const read = toolNames(tools.read);
    definition.tools = {
      source: "nango",
      ...(allow ? { allow } : {}),
      ...(write ? { write } : {}),
      ...(read ? { read } : {}),
    };
  }
  if (Array.isArray(raw.scopes))
    definition.scopes = [
      ...new Set(
        raw.scopes.filter(
          (scope): scope is string => typeof scope === "string" && scope.length <= 512,
        ),
      ),
    ];
  return definition;
}

/**
 * The integrations served by Nango right now: configured deployment, an
 * enabled `nango` row with a provider config key. Everything else (no row,
 * `native`, disabled, or no secret key) is native or unavailable.
 */
export function effectiveNangoIntegrations(
  settings: readonly IntegrationBackendSetting[],
  nangoConfigured: boolean,
): Map<string, EffectiveNangoIntegration> {
  const result = new Map<string, EffectiveNangoIntegration>();
  if (!nangoConfigured) return result;
  for (const setting of settings) {
    if (
      setting.backend !== "nango" ||
      !setting.enabled ||
      !setting.providerConfigKey ||
      !isNangoIntegrationKey(setting.integrationKey) ||
      !NANGO_PROVIDER_CONFIG_KEY_PATTERN.test(setting.providerConfigKey)
    )
      continue;
    const native = nativeNangoIntegrationByKey(setting.integrationKey);
    const definition = setting.definition ?? {};
    // A config-only integration has no reviewed native bridge, so its tools
    // can only come from Nango; without that source it offers nothing.
    if (!native && definition.tools?.source !== "nango") continue;
    result.set(setting.integrationKey, {
      integrationKey: setting.integrationKey,
      providerConfigKey: setting.providerConfigKey,
      providerDomain: nangoProviderDomain(setting.integrationKey),
      definition,
      native,
      revision: setting.revision,
    });
  }
  return result;
}

/** Synthetic MCP identity of a config-only Nango integration's tool bridge. */
export function nangoToolsMcpUrl(integrationKey: string): string {
  if (!isNangoIntegrationKey(integrationKey)) throw new Error("Invalid Nango integration key");
  return `https://nango.opengeni.invalid/tools/${integrationKey}`;
}

export function nangoToolsIntegrationKeyFromMcpUrl(url: string | null | undefined): string | null {
  const canonical = canonicalMcpUrl(url);
  const prefix = "https://nango.opengeni.invalid/tools/";
  if (!canonical?.startsWith(prefix)) return null;
  const key = canonical.slice(prefix.length);
  return isNangoIntegrationKey(key) ? key : null;
}

// ---------------------------------------------------------------------------
// Credential and proxy transport
// ---------------------------------------------------------------------------

/** The only content of a Nango connection's encrypted credential. */
export type NangoConnectionCredential = {
  type: "nango";
  nangoConnectionId: string;
  providerConfigKey: string;
  integrationKey: string;
};

export function isNangoConnectionCredential(value: unknown): value is NangoConnectionCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "nango" &&
    typeof record.nangoConnectionId === "string" &&
    record.nangoConnectionId.length > 0 &&
    record.nangoConnectionId.length <= 255 &&
    typeof record.providerConfigKey === "string" &&
    NANGO_PROVIDER_CONFIG_KEY_PATTERN.test(record.providerConfigKey) &&
    isNangoIntegrationKey(record.integrationKey)
  );
}

/**
 * Returned beside the resolved headers of a Nango connection. A bridge that
 * declared support validates its provider destination exactly as before, then
 * sends the request to the Nango proxy instead.
 */
export type NangoProxyTransport = {
  kind: "nango_proxy";
  /** Nango API base, e.g. https://api.nango.dev. */
  baseUrl: string;
  integrationKey: string;
  providerConfigKey: string;
  nangoConnectionId: string;
};

export function nangoApiUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.replace(/\/+$/u, "");
  return new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
}

/**
 * Rewrite one already-validated provider request onto the Nango proxy. The
 * exact provider origin travels as `Base-Url-Override`, so Nango cannot route
 * the request to another host than the bridge validated.
 */
export function nangoProxyRequest(
  destination: string | URL,
  transport: Pick<NangoProxyTransport, "baseUrl">,
): { url: URL; headers: Record<string, string> } {
  const target = new URL(destination);
  if (target.protocol !== "https:") throw new Error("Nango proxy destinations must use https");
  return {
    url: nangoApiUrl(transport.baseUrl, `/proxy${target.pathname}${target.search}`),
    headers: { "base-url-override": target.origin },
  };
}

export function nangoAuthHeaders(input: {
  secretKey: string;
  nangoConnectionId?: string;
  providerConfigKey?: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.secretKey}`,
    ...(input.nangoConnectionId ? { "connection-id": input.nangoConnectionId } : {}),
    ...(input.providerConfigKey ? { "provider-config-key": input.providerConfigKey } : {}),
  };
}

/** Apply a resolved credential to a provider request: direct, or through Nango. */
export function credentialRequestTarget(
  destination: string | URL,
  credential: { headers: Record<string, string>; proxy?: NangoProxyTransport | undefined },
): { url: URL; headers: Record<string, string> } {
  if (!credential.proxy) return { url: new URL(destination), headers: { ...credential.headers } };
  const proxied = nangoProxyRequest(destination, credential.proxy);
  return { url: proxied.url, headers: { ...credential.headers, ...proxied.headers } };
}

// ---------------------------------------------------------------------------
// Connect sessions and attempt tags
// ---------------------------------------------------------------------------

/** Connection tags Opengeni sets on every connect session (lowercase keys). */
export const NANGO_TAG = Object.freeze({
  endUserId: "end_user_id",
  endUserEmail: "end_user_email",
  organizationId: "organization_id",
  workspaceId: "opengeni_workspace_id",
  attemptId: "opengeni_attempt_id",
  integrationKey: "opengeni_integration",
});

export type NangoAttemptTags = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  attemptId: string;
  integrationKey: string;
  email?: string | undefined;
};

export function nangoAttemptTags(input: NangoAttemptTags): Record<string, string> {
  const clip = (value: string) => value.slice(0, 255);
  return {
    [NANGO_TAG.endUserId]: clip(input.subjectId),
    [NANGO_TAG.organizationId]: clip(input.accountId),
    [NANGO_TAG.workspaceId]: clip(input.workspaceId),
    [NANGO_TAG.attemptId]: clip(input.attemptId),
    [NANGO_TAG.integrationKey]: clip(input.integrationKey),
    ...(input.email ? { [NANGO_TAG.endUserEmail]: clip(input.email) } : {}),
  };
}

/** Whether a Nango connection's tags prove it was created by exactly this attempt. */
export function nangoTagsMatchAttempt(
  tags: Record<string, string> | null | undefined,
  attempt: Omit<NangoAttemptTags, "email">,
): boolean {
  if (!tags) return false;
  const expected = nangoAttemptTags(attempt);
  return Object.entries(expected).every(([key, value]) => tags[key] === value);
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

export type NangoToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** HTTP method of a legacy action endpoint, when Nango reports one. */
  method?: string;
};

/**
 * Writes ask first by default; reads are allowed. An explicit definition list
 * wins, then the endpoint method; an unknown method is treated as a write.
 */
export function classifyNangoTool(
  tool: Pick<NangoToolDescriptor, "name" | "method">,
  definition: NangoIntegrationDefinition | null | undefined,
): "read" | "write" {
  if (definition?.tools?.write?.includes(tool.name)) return "write";
  if (definition?.tools?.read?.includes(tool.name)) return "read";
  if (tool.method) return tool.method.toUpperCase() === "GET" ? "read" : "write";
  return "write";
}

export function selectNangoTools(
  tools: readonly NangoToolDescriptor[],
  definition: NangoIntegrationDefinition | null | undefined,
): NangoToolDescriptor[] {
  const allow = definition?.tools?.allow;
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (!TOOL_NAME.test(tool.name) || seen.has(tool.name)) return false;
    if (allow && !allow.includes(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Pricing (https://nango.dev/pricing, checked 2026-11-13)
// ---------------------------------------------------------------------------

export const NANGO_PRICING = Object.freeze({
  checkedOn: "2026-11-13",
  /** Pay-as-you-go, prorated by the time a connection exists. */
  connectionMonthUsd: 0.29,
  /** Each tool/action run is rounded up to one second. */
  computeHourUsd: 0.72,
  /** Data transfer: proxy responses to Opengeni and data sent to provider APIs. */
  egressGbUsd: 0.5,
});

const SECONDS_PER_MONTH = 30 * 24 * 3600;

export function estimateNangoCostUsd(input: {
  connectionSeconds: number;
  transferBytes: number;
  computeSeconds: number;
}): { connections: number; transfer: number; compute: number; total: number } {
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const connections =
    (input.connectionSeconds / SECONDS_PER_MONTH) * NANGO_PRICING.connectionMonthUsd;
  const transfer = (input.transferBytes / 1_000_000_000) * NANGO_PRICING.egressGbUsd;
  const compute = (input.computeSeconds / 3600) * NANGO_PRICING.computeHourUsd;
  return {
    connections: round(connections),
    transfer: round(transfer),
    compute: round(compute),
    total: round(connections + transfer + compute),
  };
}

/** Reads a dot path (`user.emailAddress`) from a provider identity response. */
export function readIdentityField(payload: unknown, field: string): string | null {
  let current: unknown = payload;
  for (const part of field.split(".")) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.trim() ? current.trim().slice(0, 320) : null;
}
