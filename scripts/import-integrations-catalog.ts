import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  createDb,
  createImportBatch,
  markStaleRegistryCatalogItems,
  updateImportBatchCounts,
  upsertRegistryCapabilityCatalogItem,
  type Database,
  type ImportBatch,
  type RegistryCapabilityCatalogItemInput,
} from "@opengeni/db";
import { createObjectStorage, type ObjectStorage } from "../packages/storage/src/index";

const SOURCE = "integrations.sh";
const MIT_ATTRIBUTION = "Seed catalog metadata imported from integrations.sh / UsefulSoftwareCo integrationsdotsh (MIT License, Copyright (c) 2026 Rhys Sullivan).";
const MAX_LOGO_BYTES = 512 * 1024;

export const deadDemoDomains = new Set([
  "auto-calculator.onrender.com",
  "body-health-calculator.onrender.com",
  "d2p3kt79hdhtiu.cloudfront.net",
  "flower-delivery-ffh2.onrender.com",
  "investment-calculator-1a2t.onrender.com",
  "kindora-mcp.azurewebsites.net",
  "mcp-london-transport-demo.onrender.com",
  "mortgage-calculator-o7vv.onrender.com",
  "my-budget-planner.onrender.com",
  "novostavby-mcp-bridge.onrender.com",
  "portfolio-optimizer-svpa.onrender.com",
  "reminder-app-3pz5.onrender.com",
  "rental-property-calculator.onrender.com",
  "retirement-calculator-ribr.onrender.com",
  "sobobeaches-chatgpt.onrender.com",
  "snake-game-mcp.onrender.com",
  "travel-checklist-q79n.onrender.com",
  "travelsafety-un15.onrender.com",
]);

export const suspiciousSurfaceUrls = new Map([
  ["activepieces.com\nhttps://www.activepieces.com/.well-known/mcp/server-card.json", "server-card JSON URL needs manual confirmation before enablement"],
  ["netatmo.com\nhttps://www.netatmo.com/.well-known/mcp/server-card.json", "server-card JSON URL needs manual confirmation before enablement"],
  ["doordash.com\nhttps://openapi.doordash.com/mcp/consumer", "consumer API URL needs manual confirmation before enablement"],
  ["natwest.com\nhttps://openapi.natwest.com/mortgages/v1/mcp-server-mortgages/mcp", "banking API URL needs manual confirmation before enablement"],
  ["smartbear.com\nhttps://swagger.mcp.smartbear.com/mcp", "SmartBear Swagger endpoint needs manual confirmation before enablement"],
]);

type UnknownRecord = Record<string, unknown>;

export type CatalogAuthKind = "oauth2" | "api_key" | "none" | "unknown";
export type CatalogTier = "verified" | "community";

export type CatalogIntegrationRow = {
  domain: string;
  name: string;
  mcpUrl: string;
  transport: "streamable-http";
  authKind: CatalogAuthKind;
  scopesHint: string[];
  credentialFacts: Array<Record<string, unknown>>;
  tier: CatalogTier;
  provenance: string;
  logoSourceUrl: string | null;
  probe?: Record<string, unknown>;
};

export type NormalizedCatalogSnapshot = {
  generatedAt: string | null;
  rows: CatalogIntegrationRow[];
  skipped: Array<{ domain: string | null; mcpUrl: string | null; reason: string }>;
  quarantined: Array<{ row: CatalogIntegrationRow; reason: string }>;
  cleaning: {
    inputRows: number;
    outputRows: number;
    skippedRows: number;
    quarantinedRows: number;
    duplicateDomainNameRows: number;
    controlCharacterFields: number;
  };
};

export type LogoStorageResult =
  | { ok: true; path: string; sourceUrl: string; contentType: string; sizeBytes: number }
  | { ok: false; sourceUrl: string | null; reason: string };

export type ImportCatalogResult = {
  batch: ImportBatch;
  importedCount: number;
  skippedCount: number;
  quarantinedCount: number;
  logoFailureCount: number;
  staleCount: number;
  quarantined: NormalizedCatalogSnapshot["quarantined"];
  skipped: NormalizedCatalogSnapshot["skipped"];
  logoFailures: Array<{ domain: string; mcpUrl: string; reason: string; sourceUrl: string | null }>;
};

