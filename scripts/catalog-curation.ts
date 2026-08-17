import curatedDocument from "../data/catalog/curated.json";

/**
 * The curated catalog overlay.
 *
 * Reviewed first-party contracts and branding override weaker registry
 * metadata. This used to live as two hand-maintained maps inside the import
 * script; it is data now so that adding a connector is a reviewable data diff
 * rather than a TypeScript change.
 *
 * Every field is optional. A supplied value wins over the snapshot; an omitted
 * one falls through to the snapshot unchanged, so a name-only entry behaves
 * exactly like the old branded-name map.
 */

export type CuratedAuthKind = "oauth2" | "api_key" | "none" | "unknown";
export type CuratedTier = "verified" | "community";

export type CuratedCatalogEntry = {
  /** Exact canonical MCP URL. The overlay key. */
  readonly mcpUrl: string;
  readonly name?: string;
  readonly description?: string;
  /** Catalog grouping shown in the connector browser. */
  readonly category?: string;
  /** Promotes the entry to the featured strip. Not a security review. */
  readonly featured?: boolean;
  /** The provider publishes this server on its own domain. Not a security review. */
  readonly official?: boolean;
  readonly tier?: CuratedTier;
  readonly provenance?: string;
  readonly authKind?: CuratedAuthKind;
  readonly scopesHint?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly requireApproval?: boolean | readonly string[];
  readonly connectionOwnership?: "personal_only";
  /**
   * Declarative OAuth quirks for the row, applied by the API's OAuth client as
   * a narrowing constraint over its defaults (never a loosening one). Shape is
   * validated here structurally and again by the API's zod schema at use time.
   */
  readonly oauthProfile?: CuratedOAuthProfile;
  /** `null` deliberately suppresses a logo fetch and keeps the monogram. */
  readonly logoSourceUrl?: string | null;
  readonly homepageUrl?: string;
  readonly installUrl?: string;
  readonly documentationUrl?: string;
  readonly registryName?: string;
  readonly registryVersion?: string;
  readonly registryStatus?: string;
  readonly registryIsLatest?: boolean;
  readonly registryPublishedAt?: string;
  readonly repositorySource?: string;
  readonly repositoryUrl?: string;
  readonly sourceCommit?: string;
  /** Reviewer-facing rationale. Never rendered to end users. */
  readonly notes?: readonly string[];
};

export type CuratedOAuthProfile = {
  readonly clientSource?: "deployment_managed" | "cimd" | "dcr";
  readonly exactMcpUrl?: string;
  readonly pinnedIssuerOrigins?: readonly string[];
  readonly pinnedEndpointOrigins?: readonly string[];
  readonly sendResourceParameter?: boolean;
  readonly allowedOwnership?: readonly ("personal" | "workspace")[];
  readonly requestedScopes?: readonly string[];
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
};

export type CuratedCatalog = {
  readonly version: number;
  readonly entries: readonly CuratedCatalogEntry[];
};

class CuratedCatalogError extends Error {
  constructor(message: string) {
    super(`data/catalog/curated.json: ${message}`);
    this.name = "CuratedCatalogError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CuratedCatalogError(`${where}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  where: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CuratedCatalogError(`${where}: ${key} must be a boolean`);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CuratedCatalogError(`${where}: ${key} must be an array of strings`);
  }
  return value as string[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const STRING_FIELDS = [
  "name",
  "description",
  "category",
  "provenance",
  "homepageUrl",
  "installUrl",
  "documentationUrl",
  "registryName",
  "registryVersion",
  "registryStatus",
  "registryPublishedAt",
  "repositorySource",
  "repositoryUrl",
  "sourceCommit",
] as const satisfies readonly (keyof CuratedCatalogEntry)[];

const BOOLEAN_FIELDS = [
  "featured",
  "official",
  "registryIsLatest",
] as const satisfies readonly (keyof CuratedCatalogEntry)[];

const STRING_ARRAY_FIELDS = [
  "scopesHint",
  "allowedTools",
  "notes",
] as const satisfies readonly (keyof CuratedCatalogEntry)[];

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  "mcpUrl",
  ...STRING_FIELDS,
  ...BOOLEAN_FIELDS,
  ...STRING_ARRAY_FIELDS,
  "authKind",
  "tier",
  "connectionOwnership",
  "oauthProfile",
  "logoSourceUrl",
  "requireApproval",
]);

const OAUTH_PROFILE_KEYS: ReadonlySet<string> = new Set([
  "clientSource",
  "exactMcpUrl",
  "pinnedIssuerOrigins",
  "pinnedEndpointOrigins",
  "sendResourceParameter",
  "allowedOwnership",
  "requestedScopes",
  "extraAuthorizeParams",
]);

