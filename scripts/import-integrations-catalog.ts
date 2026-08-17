import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  createDb,
  createImportBatch,
  findCompletedImportBatch,
  markStaleRegistryCatalogItems,
  updateImportBatchCounts,
  upsertRegistryCapabilityCatalogItem,
  type Database,
  type ImportBatch,
  type RegistryCapabilityCatalogItemInput,
} from "@opengeni/db";
import { createObjectStorage, type ObjectStorage } from "../packages/storage/src/index";
import {
  CURATED_CATALOG,
  canonicalMcpUrl,
  curatedCatalogEntriesByMcpUrl,
  curatedCatalogFingerprintInput,
  type CuratedCatalog,
} from "./catalog-curation";
import {
  VENDORED_LOGO_DIRECTORY,
  VENDORED_LOGO_MANIFEST,
  catalogLogoObjectKey,
  fetchLogoAsset,
  readVendoredLogoAsset,
  vendoredLogoManifestFingerprintInput,
  vendoredLogosByCapabilityId,
  type LogoFetch,
  type VendoredLogoEntry,
  type VendoredLogoManifest,
} from "./catalog-vendored-logos";

const SOURCE = "integrations.sh";
const MIT_ATTRIBUTION =
  "Seed catalog metadata imported from integrations.sh / UsefulSoftwareCo integrationsdotsh (MIT License, Copyright (c) 2026 Rhys Sullivan).";

// Bump deliberately whenever normalization or import semantics can change
// persisted output without changing the reviewed snapshot bytes.
export const CATALOG_IMPORT_SEMANTIC_VERSION = 2;

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
  [
    "activepieces.com\nhttps://www.activepieces.com/.well-known/mcp/server-card.json",
    "server-card JSON URL needs manual confirmation before enablement",
  ],
  [
    "netatmo.com\nhttps://www.netatmo.com/.well-known/mcp/server-card.json",
    "server-card JSON URL needs manual confirmation before enablement",
  ],
  [
    "doordash.com\nhttps://openapi.doordash.com/mcp/consumer",
    "consumer API URL needs manual confirmation before enablement",
  ],
  [
    "natwest.com\nhttps://openapi.natwest.com/mortgages/v1/mcp-server-mortgages/mcp",
    "banking API URL needs manual confirmation before enablement",
  ],
  [
    "smartbear.com\nhttps://swagger.mcp.smartbear.com/mcp",
    "SmartBear Swagger endpoint needs manual confirmation before enablement",
  ],
]);

type UnknownRecord = Record<string, unknown>;

export type CatalogAuthKind = "oauth2" | "api_key" | "none" | "unknown";
export type CatalogTier = "verified" | "community";

export type CatalogIntegrationRow = {
  domain: string;
  name: string;
  description?: string;
  /** Curated grouping; absent means the registry-wide default. */
  category?: string;
  /** Curated: promoted to the featured strip. Not a security review. */
  featured?: boolean;
  /** Curated: the provider publishes this server on its own domain. */
  official?: boolean;
  mcpUrl: string;
  transport: "streamable-http";
  authKind: CatalogAuthKind;
  scopesHint: string[];
  allowedTools?: string[];
  requireApproval?: boolean | string[];
  connectionOwnership?: "personal_only";
  oauthProfile?: Record<string, unknown>;
  credentialFacts: Array<Record<string, unknown>>;
  tier: CatalogTier;
  provenance: string;
  logoSourceUrl: string | null;
  homepageUrl?: string;
  installUrl?: string;
  documentationUrl?: string;
  registryName?: string;
  registryVersion?: string;
  registryStatus?: string;
  registryIsLatest?: boolean;
  registryPublishedAt?: string;
  repositorySource?: string;
  repositoryUrl?: string;
  sourceCommit?: string;
  probe?: Record<string, unknown>;
  authContract?: Record<string, unknown>;
};

export type NormalizedCatalogSnapshot = {
  generatedAt: string | null;
  rows: CatalogIntegrationRow[];
  skipped: Array<{
    domain: string | null;
    mcpUrl: string | null;
    reason: string;
  }>;
  quarantined: Array<{ row: CatalogIntegrationRow; reason: string }>;
  /**
   * Curated overlay entries whose MCP URL matched no surviving snapshot row.
   * A dead entry means a reviewed contract silently applies to nothing, so it
   * is reported like a skip rather than dropped.
   */
  unmatchedCurated: string[];
  cleaning: {
    inputRows: number;
    outputRows: number;
    skippedRows: number;
    quarantinedRows: number;
    duplicateDomainNameRows: number;
    duplicateEndpointRows: number;
    unverifiedRows: number;
    controlCharacterFields: number;
  };
};