export type LogoStorage = Pick<ObjectStorage, "putObject"> & { bucket?: string };
export type LogoFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function readSnapshotFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeCleanCatalogSnapshot(path: string, snapshot: unknown): Promise<NormalizedCatalogSnapshot> {
  const normalized = normalizeCatalogSnapshot(snapshot);
  await writeFile(path, `${JSON.stringify({
    generatedAt: normalized.generatedAt,
    source: SOURCE,
    cleanedAt: new Date().toISOString(),
    cleaning: normalized.cleaning,
    importRows: normalized.rows,
    skipped: normalized.skipped,
    quarantined: normalized.quarantined.map((item) => ({
      row: item.row,
      reason: item.reason,
    })),
  }, null, 2)}\n`);
  return normalized;
}

export function normalizeCatalogSnapshot(snapshot: unknown): NormalizedCatalogSnapshot {
  const controlCharacters = { count: 0 };
  const cleanedSnapshot = stripControlCharacters(snapshot, controlCharacters);
  const root = asRecord(cleanedSnapshot);
  const generatedAt = stringValue(root?.generatedAt) ?? stringValue(root?.snapshotDate) ?? null;
  const candidates = precomputedRows(root ?? cleanedSnapshot) ?? rawSurfaceRows(root);
  const skipped: NormalizedCatalogSnapshot["skipped"] = [];
  const quarantined: NormalizedCatalogSnapshot["quarantined"] = [];
  const candidatesByDomainName = new Map<string, CatalogIntegrationRow>();
  const seen = new Set<string>();
  let duplicateDomainNameRows = 0;

  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate.domain);
    const mcpUrl = stringValue(candidate.mcpUrl);
    if (!domain) {
      skipped.push({ domain: null, mcpUrl: mcpUrl ?? null, reason: "missing_domain" });
      continue;
    }
    if (deadDemoDomains.has(domain)) {
      skipped.push({ domain, mcpUrl: mcpUrl ?? null, reason: "dead_demo_domain" });
      continue;
    }
    if (!mcpUrl) {
      skipped.push({ domain, mcpUrl: null, reason: "missing_url" });
      continue;
    }
    const importable = importableMcpUrl(mcpUrl);
    if (!importable.ok) {
      skipped.push({ domain, mcpUrl: mcpUrl ?? null, reason: importable.reason });
      continue;
    }
    const transport = normalizeTransport(candidate.transport ?? candidate.transports);
    if (!transport) {
      skipped.push({ domain, mcpUrl, reason: "transport_not_streamable_http" });
      continue;
    }
    const key = `${domain}\n${mcpUrl}`;
    if (seen.has(key)) {
      skipped.push({ domain, mcpUrl, reason: "duplicate_surface" });
      continue;
    }
    seen.add(key);
    const provenance = normalizeProvenance(candidate.provenance ?? asRecord(candidate.basis)?.via);
    const row: CatalogIntegrationRow = {
      domain,
      name: stringValue(candidate.name) ?? domain,
      mcpUrl,
      transport: "streamable-http",
      authKind: normalizeAuthKind(candidate.authKind),
      scopesHint: stringArray(candidate.scopesHint),
      credentialFacts: recordArray(candidate.credentialFacts),
      tier: provenance === "detected" ? "verified" : "community",
      provenance,
      logoSourceUrl: stringValue(candidate.logoAsset) ?? stringValue(candidate.logoSourceUrl) ?? `https://integrations.sh/logo/${domain}`,
    };
    const suspiciousReason = suspiciousSurfaceUrls.get(key);
    if (suspiciousReason) {
      quarantined.push({ row, reason: suspiciousReason });
      continue;
    }
    const domainNameKey = `${row.domain}\n${normalizeNameForDedupe(row.name)}`;
    const existing = candidatesByDomainName.get(domainNameKey);
    if (!existing) {
      candidatesByDomainName.set(domainNameKey, row);
      continue;
    }
    duplicateDomainNameRows += 1;
    const winner = bestCatalogRow(existing, row);
    const loser = winner === existing ? row : existing;
    candidatesByDomainName.set(domainNameKey, winner);
    skipped.push({ domain: loser.domain, mcpUrl: loser.mcpUrl, reason: "duplicate_domain_name" });
  }

  const rows = [...candidatesByDomainName.values()].sort((left, right) =>
    left.domain.localeCompare(right.domain) || left.name.localeCompare(right.name) || left.mcpUrl.localeCompare(right.mcpUrl)
  );

  return {
    generatedAt,
    rows,
    skipped,
    quarantined,
    cleaning: {
      inputRows: candidates.length,
      outputRows: rows.length,
      skippedRows: skipped.length,
      quarantinedRows: quarantined.length,
      duplicateDomainNameRows,
      controlCharacterFields: controlCharacters.count,
    },
  };
}

