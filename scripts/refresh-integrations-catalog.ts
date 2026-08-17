import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { canonicalMcpUrl } from "./catalog-curation";
import { probeCatalogSnapshot } from "./integrations-catalog-probe";
import {
  catalogCandidateRows,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

const DEFAULT_SOURCE_URL = "https://integrations.sh/api.json";
const DEFAULT_OUTPUT_PATH = "data/catalog/integrations-snapshot.json";
const SOURCE = "integrations.sh";
const DISCOVERY_CONCURRENCY = 8;
const DISCOVERY_TIMEOUT_MS = 30_000;

type RefreshArgs = {
  sourceUrl: string;
  inputPath?: string;
  outputPath: string;
  retainCommittedRows: boolean;
};

function parseArgs(argv: string[]): RefreshArgs {
  let sourceUrl = DEFAULT_SOURCE_URL;
  let inputPath: string | undefined;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let retainCommittedRows = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--url") {
      sourceUrl = argv[++index] ?? "";
    } else if (arg === "--input") {
      inputPath = argv[++index] ?? "";
    } else if (arg === "--output") {
      outputPath = argv[++index] ?? "";
    } else if (arg === "--no-retain") {
      retainCommittedRows = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!sourceUrl && !inputPath) {
    throw new Error("missing --url <url> or --input <path>");
  }
  if (!outputPath) {
    throw new Error("missing --output <path>");
  }
  return { sourceUrl, ...(inputPath ? { inputPath } : {}), outputPath, retainCommittedRows };
}

function printUsage(): void {
  console.log(
    "Usage: bun run catalog:refresh [--url <catalog-json-url> | --input <raw-snapshot.json>] [--output data/catalog/integrations-snapshot.json] [--no-retain]",
  );
}