export type LogoStorageResult =
  | {
      ok: true;
      path: string;
      sourceUrl: string;
      contentType: string;
      sizeBytes: number;
    }
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
  logoFailures: Array<{
    domain: string;
    mcpUrl: string;
    reason: string;
    sourceUrl: string | null;
  }>;
};

export type LogoStorage = Pick<ObjectStorage, "putObject"> & {
  bucket?: string;
};
export type { LogoFetch } from "./catalog-vendored-logos";

/**
 * Where a row's rendered logo came from. `vendored` bytes are committed under
 * `data/catalog/logos/`; `integrations.sh` bytes were fetched during this
 * import; `generic_monogram` means no self-hosted asset exists for the row.
 */
export type CatalogLogoSource = "vendored" | "integrations.sh" | "generic_monogram";

export type CatalogLogoResolution = {
  logoAssetPath: string | null;
  logoSource: CatalogLogoSource;
  failure: { reason: string; sourceUrl: string | null } | null;
};

/**
 * Constructs object storage for the importer, or null when it cannot be built.
 *
 * `createObjectStorage` returns null only for an unconfigured s3-compatible
 * backend; azure-blob, aws-s3, and gcs throw on missing or malformed settings.
 * Both outcomes mean the same thing here: no self-hosted logo bytes, so every
 * row falls back to a monogram and the catalog still imports.
 */