export async function importIntegrationsCatalog(input: {
  db: Database;
  snapshot: unknown;
  snapshotRef?: string | null;
  storage?: LogoStorage | null;
  fetchImpl?: LogoFetch;
  storeLogos?: boolean;
}): Promise<ImportCatalogResult> {
  const normalized = normalizeCatalogSnapshot(input.snapshot);
  if (normalized.rows.length === 0) {
    throw new Error("catalog import produced zero importable rows; aborting before DB writes to avoid marking registry entries stale");
  }
  const batch = await createImportBatch(input.db, {
    source: SOURCE,
    snapshotDate: normalized.generatedAt ? new Date(normalized.generatedAt) : new Date(),
    snapshotRef: input.snapshotRef ?? null,
    attributionNote: MIT_ATTRIBUTION,
    details: {
      generatedAt: normalized.generatedAt,
      quarantined: normalized.quarantined.map((item) => ({
        domain: item.row.domain,
        mcpUrl: item.row.mcpUrl,
        reason: item.reason,
      })),
      skipped: normalized.skipped,
      cleaning: normalized.cleaning,
    },
  });
  const logoFailures: ImportCatalogResult["logoFailures"] = [];

  for (const row of normalized.rows) {
    let logoAssetPath: string | null = null;
    if (input.storeLogos !== false) {
      const logo = await storeLogoForRow(row, {
        storage: input.storage ?? null,
        fetchImpl: input.fetchImpl ?? fetch,
      });
      if (logo.ok) {
        logoAssetPath = logo.path;
      } else {
        logoFailures.push({
          domain: row.domain,
          mcpUrl: row.mcpUrl,
          reason: logo.reason,
          sourceUrl: logo.sourceUrl,
        });
      }
    }
    await upsertRegistryCapabilityCatalogItem(input.db, catalogRowToDbInput(row, {
      importBatchId: batch.id,
      logoAssetPath,
    }));
  }

  const staleCount = await markStaleRegistryCatalogItems(input.db, normalized.rows.map((row) => ({
    providerDomain: row.domain,
    mcpUrl: row.mcpUrl,
  })), batch.id);
  const finalBatch = await updateImportBatchCounts(input.db, batch.id, {
    importedCount: normalized.rows.length,
    skippedCount: normalized.skipped.length,
    quarantinedCount: normalized.quarantined.length,
    logoFailureCount: logoFailures.length,
    staleCount,
    details: {
      generatedAt: normalized.generatedAt,
      quarantined: normalized.quarantined.map((item) => ({
        domain: item.row.domain,
        mcpUrl: item.row.mcpUrl,
        reason: item.reason,
      })),
      skipped: normalized.skipped,
      cleaning: normalized.cleaning,
      logoFailures,
    },
  });

  return {
    batch: finalBatch,
    importedCount: normalized.rows.length,
    skippedCount: normalized.skipped.length,
    quarantinedCount: normalized.quarantined.length,
    logoFailureCount: logoFailures.length,
    staleCount,
    quarantined: normalized.quarantined,
    skipped: normalized.skipped,
    logoFailures,
  };
}

export function catalogRowToDbInput(row: CatalogIntegrationRow, input: {
  importBatchId: string;
  logoAssetPath?: string | null;
}): RegistryCapabilityCatalogItemInput {
  return {
    id: catalogCapabilityId(row.domain, row.mcpUrl),
    providerDomain: row.domain,
    name: row.name,
    mcpUrl: row.mcpUrl,
    transport: row.transport,
    authKind: row.authKind,
    credentialFacts: row.credentialFacts,
    tier: row.tier,
    provenance: row.provenance,
    logoAssetPath: input.logoAssetPath ?? null,
    importBatchId: input.importBatchId,
    scopesHint: row.scopesHint,
    homepageUrl: `https://${row.domain}`,
    tags: ["mcp", "integration", row.tier, row.authKind],
    metadata: {
      logoSource: row.logoSourceUrl ? "integrations.sh" : "missing",
      originalLogoUrl: row.logoSourceUrl,
      ...(row.probe ? { mcpProbe: row.probe } : {}),
    },
  };
}

