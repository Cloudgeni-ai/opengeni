import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { curatedCatalogEntriesByMcpUrl } from "./catalog-curation";
import {
  VENDORED_LOGO_DIRECTORY,
  extensionForContentType,
  fetchLogoAsset,
  parseVendoredLogoManifest,
  readVendoredLogoAsset,
  serializeVendoredLogoManifest,
  vendoredLogosByCapabilityId,
  type LogoFetch,
  type VendoredLogoEntry,
  type VendoredLogoManifest,
} from "./catalog-vendored-logos";
import {
  catalogCapabilityId,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  type CatalogIntegrationRow,
} from "./import-integrations-catalog";

/**
 * Regenerates `data/catalog/logos/` from the current snapshot plus curated
 * overlay: one validated asset per curated row whose effective logo source is
 * published, fetched once here so deployments never fetch it. A curated
 * `logoSourceUrl: null` (no reusable logo licence) is deliberately skipped and
 * keeps the monogram. This is the same PR workflow as `catalog:refresh`: run
 * it, review the diff, commit.
 */

const DEFAULT_SNAPSHOT_PATH = "data/catalog/integrations-snapshot.json";
const MANIFEST_FILE = "manifest.json";
/** Directory bookkeeping that is not a vendored asset and must survive a regeneration. */
const NON_ASSET_FILES: ReadonlySet<string> = new Set([MANIFEST_FILE, "README.md"]);
const CAPABILITY_ID_PREFIX = "mcp:integrations-sh:";

export type VendorLogosResult = {
  manifest: VendoredLogoManifest;
  /** Curated rows that fetched and validated a new or changed asset. */
  written: string[];
  /** Curated rows whose committed asset was already byte-identical. */
  unchanged: string[];
  /** Curated rows kept on their previously vendored asset after a failed refetch. */
  retained: Array<{ capabilityId: string; reason: string }>;
  /** Curated rows with no usable asset after this run. */
  failed: Array<{ capabilityId: string; domain: string; sourceUrl: string; reason: string }>;
  /** Curated rows whose overlay suppresses the logo (`logoSourceUrl: null`). */
  suppressed: Array<{ capabilityId: string; domain: string }>;
  /** Files removed because no curated row references them anymore. */
  removed: string[];
  totalBytes: number;
};

export function vendoredLogoFileName(capabilityId: string, contentType: string): string {
  const stem = capabilityId.startsWith(CAPABILITY_ID_PREFIX)
    ? capabilityId.slice(CAPABILITY_ID_PREFIX.length)
    : capabilityId;
  const safe = stem
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const extension = extensionForContentType(contentType);
  if (!extension) {
    // Unreachable through the vendoring flow: only a validated asset reaches
    // here, and validation rejects every content type the route cannot serve.
    throw new Error(`unsupported logo content type: ${contentType}`);
  }
  return `${safe || "logo"}.${extension}`;
}

/** Curated rows in import order, split by whether the overlay permits a logo. */
export function curatedLogoCandidates(rows: readonly CatalogIntegrationRow[]): {
  fetchable: Array<{ row: CatalogIntegrationRow; capabilityId: string; sourceUrl: string }>;
  suppressed: Array<{ capabilityId: string; domain: string }>;
} {
  const fetchable: Array<{ row: CatalogIntegrationRow; capabilityId: string; sourceUrl: string }> =
    [];
  const suppressed: Array<{ capabilityId: string; domain: string }> = [];
  for (const row of rows) {
    if (!curatedCatalogEntriesByMcpUrl.has(row.mcpUrl)) continue;
    const capabilityId = catalogCapabilityId(row.domain, row.mcpUrl);
    if (row.logoSourceUrl) {
      fetchable.push({ row, capabilityId, sourceUrl: row.logoSourceUrl });
    } else {
      suppressed.push({ capabilityId, domain: row.domain });
    }
  }
  return { fetchable, suppressed };
}

async function readExistingManifest(directory: string): Promise<VendoredLogoManifest> {
  let source: string;
  try {
    source = await readFile(join(directory, MANIFEST_FILE), "utf8");
  } catch {
    return { version: 1, entries: [] };
  }
  return parseVendoredLogoManifest(JSON.parse(source));
}