async function fetchJson(url: string, timeoutMs?: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch integrations catalog from ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function indexEntries(root: UnknownRecord): UnknownRecord[] {
  const entries = root.api ?? root.catalog ?? root.flatCatalog ?? root.entries ?? root.data;
  return Array.isArray(entries)
    ? entries.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function hasSurfaceDocs(root: UnknownRecord): boolean {
  const docs = root.surfaceDocs ?? root.surfaces ?? root.domains;
  return Array.isArray(docs) ? docs.length > 0 : asRecord(docs) !== null;
}

/**
 * Per-domain discovery documents live behind `/api/{domain}/discovery`.
 *
 * The integrations.sh index (`api.json`) lists every surface but stopped
 * embedding the MCP endpoint documents the importer's raw-surface normalizer
 * reads (`surfaceDocs`). Hydrate one document per distinct MCP domain from the
 * upstream's own documented endpoint so a refresh keeps consuming upstream
 * evidence instead of silently re-probing the committed snapshot.
 */
export type SurfaceDocHydration = {
  snapshot: unknown;
  domains: number;
  fetched: number;
  failed: Array<{ domain: string; reason: string }>;
};

export async function hydrateSurfaceDocs(
  index: unknown,
  sourceUrl: string,
  fetchDoc: (url: string) => Promise<unknown> = (url) => fetchJson(url, DISCOVERY_TIMEOUT_MS),
): Promise<SurfaceDocHydration> {
  const root = asRecord(index);
  if (!root || hasSurfaceDocs(root)) {
    return { snapshot: index, domains: 0, fetched: 0, failed: [] };
  }
  const domains = [
    ...new Set(
      indexEntries(root).flatMap((entry) => {
        const domain = typeof entry.domain === "string" ? entry.domain.trim().toLowerCase() : "";
        return entry.kind === "mcp" && domain ? [domain] : [];
      }),
    ),
  ].sort();
  const origin = new URL(sourceUrl).origin;
  const surfaceDocs: UnknownRecord[] = [];
  const failed: SurfaceDocHydration["failed"] = [];
  const seenDomains = new Set<string>();
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < domains.length) {
      const domain = domains[nextIndex++]!;
      try {
        const payload = asRecord(await fetchDoc(`${origin}/api/${domain}/discovery`));
        const doc = asRecord(payload?.result) ?? payload;
        if (!doc || !Array.isArray(doc.surfaces ?? doc.surface ?? [])) {
          failed.push({ domain, reason: "malformed_discovery_document" });
          continue;
        }
        // Discovery may answer an alias domain with its canonical owner's
        // document. The document's own domain names the row; a second alias
        // resolving to the same owner adds nothing new.
        const resolvedDomain =
          typeof doc.domain === "string" && doc.domain.trim().length > 0
            ? doc.domain.trim().toLowerCase()
            : domain;
        if (seenDomains.has(resolvedDomain)) {
          continue;
        }
        seenDomains.add(resolvedDomain);
        surfaceDocs.push({ ...doc, domain: resolvedDomain });
      } catch (error) {
        failed.push({ domain, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, domains.length) }, () => worker()),
  );
  return {
    snapshot: { ...root, surfaceDocs },
    domains: domains.length,
    fetched: surfaceDocs.length,
    failed,
  };
}

/**
 * Committed rows that upstream no longer lists stay candidates and are
 * re-probed like every upstream row. Reviewed additions (for example a
 * first-party endpoint that integrations.sh never indexed) therefore survive a
 * refresh only while the endpoint still answers as MCP; a dead endpoint is
 * dropped with the same probe evidence as any other row.
 */
export function mergeCandidateRows(
  upstream: UnknownRecord[],
  committed: UnknownRecord[],
): { candidates: UnknownRecord[]; retained: number } {
  const upstreamUrls = new Set<string>();
  for (const candidate of upstream) {
    if (typeof candidate.mcpUrl === "string") {
      try {
        upstreamUrls.add(canonicalMcpUrl(candidate.mcpUrl));
      } catch {
        // Invalid URLs are rejected with a reason during normalization.
      }
    }
  }
  const retained = committed.filter(
    (row) => typeof row.mcpUrl === "string" && !upstreamUrls.has(canonicalMcpUrl(row.mcpUrl)),
  );
  return { candidates: [...upstream, ...retained], retained: retained.length };
}

async function readCommittedRows(path: string): Promise<UnknownRecord[]> {
  try {
    const root = asRecord(await readSnapshotFile(path));
    const rows = root?.importRows;
    return Array.isArray(rows)
      ? rows.flatMap((row) => {
          const record = asRecord(row);
          return record ? [record] : [];
        })
      : [];
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const rawSnapshot = args.inputPath
    ? await readSnapshotFile(args.inputPath)
    : await fetchJson(args.sourceUrl);
  await mkdir(dirname(args.outputPath), { recursive: true });
  const hydration = args.inputPath
    ? { snapshot: rawSnapshot, domains: 0, fetched: 0, failed: [] }
    : await hydrateSurfaceDocs(rawSnapshot, args.sourceUrl);
  const hydratedRoot = asRecord(hydration.snapshot);
  const generatedAt =
    [hydratedRoot?.generatedAt, hydratedRoot?.snapshotDate].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? new Date().toISOString();
  const upstreamCandidates = catalogCandidateRows(hydration.snapshot);
  if (upstreamCandidates.length === 0) {
    throw new Error(
      `upstream catalog normalized to zero candidate rows (${hydration.domains} domains, ${hydration.fetched} discovery documents fetched, ${hydration.failed.length} failed); refusing to overwrite ${args.outputPath}`,
    );
  }
  const committedRows = args.retainCommittedRows ? await readCommittedRows(args.outputPath) : [];
  const merged = mergeCandidateRows(upstreamCandidates, committedRows);
  // A refresh deliberately starts from unprobed upstream candidates. Keep them
  // long enough for the dedicated MCP probe below; the importer itself remains
  // fail-closed and accepts only real probe evidence.
  const normalized = normalizeCatalogSnapshot(
    { generatedAt, importRows: merged.candidates },
    { allowUnprobedCandidates: true },
  );
  const probed = await probeCatalogSnapshot(normalized);
  await writeFile(
    args.outputPath,
    `${JSON.stringify(
      {
        generatedAt: probed.generatedAt,
        source: SOURCE,
        cleanedAt: new Date().toISOString(),
        cleaning: probed.cleaning,
        probe: {
          kept: probed.probe.kept,
          dropped: probed.probe.dropped,
          real: probed.probe.real,
          unverified: probed.probe.unverified,
          googleapisDropped: probed.probe.googleapisDropped,
        },
        importRows: probed.rows,
        skipped: probed.skipped,
        quarantined: probed.quarantined.map((item) => ({
          row: item.row,
          reason: item.reason,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify(
      {
        output: args.outputPath,
        generatedAt: probed.generatedAt,
        discovery: {
          domains: hydration.domains,
          fetched: hydration.fetched,
          failed: hydration.failed.length,
        },
        upstreamCandidates: upstreamCandidates.length,
        retainedCommittedRows: merged.retained,
        before: normalized.cleaning.inputRows,
        after: probed.cleaning.outputRows,
        kept: probed.probe.kept,
        dropped: probed.probe.dropped,
        unverified: probed.probe.unverified,
        googleapisDropped: probed.probe.googleapisDropped,
        skipped: probed.skipped.length,
        quarantined: probed.quarantined.length,
        cleaning: probed.cleaning,
        ...(hydration.failed.length > 0 ? { discoveryFailures: hydration.failed } : {}),
      },
      null,
      2,
    ),
  );
}