export async function storeLogoForRow(row: CatalogIntegrationRow, input: {
  storage: LogoStorage | null;
  fetchImpl: LogoFetch;
}): Promise<LogoStorageResult> {
  const sourceUrl = row.logoSourceUrl ?? `https://integrations.sh/logo/${row.domain}`;
  if (!input.storage) {
    return { ok: false, sourceUrl, reason: "object_storage_unavailable" };
  }
  let response: Response;
  try {
    response = await input.fetchImpl(sourceUrl);
  } catch (error) {
    return { ok: false, sourceUrl, reason: `fetch_failed:${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) {
    return { ok: false, sourceUrl, reason: `http_status:${response.status}` };
  }
  const contentType = normalizedContentType(response.headers.get("content-type"));
  if (!contentType?.startsWith("image/")) {
    return { ok: false, sourceUrl, reason: `invalid_content_type:${contentType ?? "missing"}` };
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_LOGO_BYTES) {
    return { ok: false, sourceUrl, reason: "image_too_large" };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return { ok: false, sourceUrl, reason: "image_too_large" };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const key = `catalog-assets/integrations-sh/logos/${safePathSegment(row.domain)}/${digest.slice(0, 24)}.${extensionForContentType(contentType)}`;
  await input.storage.putObject({ key, contentType, body: bytes, sha256: digest });
  return { ok: true, path: key, sourceUrl, contentType, sizeBytes: bytes.byteLength };
}

export function catalogCapabilityId(domain: string, mcpUrl: string): string {
  return `mcp:integrations-sh:${slugify(domain)}-${shortHash(`${domain}:${mcpUrl}`)}`;
}

function precomputedRows(snapshot: unknown): UnknownRecord[] | null {
  if (Array.isArray(snapshot)) {
    return snapshot.filter(isRecord);
  }
  const root = asRecord(snapshot);
  const rows = root?.importRows ?? root?.rows;
  return Array.isArray(rows) ? rows.filter(isRecord) : null;
}

function rawSurfaceRows(root: UnknownRecord | null): UnknownRecord[] {
  if (!root) {
    return [];
  }
  const flatEntries = arrayValue(root.api ?? root.catalog ?? root.flatCatalog ?? root.entries ?? root.data).filter(isRecord);
  const surfaceDocs = surfaceDocEntries(root.surfaceDocs ?? root.surfaces ?? root.domains);
  const flatByDomain = new Map<string, UnknownRecord>();
  for (const entry of flatEntries) {
    const domain = normalizeDomain(entry.domain ?? entry.providerDomain ?? entry.host);
    if (domain && !flatByDomain.has(domain)) {
      flatByDomain.set(domain, entry);
    }
  }
  const rows: UnknownRecord[] = [];
  for (const [domain, doc] of surfaceDocs) {
    const flat = flatByDomain.get(domain);
    const credentials = asRecord(doc.credentials) ?? {};
    for (const surface of surfaceArray(doc)) {
      const surfaceRecord = asRecord(surface);
      if (!surfaceRecord || stringValue(surfaceRecord.type) !== "mcp") {
        continue;
      }
      const credentialFacts = credentialFactsForSurface(surfaceRecord, credentials);
      rows.push({
        domain,
        name: stringValue(flat?.name) ?? stringValue(surfaceRecord.name) ?? domain,
        mcpUrl: stringValue(surfaceRecord.url),
        transport: surfaceRecord.transports ?? surfaceRecord.transport,
        authKind: deriveAuthKind(surfaceRecord, credentialFacts),
        scopesHint: scopesHintForSurface(surfaceRecord),
        credentialFacts,
        provenance: asRecord(surfaceRecord.basis)?.via ?? surfaceRecord.provenance,
        logoAsset: stringValue(flat?.icon) ?? stringValue(surfaceRecord.icon) ?? `https://integrations.sh/logo/${domain}`,
      });
    }
  }
  return rows;
}