export async function vendorCatalogLogos(input: {
  snapshot: unknown;
  directory?: string;
  fetchImpl?: LogoFetch;
  now?: () => Date;
  dryRun?: boolean;
}): Promise<VendorLogosResult> {
  const directory = input.directory ?? VENDORED_LOGO_DIRECTORY;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const normalized = normalizeCatalogSnapshot(input.snapshot);
  if (normalized.unmatchedCurated.length > 0) {
    throw new Error(
      `curated entries match no importable snapshot row: ${normalized.unmatchedCurated.join(", ")}`,
    );
  }
  await mkdir(directory, { recursive: true });
  const previous = vendoredLogosByCapabilityId(await readExistingManifest(directory));
  const { fetchable, suppressed } = curatedLogoCandidates(normalized.rows);

  const entries: VendoredLogoEntry[] = [];
  const written: string[] = [];
  const unchanged: string[] = [];
  const retained: VendorLogosResult["retained"] = [];
  const failed: VendorLogosResult["failed"] = [];
  const pendingWrites: Array<{ file: string; bytes: Uint8Array }> = [];

  for (const { row, capabilityId, sourceUrl } of fetchable) {
    const prior = previous.get(capabilityId);
    const fetched = await fetchLogoAsset(sourceUrl, fetchImpl);
    if (!fetched.ok) {
      // Never write an invalid asset. Keep a still-valid prior asset for the
      // same source so a transient outage does not strip a committed logo.
      const priorAsset =
        prior && prior.sourceUrl === sourceUrl
          ? await readVendoredLogoAsset(prior, directory)
          : null;
      if (prior && priorAsset?.ok) {
        entries.push(prior);
        retained.push({ capabilityId, reason: fetched.reason });
      } else {
        failed.push({ capabilityId, domain: row.domain, sourceUrl, reason: fetched.reason });
      }
      continue;
    }
    const file = vendoredLogoFileName(capabilityId, fetched.contentType);
    const identical =
      prior !== undefined &&
      prior.file === file &&
      prior.sha256 === fetched.sha256 &&
      prior.sourceUrl === sourceUrl &&
      prior.contentType === fetched.contentType &&
      prior.sizeBytes === fetched.bytes.byteLength;
    const entry: VendoredLogoEntry = {
      capabilityId,
      domain: row.domain,
      mcpUrl: row.mcpUrl,
      file,
      sourceUrl,
      sha256: fetched.sha256,
      contentType: fetched.contentType,
      sizeBytes: fetched.bytes.byteLength,
      fetchedAt: identical ? prior.fetchedAt : now().toISOString(),
    };
    entries.push(entry);
    if (identical) {
      unchanged.push(capabilityId);
    } else {
      written.push(capabilityId);
      pendingWrites.push({ file, bytes: fetched.bytes });
    }
  }

  const manifest: VendoredLogoManifest = { version: 1, entries };
  const referenced = new Set(entries.map((entry) => entry.file));
  const removed: string[] = [];
  for (const name of await readdir(directory)) {
    if (NON_ASSET_FILES.has(name) || referenced.has(name)) continue;
    removed.push(name);
  }

  if (!input.dryRun) {
    for (const pending of pendingWrites) {
      await writeFile(join(directory, pending.file), pending.bytes);
    }
    for (const name of removed) {
      await unlink(join(directory, name));
    }
    await writeFile(join(directory, MANIFEST_FILE), serializeVendoredLogoManifest(manifest));
  }

  return {
    manifest,
    written,
    unchanged,
    retained,
    failed,
    suppressed,
    removed,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

function parseArgs(argv: string[]): { snapshotPath: string; dryRun: boolean } {
  let snapshotPath = DEFAULT_SNAPSHOT_PATH;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--snapshot") {
      snapshotPath = argv[++index] ?? "";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/vendor-catalog-logos.ts [--snapshot <snapshot.json>] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!snapshotPath) throw new Error("missing --snapshot <path>");
  return { snapshotPath, dryRun };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const result = await vendorCatalogLogos({
    snapshot: await readSnapshotFile(args.snapshotPath),
    dryRun: args.dryRun,
  });
  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        vendored: result.manifest.entries.length,
        totalBytes: result.totalBytes,
        written: result.written,
        unchanged: result.unchanged.length,
        retained: result.retained,
        suppressed: result.suppressed,
        removed: result.removed,
        failed: result.failed,
      },
      null,
      2,
    ),
  );
  if (result.failed.length > 0) {
    process.exit(1);
  }
}
