import requirementsDocument from "../data/catalog/oauth-client-requirements.json";
import { canonicalMcpUrl } from "./catalog-curation";

/**
 * Catalog connectors whose OAuth authorization server cannot be reached by
 * self-registration from a hosted deployment, keyed by canonical MCP URL.
 *
 * The importer stamps `metadata.oauthClientRequirement = { issuer, reason }` on
 * the matching row. The capability catalog then projects whether the current
 * deployment has an operator-registered client for that issuer, and connector
 * surfaces offer the row only when it does. Listing a row here never curates,
 * features, or hides it by itself; it records a provider fact.
 */

export type OAuthClientRequirementReason =
  | "no_self_registration"
  | "registration_refused"
  | "redirect_uri_not_allowed";

export type OAuthClientRequirementEntry = {
  readonly mcpUrl: string;
  readonly name: string;
  /** Authorization-server issuer the operator client is keyed by. */
  readonly issuer: string;
  readonly reason: OAuthClientRequirementReason;
  readonly evidence: string;
  readonly checkedAt: string;
};

export type OAuthClientRequirements = {
  readonly version: number;
  readonly entries: readonly OAuthClientRequirementEntry[];
};

export class OAuthClientRequirementsError extends Error {
  constructor(message: string) {
    super(`data/catalog/oauth-client-requirements.json: ${message}`);
    this.name = "OAuthClientRequirementsError";
  }
}

const REASONS: ReadonlySet<string> = new Set([
  "no_self_registration",
  "registration_refused",
  "redirect_uri_not_allowed",
]);
const KEYS: ReadonlySet<string> = new Set([
  "mcpUrl",
  "name",
  "issuer",
  "reason",
  "evidence",
  "checkedAt",
]);

function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new OAuthClientRequirementsError(`${where}: ${key} must be a non-empty string`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): OAuthClientRequirementEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthClientRequirementsError(`entries[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const mcpUrl = requiredString(record, "mcpUrl", `entries[${index}]`);
  const canonical = canonicalMcpUrl(mcpUrl);
  if (canonical !== mcpUrl) {
    throw new OAuthClientRequirementsError(
      `${mcpUrl}: mcpUrl must be written in canonical form "${canonical}"`,
    );
  }
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) throw new OAuthClientRequirementsError(`${mcpUrl}: unknown key "${key}"`);
  }
  const issuer = requiredString(record, "issuer", mcpUrl);
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new OAuthClientRequirementsError(`${mcpUrl}: issuer must be an absolute URL`);
  }
  if (issuerUrl.protocol !== "https:") {
    throw new OAuthClientRequirementsError(`${mcpUrl}: issuer must use https`);
  }
  const reason = requiredString(record, "reason", mcpUrl);
  if (!REASONS.has(reason)) {
    throw new OAuthClientRequirementsError(`${mcpUrl}: unknown reason "${reason}"`);
  }
  const checkedAt = requiredString(record, "checkedAt", mcpUrl);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) {
    throw new OAuthClientRequirementsError(`${mcpUrl}: checkedAt must be YYYY-MM-DD`);
  }
  return {
    mcpUrl,
    name: requiredString(record, "name", mcpUrl),
    issuer,
    reason: reason as OAuthClientRequirementReason,
    evidence: requiredString(record, "evidence", mcpUrl),
    checkedAt,
  };
}

export function parseOAuthClientRequirements(document: unknown): OAuthClientRequirements {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new OAuthClientRequirementsError("document must be an object");
  }
  const root = document as Record<string, unknown>;
  if (root.version !== 1) {
    throw new OAuthClientRequirementsError(
      `unsupported version ${String(root.version)}; expected 1`,
    );
  }
  if (!Array.isArray(root.entries)) {
    throw new OAuthClientRequirementsError("entries must be an array");
  }
  const entries = root.entries.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.mcpUrl)) {
      throw new OAuthClientRequirementsError(`duplicate entry for ${entry.mcpUrl}`);
    }
    seen.add(entry.mcpUrl);
  }
  return { version: root.version, entries };
}

/** The committed file, validated at module load so a bad edit fails loudly. */
export const OAUTH_CLIENT_REQUIREMENTS: OAuthClientRequirements =
  parseOAuthClientRequirements(requirementsDocument);

export function oauthClientRequirementsByMcpUrl(
  requirements: OAuthClientRequirements,
): ReadonlyMap<string, OAuthClientRequirementEntry> {
  return new Map(requirements.entries.map((entry) => [entry.mcpUrl, entry]));
}

export const oauthClientRequirementsEntriesByMcpUrl = oauthClientRequirementsByMcpUrl(
  OAUTH_CLIENT_REQUIREMENTS,
);

/**
 * Canonical import-fingerprint input: only the facts the importer writes
 * (issuer and reason per URL), so evidence wording edits do not re-import.
 */
export function oauthClientRequirementsFingerprintInput(
  requirements: OAuthClientRequirements,
): string {
  return JSON.stringify({
    version: requirements.version,
    entries: [...requirements.entries]
      .sort((left, right) => left.mcpUrl.localeCompare(right.mcpUrl))
      .map((entry) => ({ mcpUrl: entry.mcpUrl, issuer: entry.issuer, reason: entry.reason })),
  });
}