function surfaceDocEntries(value: unknown): Array<[string, UnknownRecord]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry): Array<[string, UnknownRecord]> => {
      const doc = asRecord(entry);
      const domain = normalizeDomain(doc?.domain);
      return doc && domain ? [[domain, doc]] : [];
    });
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record).flatMap(([domain, doc]): Array<[string, UnknownRecord]> => {
    const parsed = asRecord(doc);
    const normalized = normalizeDomain(parsed?.domain ?? domain);
    return parsed && normalized ? [[normalized, parsed]] : [];
  });
}

function surfaceArray(doc: UnknownRecord): unknown[] {
  const surfaces = doc.surfaces ?? doc.surface;
  if (Array.isArray(surfaces)) {
    return surfaces;
  }
  return surfaces ? [surfaces] : [];
}

function credentialFactsForSurface(surface: UnknownRecord, credentials: UnknownRecord): Array<Record<string, unknown>> {
  const ids = referencedCredentialIds(surface);
  return ids.flatMap((id): Array<Record<string, unknown>> => {
    const credential = asRecord(credentials[id]);
    if (!credential) {
      return [];
    }
    return [{
      id,
      type: stringValue(credential.type) ?? "unknown",
      generateUrl: stringValue(credential.generateUrl) ?? null,
      setup: stringValue(credential.setup) ?? null,
      fields: asRecord(credential.fields),
    }];
  });
}

function referencedCredentialIds(surface: UnknownRecord): string[] {
  const ids = new Set<string>();
  const auth = asRecord(surface.auth);
  const entries = arrayValue(auth?.entries);
  for (const entry of entries) {
    const uses = arrayValue(asRecord(entry)?.use);
    for (const use of uses) {
      const id = stringValue(asRecord(use)?.id);
      if (id) {
        ids.add(id);
      }
    }
  }
  for (const id of stringArray(surface.credentials)) {
    ids.add(id);
  }
  return [...ids];
}

function scopesHintForSurface(surface: UnknownRecord): string[] {
  const scopes = new Set<string>();
  const auth = asRecord(surface.auth);
  for (const value of [auth?.scope, auth?.scopes, surface.scope, surface.scopes]) {
    for (const scope of stringArray(value)) {
      scopes.add(scope);
    }
  }
  for (const entry of arrayValue(auth?.entries)) {
    const record = asRecord(entry);
    for (const value of [record?.scope, record?.scopes]) {
      for (const scope of stringArray(value)) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
}

function deriveAuthKind(surface: UnknownRecord, credentialFacts: Array<Record<string, unknown>>): CatalogAuthKind {
  const status = stringValue(asRecord(surface.auth)?.status)?.toLowerCase();
  if (status === "none") {
    return "none";
  }
  if (status && ["oauth2", "oauth2_cc", "oauth1"].includes(status)) {
    return "oauth2";
  }
  if (status && ["api_key", "bearer", "basic"].includes(status)) {
    return "api_key";
  }
  const types = credentialFacts.map((fact) => stringValue(fact.type)?.toLowerCase()).filter((type): type is string => !!type);
  if (types.some((type) => ["oauth2", "oauth2_cc", "oauth1"].includes(type))) {
    return "oauth2";
  }
  if (types.some((type) => ["api_key", "bearer", "basic"].includes(type))) {
    return "api_key";
  }
  return "unknown";
}

function importableMcpUrl(value: string | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!value) {
    return { ok: false, reason: "missing_url" };
  }
  if (/\{[^}]+\}|<[^>]+>|YOUR[-_A-Z0-9]*|REDACTED/i.test(value)) {
    return { ok: false, reason: "templated_url" };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "non_http_url" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

function normalizeTransport(value: unknown): "streamable-http" | null {
  const transports = Array.isArray(value) ? value : [value];
  return transports.some((transport) => stringValue(transport) === "streamable-http") ? "streamable-http" : null;
}

function normalizeDomain(value: unknown): string | null {
  const raw = stringValue(value)?.trim().toLowerCase();
  return raw || null;
}

function normalizeAuthKind(value: unknown): CatalogAuthKind {
  const raw = stringValue(value);
  return raw === "oauth2" || raw === "api_key" || raw === "none" || raw === "unknown" ? raw : "unknown";
}

function normalizeProvenance(value: unknown): string {
  const raw = stringValue(value);
  return raw && raw.trim() ? raw.trim() : "unknown";
}

function normalizeNameForDedupe(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function bestCatalogRow(left: CatalogIntegrationRow, right: CatalogIntegrationRow): CatalogIntegrationRow {
  const leftScore = catalogRowQualityScore(left);
  const rightScore = catalogRowQualityScore(right);
  if (rightScore !== leftScore) {
    return rightScore > leftScore ? right : left;
  }
  return stableRowSortKey(right) < stableRowSortKey(left) ? right : left;
}

function catalogRowQualityScore(row: CatalogIntegrationRow): number {
  let score = 0;
  if (row.logoSourceUrl) {
    score += 4;
  }
  if (row.provenance === "detected") {
    score += 2;
  } else if (row.provenance !== "discovered") {
    score += 1;
  }
  if (row.authKind !== "unknown") {
    score += 1;
  }
  if (row.scopesHint.length > 0) {
    score += 1;
  }
  if (row.credentialFacts.length > 0) {
    score += 1;
  }
  return score;
}

function stableRowSortKey(row: CatalogIntegrationRow): string {
  return `${row.domain}\n${row.name}\n${row.provenance}\n${row.logoSourceUrl ?? ""}\n${row.mcpUrl}`;
}

function normalizedContentType(value: string | null): string | null {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/svg+xml") {
    return "svg";
  }
  if (contentType === "image/jpeg") {
    return "jpg";
  }
  if (contentType === "image/png") {
    return "png";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/x-icon" || contentType === "image/vnd.microsoft.icon") {
    return "ico";
  }
  return "img";
}

function safePathSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "integration";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripControlCharacters(value: unknown, counter: { count: number }): unknown {
  if (typeof value === "string") {
    const stripped = value.replace(/[\u0000-\u0008\u000B-\u001F]/g, "");
    if (stripped !== value) {
      counter.count += 1;
    }
    return stripped;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripControlCharacters(item, counter));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripControlCharacters(item, counter)]));
  }
  return value;
}