const OAUTH_CLIENT_SOURCES: ReadonlySet<string> = new Set(["deployment_managed", "cimd", "dcr"]);
const OAUTH_OWNERSHIPS: ReadonlySet<string> = new Set(["personal", "workspace"]);

function parseOAuthProfile(raw: unknown, where: string): CuratedOAuthProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CuratedCatalogError(`${where}: oauthProfile must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OAUTH_PROFILE_KEYS.has(key)) {
      throw new CuratedCatalogError(`${where}: oauthProfile has unknown key "${key}"`);
    }
  }
  const profile: {
    -readonly [K in keyof CuratedOAuthProfile]: CuratedOAuthProfile[K];
  } = {};
  if (record.clientSource !== undefined) {
    if (typeof record.clientSource !== "string" || !OAUTH_CLIENT_SOURCES.has(record.clientSource)) {
      throw new CuratedCatalogError(
        `${where}: oauthProfile.clientSource must be one of ${[...OAUTH_CLIENT_SOURCES].join(", ")}`,
      );
    }
    profile.clientSource = record.clientSource as NonNullable<CuratedOAuthProfile["clientSource"]>;
  }
  if (record.exactMcpUrl !== undefined) {
    if (typeof record.exactMcpUrl !== "string" || !URL.canParse(record.exactMcpUrl)) {
      throw new CuratedCatalogError(`${where}: oauthProfile.exactMcpUrl must be a URL`);
    }
    profile.exactMcpUrl = record.exactMcpUrl;
  }
  for (const key of ["pinnedIssuerOrigins", "pinnedEndpointOrigins", "requestedScopes"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0)
    ) {
      throw new CuratedCatalogError(
        `${where}: oauthProfile.${key} must be a non-empty string array`,
      );
    }
    if (key !== "requestedScopes" && value.some((item) => !URL.canParse(item))) {
      throw new CuratedCatalogError(`${where}: oauthProfile.${key} entries must be URLs`);
    }
    profile[key] = value as string[];
  }
  if (record.sendResourceParameter !== undefined) {
    if (typeof record.sendResourceParameter !== "boolean") {
      throw new CuratedCatalogError(`${where}: oauthProfile.sendResourceParameter must be boolean`);
    }
    profile.sendResourceParameter = record.sendResourceParameter;
  }
  if (record.allowedOwnership !== undefined) {
    const value = record.allowedOwnership;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || !OAUTH_OWNERSHIPS.has(item))
    ) {
      throw new CuratedCatalogError(
        `${where}: oauthProfile.allowedOwnership must be a non-empty array of "personal" | "workspace"`,
      );
    }
    profile.allowedOwnership = value as ("personal" | "workspace")[];
  }
  if (record.extraAuthorizeParams !== undefined) {
    const value = record.extraAuthorizeParams;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.values(value).some((item) => typeof item !== "string")
    ) {
      throw new CuratedCatalogError(
        `${where}: oauthProfile.extraAuthorizeParams must be a string-to-string object`,
      );
    }
    profile.extraAuthorizeParams = value as Record<string, string>;
  }
  return profile;
}

/**
 * Mirrors the importer's canonicalization exactly. Kept local so this module
 * has no dependency on the importer, which imports it.
 */
export function canonicalMcpUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

const AUTH_KINDS: ReadonlySet<string> = new Set(["oauth2", "api_key", "none", "unknown"]);
const TIERS: ReadonlySet<string> = new Set(["verified", "community"]);

function parseEntry(value: unknown, index: number): CuratedCatalogEntry {
  const record = asRecord(value);
  if (!record) throw new CuratedCatalogError(`entries[${index}] must be an object`);

  const mcpUrl = record.mcpUrl;
  if (typeof mcpUrl !== "string" || mcpUrl.trim().length === 0) {
    throw new CuratedCatalogError(`entries[${index}]: mcpUrl is required`);
  }
  const where = mcpUrl;

  // The importer looks entries up by canonical MCP URL. Storing anything else
  // would silently curate nothing, so the file itself must stay canonical.
  const canonical = canonicalMcpUrl(mcpUrl);
  if (canonical !== mcpUrl) {
    throw new CuratedCatalogError(
      `${where}: mcpUrl must be written in canonical form "${canonical}"`,
    );
  }

  // Unknown keys are almost always typos ("offical", "feature"). Dropping them
  // would be exactly the silent curation loss this parser exists to prevent.
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new CuratedCatalogError(`${where}: unknown key "${key}"`);
    }
  }

  const entry: Mutable<CuratedCatalogEntry> = { mcpUrl };

  const assign = <K extends keyof CuratedCatalogEntry>(
    key: K,
    parsed: CuratedCatalogEntry[K] | undefined,
  ): void => {
    if (parsed !== undefined) entry[key] = parsed;
  };

  for (const key of STRING_FIELDS) {
    assign(key, optionalString(record, key, where));
  }
  for (const key of BOOLEAN_FIELDS) {
    assign(key, optionalBoolean(record, key, where));
  }
  for (const key of STRING_ARRAY_FIELDS) {
    assign(key, optionalStringArray(record, key, where));
  }

  const authKind = optionalString(record, "authKind", where);
  if (authKind !== undefined) {
    if (!AUTH_KINDS.has(authKind)) {
      throw new CuratedCatalogError(
        `${where}: authKind must be one of ${[...AUTH_KINDS].join(", ")}`,
      );
    }
    entry.authKind = authKind as CuratedAuthKind;
  }

  const tier = optionalString(record, "tier", where);
  if (tier !== undefined) {
    if (!TIERS.has(tier)) {
      throw new CuratedCatalogError(`${where}: tier must be one of ${[...TIERS].join(", ")}`);
    }
    entry.tier = tier as CuratedTier;
  }

  const connectionOwnership = optionalString(record, "connectionOwnership", where);
  if (connectionOwnership !== undefined) {
    if (connectionOwnership !== "personal_only") {
      throw new CuratedCatalogError(`${where}: connectionOwnership must be "personal_only"`);
    }
    entry.connectionOwnership = connectionOwnership;
  }

  if ("oauthProfile" in record) {
    entry.oauthProfile = parseOAuthProfile(record.oauthProfile, where);
  }

  // `logoSourceUrl: null` is meaningful: it suppresses the logo fetch and
  // keeps the monogram, so the omitted and explicitly-null cases differ.
  if ("logoSourceUrl" in record) {
    const raw = record.logoSourceUrl;
    if (raw !== null && (typeof raw !== "string" || raw.trim().length === 0)) {
      throw new CuratedCatalogError(`${where}: logoSourceUrl must be a non-empty string or null`);
    }
    entry.logoSourceUrl = raw as string | null;
  }

  if ("requireApproval" in record) {
    const raw = record.requireApproval;
    if (typeof raw === "boolean") {
      entry.requireApproval = raw;
    } else if (Array.isArray(raw) && raw.every((tool) => typeof tool === "string")) {
      entry.requireApproval = raw as string[];
    } else {
      throw new CuratedCatalogError(
        `${where}: requireApproval must be a boolean or an array of tool names`,
      );
    }
  }

  return entry;
}

/**
 * Parses and validates a curated overlay document. Throws rather than dropping
 * a malformed entry: losing curation silently would ship the raw aggregator
 * name and tier to users without anyone noticing.
 */
export function parseCuratedCatalog(document: unknown): CuratedCatalog {
  const root = asRecord(document);
  if (!root) throw new CuratedCatalogError("document must be an object");
  if (root.version !== 1) {
    throw new CuratedCatalogError(`unsupported version ${String(root.version)}; expected 1`);
  }
  if (!Array.isArray(root.entries)) {
    throw new CuratedCatalogError("entries must be an array");
  }

  const entries = root.entries.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.mcpUrl)) {
      throw new CuratedCatalogError(`duplicate entry for ${entry.mcpUrl}`);
    }
    seen.add(entry.mcpUrl);
  }
  return { version: root.version, entries };
}

export function curatedCatalogByMcpUrl(
  catalog: CuratedCatalog,
): ReadonlyMap<string, CuratedCatalogEntry> {
  return new Map(catalog.entries.map((entry) => [entry.mcpUrl, entry]));
}

/** The committed overlay, validated at module load so a bad edit fails loudly. */
export const CURATED_CATALOG: CuratedCatalog = parseCuratedCatalog(curatedDocument);

export const curatedCatalogEntriesByMcpUrl: ReadonlyMap<string, CuratedCatalogEntry> =
  curatedCatalogByMcpUrl(CURATED_CATALOG);

/**
 * Canonical serialization used by the import fingerprint. Whitespace and key
 * order in the source file are irrelevant; any semantic change is not.
 */
export function curatedCatalogFingerprintInput(catalog: CuratedCatalog): string {
  const sorted = [...catalog.entries].sort((a, b) => a.mcpUrl.localeCompare(b.mcpUrl));
  return JSON.stringify({ version: catalog.version, entries: sorted.map(sortKeys) });
}

function sortKeys(entry: CuratedCatalogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort()) {
    out[key] = (entry as Record<string, unknown>)[key];
  }
  return out;
}