export function resolveLogoObjectStorage(
  settings: Parameters<typeof createObjectStorage>[0],
): ObjectStorage | null {
  try {
    return createObjectStorage(settings);
  } catch (error) {
    console.warn(
      JSON.stringify({
        warning: "object_storage_unavailable",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

export async function readSnapshotFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeCleanCatalogSnapshot(
  path: string,
  snapshot: unknown,
): Promise<NormalizedCatalogSnapshot> {
  const normalized = normalizeCatalogSnapshot(snapshot);
  await writeFile(
    path,
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
  return normalized;
}

export function normalizeCatalogSnapshot(
  snapshot: unknown,
  options: { allowUnprobedCandidates?: boolean } = {},
): NormalizedCatalogSnapshot {
  const controlCharacters = { count: 0 };
  const cleanedSnapshot = stripControlCharacters(snapshot, controlCharacters);
  const root = asRecord(cleanedSnapshot);
  const generatedAt = stringValue(root?.generatedAt) ?? stringValue(root?.snapshotDate) ?? null;
  const candidates = catalogCandidateRows(cleanedSnapshot);
  const skipped: NormalizedCatalogSnapshot["skipped"] = [];
  const quarantined: NormalizedCatalogSnapshot["quarantined"] = [];
  const candidatesByDomainName = new Map<string, CatalogIntegrationRow>();
  const seen = new Set<string>();
  let duplicateDomainNameRows = 0;
  let duplicateEndpointRows = 0;
  let unverifiedRows = 0;

  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate.domain);
    const rawMcpUrl = stringValue(candidate.mcpUrl);
    if (!domain) {
      skipped.push({ domain: null, mcpUrl: null, reason: "missing_domain" });
      continue;
    }
    if (deadDemoDomains.has(domain)) {
      skipped.push({ domain, mcpUrl: null, reason: "dead_demo_domain" });
      continue;
    }
    if (!rawMcpUrl) {
      skipped.push({ domain, mcpUrl: null, reason: "missing_url" });
      continue;
    }
    const rejectionReason = catalogMcpUrlRejection(rawMcpUrl);
    if (rejectionReason) {
      skipped.push({ domain, mcpUrl: null, reason: rejectionReason });
      continue;
    }
    const mcpUrl = canonicalMcpUrl(rawMcpUrl);
    const transport = normalizeTransport(candidate.transport ?? candidate.transports);
    if (!transport) {
      skipped.push({
        domain,
        mcpUrl: null,
        reason: "transport_not_streamable_http",
      });
      continue;
    }
    const key = `${domain}\n${mcpUrl}`;
    const provenance = normalizeProvenance(candidate.provenance ?? asRecord(candidate.basis)?.via);
    const probe = asRecord(candidate.probe);
    const probeStatus = stringValue(probe?.status);
    if (probeStatus !== "real") {
      // Production imports require probe evidence. Tests and offline cleaning
      // may explicitly opt into preserving pre-probe candidates, but an
      // observed unverified/junk result is never promoted by that option.
      if (probeStatus || !options.allowUnprobedCandidates) {
        unverifiedRows += 1;
        skipped.push({
          domain,
          mcpUrl: null,
          reason: probeStatus
            ? `probe_${probeStatus}:${stringValue(probe?.reason) ?? "unknown"}`
            : "probe_missing",
        });
        continue;
      }
    }
    const official = curatedCatalogEntriesByMcpUrl.get(mcpUrl);
    const authKind = official?.authKind ?? normalizeAuthKind(candidate.authKind);
    if (authKind === "unknown") {
      skipped.push({ domain, mcpUrl: null, reason: "auth_unknown" });
      continue;
    }
    const authContract = normalizeAuthContract(
      candidate.authContract ?? asRecord(candidate.metadata)?.authContract,
    );
    const logoSourceUrl =
      official?.logoSourceUrl !== undefined
        ? official.logoSourceUrl
        : candidate.logoSourceUrl === null
          ? null
          : (safeCatalogUrl(candidate.logoAsset) ??
            safeCatalogUrl(candidate.logoSourceUrl) ??
            `https://integrations.sh/logo/${domain}`);
    const registryIsLatest = official?.registryIsLatest ?? candidate.registryIsLatest;
    const row: CatalogIntegrationRow = {
      domain,
      name: official?.name ?? stringValue(candidate.name) ?? domain,
      ...optionalString("description", official?.description ?? stringValue(candidate.description)),
      ...optionalString("category", official?.category),
      ...(official?.featured ? { featured: true } : {}),
      ...(official?.official ? { official: true } : {}),
      mcpUrl,
      transport: "streamable-http",
      authKind,
      scopesHint: official?.scopesHint
        ? [...official.scopesHint]
        : stringArray(candidate.scopesHint),
      ...(official?.allowedTools ? { allowedTools: [...official.allowedTools] } : {}),
      ...(official?.requireApproval !== undefined
        ? {
            requireApproval:
              typeof official.requireApproval === "boolean"
                ? official.requireApproval
                : [...official.requireApproval],
          }
        : {}),
      ...(official?.connectionOwnership
        ? { connectionOwnership: official.connectionOwnership }
        : {}),
      ...(official?.oauthProfile
        ? { oauthProfile: official.oauthProfile as Record<string, unknown> }
        : {}),
      credentialFacts: recordArray(candidate.credentialFacts),
      tier: official?.tier ?? (provenance === "detected" ? "verified" : "community"),
      provenance: official?.provenance ?? provenance,
      logoSourceUrl,
      ...optionalString(
        "homepageUrl",
        official?.homepageUrl ?? safeCatalogUrl(candidate.homepageUrl),
      ),
      ...optionalString("installUrl", official?.installUrl ?? safeCatalogUrl(candidate.installUrl)),
      ...optionalString(
        "documentationUrl",
        official?.documentationUrl ?? safeCatalogUrl(candidate.documentationUrl),
      ),
      ...optionalString(
        "registryName",
        official?.registryName ?? stringValue(candidate.registryName),
      ),
      ...optionalString(
        "registryVersion",
        official?.registryVersion ?? stringValue(candidate.registryVersion),
      ),
      ...optionalString(
        "registryStatus",
        official?.registryStatus ?? stringValue(candidate.registryStatus),
      ),
      ...(typeof registryIsLatest === "boolean" ? { registryIsLatest } : {}),
      ...optionalString(
        "registryPublishedAt",
        official?.registryPublishedAt ?? stringValue(candidate.registryPublishedAt),
      ),
      ...optionalString(
        "repositorySource",
        official?.repositorySource ?? stringValue(candidate.repositorySource),
      ),
      ...optionalString(
        "repositoryUrl",
        official?.repositoryUrl ?? safeCatalogUrl(candidate.repositoryUrl),
      ),
      ...optionalString(
        "sourceCommit",
        official?.sourceCommit ?? stringValue(candidate.sourceCommit),
      ),
      ...(probe ? { probe } : {}),
      ...(authContract ? { authContract } : {}),
    };
    const suspiciousReason = suspiciousSurfaceUrls.get(key);
    if (suspiciousReason) {
      quarantined.push({ row, reason: suspiciousReason });
      continue;
    }
    if (authKind === "api_key" && !authContract) {
      // Credential prose is not a machine-actionable runtime contract. Keep
      // the row out of the registry rather than exposing a server that cannot
      // be connected safely.
      skipped.push({
        domain,
        mcpUrl: null,
        reason: "api_key_metadata_unactionable",
      });
      continue;
    }
    // Only accepted rows claim their normalized surface key. A missing or
    // failed probe must not shadow a later alias carrying usable evidence.
    if (seen.has(key)) {
      skipped.push({ domain, mcpUrl: null, reason: "duplicate_surface" });
      continue;
    }
    seen.add(key);
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
    skipped.push({
      domain: loser.domain,
      mcpUrl: null,
      reason: "duplicate_domain_name",
    });
  }

  const candidatesByEndpoint = new Map<string, CatalogIntegrationRow>();
  for (const row of candidatesByDomainName.values()) {
    const endpointKey = canonicalMcpUrl(row.mcpUrl);
    const existing = candidatesByEndpoint.get(endpointKey);
    if (!existing) {
      candidatesByEndpoint.set(endpointKey, row);
      continue;
    }
    duplicateEndpointRows += 1;
    const winner = bestCatalogRow(existing, row);
    const loser = winner === existing ? row : existing;
    candidatesByEndpoint.set(endpointKey, winner);
    skipped.push({
      domain: loser.domain,
      mcpUrl: null,
      reason: "duplicate_endpoint",
    });
  }

  const rows = [...candidatesByEndpoint.values()].sort(
    (left, right) =>
      left.domain.localeCompare(right.domain) ||
      left.name.localeCompare(right.name) ||
      left.mcpUrl.localeCompare(right.mcpUrl),
  );

  const matchedCurated = new Set(rows.map((row) => row.mcpUrl));
  const unmatchedCurated = [...curatedCatalogEntriesByMcpUrl.keys()]
    .filter((mcpUrl) => !matchedCurated.has(mcpUrl))
    .sort();

  return {
    generatedAt,
    rows,
    unmatchedCurated,
    skipped,
    quarantined,
    cleaning: {
      inputRows: candidates.length,
      outputRows: rows.length,
      skippedRows: skipped.length,
      quarantinedRows: quarantined.length,
      duplicateDomainNameRows,
      duplicateEndpointRows,
      unverifiedRows,
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
  /** `false` skips network logo fetches; vendored assets are still stored. */
  storeLogos?: boolean;
  /** Test seam. Production always uses the committed manifest and directory. */
  vendoredLogos?: VendoredLogoManifest | null;
  vendoredLogoDirectory?: string;
}): Promise<ImportCatalogResult> {
  const normalized = normalizeCatalogSnapshot(input.snapshot);
  if (normalized.rows.length === 0) {
    throw new Error(
      "catalog import produced zero importable rows; aborting before DB writes to avoid marking registry entries stale",
    );
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
  const vendoredLogos = vendoredLogosByCapabilityId(
    input.vendoredLogos === undefined
      ? VENDORED_LOGO_MANIFEST
      : (input.vendoredLogos ?? { version: 1, entries: [] }),
  );

  for (const row of normalized.rows) {
    const logo = await resolveCatalogRowLogo(row, {
      storage: input.storage ?? null,
      fetchImpl: input.fetchImpl ?? fetch,
      storeLogos: input.storeLogos !== false,
      vendoredLogos,
      ...(input.vendoredLogoDirectory
        ? { vendoredLogoDirectory: input.vendoredLogoDirectory }
        : {}),
    });
    if (logo.failure) {
      logoFailures.push({
        domain: row.domain,
        mcpUrl: row.mcpUrl,
        reason: logo.failure.reason,
        sourceUrl: logo.failure.sourceUrl,
      });
    }
    await upsertRegistryCapabilityCatalogItem(
      input.db,
      catalogRowToDbInput(row, {
        importBatchId: batch.id,
        logoAssetPath: logo.logoAssetPath,
        logoSource: logo.logoSource,
      }),
    );
  }

  const staleCount = await markStaleRegistryCatalogItems(
    input.db,
    normalized.rows.map((row) => ({
      providerDomain: row.domain,
      mcpUrl: row.mcpUrl,
    })),
    batch.id,
  );
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

export function catalogRowToDbInput(
  row: CatalogIntegrationRow,
  input: {
    importBatchId: string;
    logoAssetPath?: string | null;
    /** Defaults to the legacy derivation from `logoSourceUrl` when omitted. */
    logoSource?: CatalogLogoSource;
  },
): RegistryCapabilityCatalogItemInput {
  return {
    id: catalogCapabilityId(row.domain, row.mcpUrl),
    providerDomain: row.domain,
    name: row.name,
    description: row.description ?? null,
    mcpUrl: row.mcpUrl,
    transport: row.transport,
    authKind: row.authKind,
    credentialFacts: row.credentialFacts,
    tier: row.tier,
    provenance: row.provenance,
    logoAssetPath: input.logoAssetPath ?? null,
    importBatchId: input.importBatchId,
    scopesHint: row.scopesHint,
    homepageUrl: row.homepageUrl ?? `https://${row.domain}`,
    installUrl: row.installUrl ?? row.homepageUrl ?? `https://${row.domain}`,
    ...(row.category ? { category: row.category } : {}),
    tags: ["mcp", "integration", row.tier, row.authKind],
    metadata: {
      logoSource: input.logoSource ?? (row.logoSourceUrl ? "integrations.sh" : "generic_monogram"),
      originalLogoUrl: row.logoSourceUrl,
      ...(row.featured || row.official
        ? {
            curation: {
              ...(row.featured ? { featured: true } : {}),
              ...(row.official ? { official: true } : {}),
            },
          }
        : {}),
      ...(row.allowedTools ? { allowedTools: row.allowedTools } : {}),
      ...(row.requireApproval !== undefined ? { requireApproval: row.requireApproval } : {}),
      ...(row.connectionOwnership ? { connectionOwnership: row.connectionOwnership } : {}),
      ...(row.oauthProfile ? { oauthProfile: row.oauthProfile } : {}),
      ...(row.documentationUrl ? { documentationUrl: row.documentationUrl } : {}),
      ...(row.registryName
        ? {
            officialMcpRegistry: {
              name: row.registryName,
              ...(row.registryVersion ? { version: row.registryVersion } : {}),
              ...(row.registryStatus ? { status: row.registryStatus } : {}),
              ...(row.registryIsLatest !== undefined ? { isLatest: row.registryIsLatest } : {}),
              ...(row.registryPublishedAt ? { publishedAt: row.registryPublishedAt } : {}),
              ...(row.repositoryUrl
                ? {
                    repository: {
                      ...(row.repositorySource ? { source: row.repositorySource } : {}),
                      url: row.repositoryUrl,
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(row.sourceCommit ? { sourceCommit: row.sourceCommit } : {}),
      ...(row.probe ? { mcpProbe: row.probe } : {}),
      ...(row.authContract ? { authContract: row.authContract } : {}),
    },
  };
}

/**
 * Resolves the self-hosted logo for one row.
 *
 * Order of authority: a curated `logoSourceUrl: null` always wins and yields the
 * monogram with no fetch and no vendored copy, even if a vendored file exists.
 * Otherwise a vendored asset whose recorded source matches the row's effective
 * source is copied into object storage regardless of `storeLogos`, because it
 * adds no third-party dependency. Only the uncurated remainder is fetched from
 * the network, and only when `storeLogos` is true.
 */
export async function resolveCatalogRowLogo(
  row: CatalogIntegrationRow,
  input: {
    storage: LogoStorage | null;
    fetchImpl: LogoFetch;
    storeLogos: boolean;
    vendoredLogos: ReadonlyMap<string, VendoredLogoEntry>;
    vendoredLogoDirectory?: string;
  },
): Promise<CatalogLogoResolution> {
  const sourceUrl = row.logoSourceUrl;
  if (!sourceUrl) {
    return { logoAssetPath: null, logoSource: "generic_monogram", failure: null };
  }
  const vendored = input.vendoredLogos.get(catalogCapabilityId(row.domain, row.mcpUrl));
  if (vendored) {
    if (vendored.sourceUrl !== sourceUrl) {
      // The overlay or snapshot moved the row's logo source after vendoring.
      // Serving the stale bytes would misattribute them; regenerate instead.
      return {
        logoAssetPath: null,
        logoSource: "generic_monogram",
        failure: { reason: "vendored_logo_source_mismatch", sourceUrl },
      };
    }
    if (!input.storage) {
      return {
        logoAssetPath: null,
        logoSource: "generic_monogram",
        failure: { reason: "object_storage_unavailable", sourceUrl },
      };
    }
    const asset = await readVendoredLogoAsset(
      vendored,
      input.vendoredLogoDirectory ?? VENDORED_LOGO_DIRECTORY,
    );
    if (!asset.ok) {
      return {
        logoAssetPath: null,
        logoSource: "generic_monogram",
        failure: { reason: asset.reason, sourceUrl },
      };
    }
    const put = await putLogoObject(input.storage, row.domain, asset);
    if (!put.ok) {
      return {
        logoAssetPath: null,
        logoSource: "generic_monogram",
        failure: { reason: put.reason, sourceUrl },
      };
    }
    return { logoAssetPath: put.key, logoSource: "vendored", failure: null };
  }
  if (!input.storeLogos) {
    return { logoAssetPath: null, logoSource: "generic_monogram", failure: null };
  }
  const stored = await storeLogoForRow(row, {
    storage: input.storage,
    fetchImpl: input.fetchImpl,
  });
  if (stored.ok) {
    return { logoAssetPath: stored.path, logoSource: "integrations.sh", failure: null };
  }
  return {
    logoAssetPath: null,
    logoSource: "generic_monogram",
    failure: { reason: stored.reason, sourceUrl: stored.sourceUrl },
  };
}

export async function storeLogoForRow(
  row: CatalogIntegrationRow,
  input: {
    storage: LogoStorage | null;
    fetchImpl: LogoFetch;
  },
): Promise<LogoStorageResult> {
  const sourceUrl = row.logoSourceUrl;
  if (!sourceUrl) {
    return { ok: false, sourceUrl: null, reason: "logo_source_not_published" };
  }
  if (!input.storage) {
    return { ok: false, sourceUrl, reason: "object_storage_unavailable" };
  }
  const asset = await fetchLogoAsset(sourceUrl, input.fetchImpl);
  if (!asset.ok) {
    return { ok: false, sourceUrl, reason: asset.reason };
  }
  const put = await putLogoObject(input.storage, row.domain, asset);
  if (!put.ok) {
    return { ok: false, sourceUrl, reason: put.reason };
  }
  return {
    ok: true,
    path: put.key,
    sourceUrl,
    contentType: asset.contentType,
    sizeBytes: asset.bytes.byteLength,
  };
}

/**
 * Stores one validated logo asset.
 *
 * A logo is cosmetic: the catalog row is correct with a monogram. Object
 * storage is a third-party service that can be transiently unavailable,
 * misconfigured, or read-only, and the importer runs as the Helm
 * `catalog-import` hook Job, so letting a rejected `putObject` escape would
 * fail the whole deployment hook over an icon. Every storage outcome is
 * therefore reported as a recorded logo failure, exactly like a rejected fetch
 * or an invalid asset.
 */
async function putLogoObject(
  storage: LogoStorage,
  domain: string,
  asset: { contentType: string; sha256: string; bytes: Uint8Array },
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  try {
    const key = catalogLogoObjectKey(domain, asset.sha256, asset.contentType);
    await storage.putObject({
      key,
      contentType: asset.contentType,
      body: asset.bytes,
      sha256: asset.sha256,
    });
    return { ok: true, key };
  } catch (error) {
    return {
      ok: false,
      reason: `logo_store_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function catalogCapabilityId(domain: string, mcpUrl: string): string {
  return `mcp:integrations-sh:${slugify(domain)}-${shortHash(`${domain}:${mcpUrl}`)}`;
}

/**
 * The pre-normalization candidate rows of any accepted snapshot shape: a
 * precomputed `importRows`/`rows` list (or bare array), else the raw
 * integrations.sh index plus per-domain surface documents.
 */
export function catalogCandidateRows(snapshot: unknown): UnknownRecord[] {
  return precomputedRows(snapshot) ?? rawSurfaceRows(asRecord(snapshot));
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
  const flatEntries = arrayValue(
    root.api ?? root.catalog ?? root.flatCatalog ?? root.entries ?? root.data,
  ).filter(isRecord);
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
      const authContract = deriveAuthContract(surfaceRecord);
      rows.push({
        domain,
        name: stringValue(flat?.name) ?? stringValue(surfaceRecord.name) ?? domain,
        mcpUrl: stringValue(surfaceRecord.url),
        transport: surfaceRecord.transports ?? surfaceRecord.transport,
        authKind: deriveAuthKind(surfaceRecord, credentialFacts),
        ...(authContract ? { authContract } : {}),
        scopesHint: scopesHintForSurface(surfaceRecord),
        credentialFacts,
        provenance: asRecord(surfaceRecord.basis)?.via ?? surfaceRecord.provenance,
        logoAsset:
          stringValue(flat?.icon) ??
          stringValue(surfaceRecord.icon) ??
          `https://integrations.sh/logo/${domain}`,
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

function credentialFactsForSurface(
  surface: UnknownRecord,
  credentials: UnknownRecord,
): Array<Record<string, unknown>> {
  const ids = referencedCredentialIds(surface);
  return ids.flatMap((id): Array<Record<string, unknown>> => {
    const credential = asRecord(credentials[id]);
    if (!credential) {
      return [];
    }
    return [
      {
        id,
        type: stringValue(credential.type) ?? "unknown",
        generateUrl: stringValue(credential.generateUrl) ?? null,
        setup: stringValue(credential.setup) ?? null,
        fields: asRecord(credential.fields),
      },
    ];
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

function deriveAuthKind(
  surface: UnknownRecord,
  credentialFacts: Array<Record<string, unknown>>,
): CatalogAuthKind {
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
  const types = credentialFacts
    .map((fact) => stringValue(fact.type)?.toLowerCase())
    .filter((type): type is string => !!type);
  if (types.some((type) => ["oauth2", "oauth2_cc", "oauth1"].includes(type))) {
    return "oauth2";
  }
  if (types.some((type) => ["api_key", "bearer", "basic"].includes(type))) {
    return "api_key";
  }
  return "unknown";
}

function deriveAuthContract(surface: UnknownRecord): Record<string, unknown> | null {
  const auth = asRecord(surface.auth);
  return normalizeAuthContract(surface.authContract ?? auth?.authContract ?? auth?.headerContract);
}

/**
 * Reject URL forms whose authority cannot be proven public during catalog
 * import. Query strings, opaque path segments, and credentials must never be
 * persisted as an MCP endpoint or retained in a rejected diagnostic.
 */
export function catalogMcpUrlRejection(value: string | null | undefined): string | null {
  if (!value) {
    return "missing_url";
  }
  if (/\{[^}]+\}|<[^>]+>|YOUR[-_A-Z0-9]*|REDACTED/i.test(value)) {
    return "templated_url";
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "non_http_url";
    }
    if (parsed.username || parsed.password) {
      return "credential_in_url";
    }
    if (parsed.hash) {
      return "url_fragment";
    }
    if (parsed.search) {
      return "credential_query_parameter";
    }
    if (parsed.pathname.split("/").some((segment) => segment.length >= 24)) {
      return "opaque_path_segment";
    }
    return null;
  } catch {
    return "invalid_url";
  }
}

function normalizeTransport(value: unknown): "streamable-http" | null {
  const transports = Array.isArray(value) ? value : [value];
  return transports.some((transport) => stringValue(transport) === "streamable-http")
    ? "streamable-http"
    : null;
}

function normalizeDomain(value: unknown): string | null {
  const raw = stringValue(value)?.trim().toLowerCase();
  return raw || null;
}

export { canonicalMcpUrl };

function normalizeAuthContract(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const headerName = stringValue(record.headerName);
  const scheme = stringValue(record.scheme);
  if (!headerName || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(headerName) || !scheme) {
    return null;
  }
  return {
    headerName,
    scheme,
  };
}

function normalizeAuthKind(value: unknown): CatalogAuthKind {
  const raw = stringValue(value);
  return raw === "oauth2" || raw === "api_key" || raw === "none" || raw === "unknown"
    ? raw
    : "unknown";
}

function normalizeProvenance(value: unknown): string {
  const raw = stringValue(value);
  return raw && raw.trim() ? raw.trim() : "unknown";
}

function normalizeNameForDedupe(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function bestCatalogRow(
  left: CatalogIntegrationRow,
  right: CatalogIntegrationRow,
): CatalogIntegrationRow {
  const leftScore = catalogRowQualityScore(left);
  const rightScore = catalogRowQualityScore(right);
  if (rightScore !== leftScore) {
    return rightScore > leftScore ? right : left;
  }
  return stableRowSortKey(right) < stableRowSortKey(left) ? right : left;
}

function catalogRowQualityScore(row: CatalogIntegrationRow): number {
  let score = 0;
  try {
    const endpointHost = new URL(row.mcpUrl).hostname.toLowerCase();
    if (endpointHost === row.domain || endpointHost.endsWith(`.${row.domain}`)) {
      score += 8;
    }
  } catch {
    // URL validity was already checked. Keep scoring total if a future caller
    // constructs a row directly in a test.
  }
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

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "integration"
  );
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalString<Key extends string>(
  key: Key,
  value: string | null | undefined,
): { [Property in Key]?: string } {
  return value ? ({ [key]: value } as { [Property in Key]?: string }) : {};
}

function safeCatalogUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
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
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripControlCharacters(item, counter)]),
    );
  }
  return value;
}

function parseArgs(argv: string[]): {
  snapshotPath: string;
  dryRun: boolean;
  skipLogos: boolean;
  ifChanged: boolean;
  snapshotRef?: string;
} {
  let snapshotPath = "";
  let dryRun = false;
  let skipLogos = false;
  let ifChanged = false;
  let snapshotRef: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--snapshot") {
      snapshotPath = argv[++index] ?? "";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-logos") {
      skipLogos = true;
    } else if (arg === "--if-changed") {
      ifChanged = true;
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
  return {
    snapshotPath,
    dryRun,
    skipLogos,
    ifChanged,
    ...(snapshotRef ? { snapshotRef } : {}),
  };
}

function printUsage(): void {
  console.log(
    "Usage: bun scripts/import-integrations-catalog.ts --snapshot <snapshot.json> [--dry-run] [--skip-logos] [--if-changed] [--snapshot-ref <label>]",
  );
}

export async function catalogImportFingerprint(input: {
  snapshotPath: string;
  snapshotRef?: string;
  skipLogos?: boolean;
  semanticVersion?: number;
  /** Test seam. Production always fingerprints the committed overlay. */
  curatedCatalog?: CuratedCatalog;
  /** Test seam. Production always fingerprints the committed vendored manifest. */
  vendoredLogos?: VendoredLogoManifest;
}): Promise<string> {
  const semanticVersion = input.semanticVersion ?? CATALOG_IMPORT_SEMANTIC_VERSION;
  if (!Number.isSafeInteger(semanticVersion) || semanticVersion < 1 || semanticVersion > 9999) {
    throw new Error("catalog import semantic version must be an integer between 1 and 9999");
  }
  const snapshotSha256 = createHash("sha256")
    .update(await readFile(input.snapshotPath))
    .digest("hex");
  // The curated overlay is bundled into the importer, so it is part of the
  // effective input. Hash its canonical parsed form: an overlay-only PR must
  // invalidate `--if-changed`, while whitespace-only reformatting must not.
  const curatedSha256 = createHash("sha256")
    .update(curatedCatalogFingerprintInput(input.curatedCatalog ?? CURATED_CATALOG))
    .digest("hex");
  // Vendored logos are copied into object storage by every import, so a new or
  // replaced asset must invalidate `--if-changed` exactly like the overlay.
  const vendoredLogosSha256 = createHash("sha256")
    .update(vendoredLogoManifestFingerprintInput(input.vendoredLogos ?? VENDORED_LOGO_MANIFEST))
    .digest("hex");
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        importerSemanticVersion: semanticVersion,
        skipLogos: input.skipLogos === true,
        snapshotRef: input.snapshotRef ?? null,
        snapshotSha256,
        curatedSha256,
        vendoredLogosSha256,
      }),
    )
    .digest("hex");
  return `catalog-import-v${semanticVersion}@sha256:${digest}`;
}

export async function resolveIfChangedCatalogImport<T>(
  input: {
    snapshotPath: string;
    snapshotRef?: string;
    skipLogos?: boolean;
    importedCount: number;
    semanticVersion?: number;
  },
  findCompleted: (input: {
    source: string;
    snapshotRef: string;
    importedCount: number;
  }) => Promise<T | null>,
): Promise<{ snapshotRef: string; completedBatch: T | null }> {
  const snapshotRef = await catalogImportFingerprint(input);
  const completedBatch = await findCompleted({
    source: SOURCE,
    snapshotRef,
    importedCount: input.importedCount,
  });
  return { snapshotRef, completedBatch };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await readSnapshotFile(args.snapshotPath);
  const normalized = normalizeCatalogSnapshot(snapshot);
  if (normalized.unmatchedCurated.length > 0) {
    // A reviewed contract that matches no row would silently apply to nothing.
    // Fail the import so the mismatch is fixed at review time, not discovered
    // when a user sees the raw aggregator name.
    console.error(
      JSON.stringify(
        {
          error: "curated_entries_unmatched",
          detail:
            "data/catalog/curated.json has entries whose mcpUrl matches no importable snapshot row",
          unmatchedCurated: normalized.unmatchedCurated,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          generatedAt: normalized.generatedAt,
          before: normalized.cleaning.inputRows,
          after: normalized.cleaning.outputRows,
          importable: normalized.rows.length,
          skipped: normalized.skipped.length,
          quarantined: normalized.quarantined.length,
          cleaning: normalized.cleaning,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const dbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
  });
  try {
    const importDecision = args.ifChanged
      ? await resolveIfChangedCatalogImport(
          {
            snapshotPath: args.snapshotPath,
            ...(args.snapshotRef ? { snapshotRef: args.snapshotRef } : {}),
            skipLogos: args.skipLogos,
            importedCount: normalized.rows.length,
          },
          (input) => findCompletedImportBatch(dbClient.db, input),
        )
      : {
          snapshotRef: args.snapshotRef ?? basename(args.snapshotPath),
          completedBatch: null,
        };
    const { snapshotRef, completedBatch } = importDecision;
    if (completedBatch) {
      console.log(
        JSON.stringify(
          {
            unchanged: true,
            batchId: completedBatch.id,
            imported: completedBatch.importedCount,
            snapshotRef,
          },
          null,
          2,
        ),
      );
      await dbClient.close();
      process.exit(0);
    }
    // Vendored curated logos are stored even with --skip-logos; the flag only
    // suppresses network fetches for the uncurated long tail. Only the
    // s3-compatible backend returns null when unconfigured; azure-blob, aws-s3,
    // and gcs throw. A deployment without usable object storage must still
    // import the catalog and fall back to monograms, so construction failure is
    // reported and degraded rather than fatal.
    const storage = resolveLogoObjectStorage(settings);
    const result = await importIntegrationsCatalog({
      db: dbClient.db,
      snapshot,
      snapshotRef,
      storage,
      storeLogos: !args.skipLogos,
    });
    console.log(
      JSON.stringify(
        {
          batchId: result.batch.id,
          before: normalized.cleaning.inputRows,
          after: normalized.cleaning.outputRows,
          imported: result.importedCount,
          skipped: result.skippedCount,
          quarantined: result.quarantinedCount,
          stale: result.staleCount,
          logoFailures: result.logoFailureCount,
          cleaning: normalized.cleaning,
        },
        null,
        2,
      ),
    );
  } finally {
    await dbClient.close();
  }
}