function parseArgs(argv: string[]): { snapshotPath: string; dryRun: boolean; skipLogos: boolean; snapshotRef?: string } {
  let snapshotPath = "";
  let dryRun = false;
  let skipLogos = false;
  let snapshotRef: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--snapshot") {
      snapshotPath = argv[++index] ?? "";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-logos") {
      skipLogos = true;
    } else if (arg === "--snapshot-ref") {
      snapshotRef = argv[++index];
    } else if (!arg.startsWith("--") && !snapshotPath) {
      snapshotPath = arg;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!snapshotPath) {
    throw new Error("missing --snapshot <path>");
  }
  return { snapshotPath, dryRun, skipLogos, ...(snapshotRef ? { snapshotRef } : {}) };
}

function printUsage(): void {
  console.log("Usage: bun scripts/import-integrations-catalog.ts --snapshot <snapshot.json> [--dry-run] [--skip-logos] [--snapshot-ref <label>]");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await readSnapshotFile(args.snapshotPath);
  const normalized = normalizeCatalogSnapshot(snapshot);
  if (args.dryRun) {
    console.log(JSON.stringify({
      generatedAt: normalized.generatedAt,
      before: normalized.cleaning.inputRows,
      after: normalized.cleaning.outputRows,
      importable: normalized.rows.length,
      skipped: normalized.skipped.length,
      quarantined: normalized.quarantined.length,
      cleaning: normalized.cleaning,
    }, null, 2));
    process.exit(0);
  }
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  try {
    const storage = args.skipLogos ? null : createObjectStorage(settings);
    const result = await importIntegrationsCatalog({
      db: dbClient.db,
      snapshot,
      snapshotRef: args.snapshotRef ?? basename(args.snapshotPath),
      storage,
      storeLogos: !args.skipLogos,
    });
    console.log(JSON.stringify({
      batchId: result.batch.id,
      before: normalized.cleaning.inputRows,
      after: normalized.cleaning.outputRows,
      imported: result.importedCount,
      skipped: result.skippedCount,
      quarantined: result.quarantinedCount,
      stale: result.staleCount,
      logoFailures: result.logoFailureCount,
      cleaning: normalized.cleaning,
    }, null, 2));
  } finally {
    await dbClient.close();
  }
}
