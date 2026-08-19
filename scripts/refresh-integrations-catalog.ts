import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalMcpUrl } from "./catalog-curation";
import { probeCatalogSnapshot, type ProbedCatalogSnapshot } from "./integrations-catalog-probe";
import {
  catalogCandidateRows,
  normalizeCatalogSnapshot,
  readSnapshotFile,
  type NormalizedCatalogSnapshot,
} from "./import-integrations-catalog";

const DEFAULT_SOURCE_URL = "https://integrations.sh/api.json";
const DEFAULT_OUTPUT_PATH = "data/catalog/integrations-snapshot.json";
const SOURCE = "integrations.sh";
const DISCOVERY_CONCURRENCY = 8;
const DISCOVERY_TIMEOUT_MS = 30_000;
/**
 * The upstream index is a few megabytes of flat entries; a discovery document
 * is a few kilobytes. Bound both reads so a misbehaving upstream cannot exhaust
 * the refresh process. (`@opengeni/network` owns the same pattern for OAuth
 * metadata, but the root scripts workspace does not depend on that package.)
 */
const UPSTREAM_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * A refresh may legitimately shrink the catalog when upstream delists dead
 * endpoints, but losing half of it in one run is a probe failure (DNS, proxy,
 * rate limiting, budget exhaustion), not upstream evidence. Importing such a
 * file would mark every missing registry row stale.
 */
const MIN_KEPT_RATIO = 0.5;

export type RefreshArgs = {
  sourceUrl: string;
  inputPath?: string;
  outputPath: string;
  retainCommittedRows: boolean;
  allowShrink: boolean;
};

export function parseArgs(argv: string[]): RefreshArgs {
  let sourceUrl = DEFAULT_SOURCE_URL;
  let inputPath: string | undefined;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let retainCommittedRows = true;
  let allowShrink = false;
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
    } else if (arg === "--allow-shrink") {
      allowShrink = true;
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
  return {
    sourceUrl,
    ...(inputPath ? { inputPath } : {}),
    outputPath,
    retainCommittedRows,
    allowShrink,
  };
}

function printUsage(): void {
  console.log(
    "Usage: bun run catalog:refresh [--url <catalog-json-url> | --input <raw-snapshot.json>] [--output data/catalog/integrations-snapshot.json] [--no-retain] [--allow-shrink]",
  );
}

/**
 * Upstream fetches never follow redirects: a 3xx from the index or a discovery
 * endpoint is an upstream failure rather than permission to read an arbitrary
 * host. Bodies are byte-bounded and every request carries a deadline.
 */
export async function fetchUpstreamJson(url: string, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `failed to fetch integrations catalog from ${url}: HTTP ${response.status} redirect is not followed`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`failed to fetch integrations catalog from ${url}: HTTP ${response.status}`);
  }
  return JSON.parse(await readResponseTextBounded(response, UPSTREAM_MAX_RESPONSE_BYTES, url));
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        throw new Error(
          `failed to fetch integrations catalog from ${url}: response exceeded ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
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
 * The importer accepts `surfaces` as either an array or one bare surface
 * object (`surfaceArray` wraps the latter). A discovery document is malformed
 * only when it carries neither shape.
 */
function hasImportableSurfaces(doc: UnknownRecord): boolean {
  const surfaces = doc.surfaces ?? doc.surface;
  return surfaces === undefined || Array.isArray(surfaces) || asRecord(surfaces) !== null;
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
  fetchDoc: (url: string) => Promise<unknown> = (url) =>
    fetchUpstreamJson(url, DISCOVERY_TIMEOUT_MS),
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
        if (!doc || !hasImportableSurfaces(doc)) {
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
 *
 * Upstream rows with an unparseable URL are rejected with a reason during
 * normalization. A committed row is reviewed data, so a malformed one fails
 * the refresh instead of being silently discarded.
 */
export function mergeCandidateRows(
  upstream: UnknownRecord[],
  committed: UnknownRecord[],
): { candidates: UnknownRecord[]; retained: UnknownRecord[] } {
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
  const retained = committed.filter((row) => !upstreamUrls.has(committedRowUrl(row)));
  return { candidates: [...upstream, ...retained], retained };
}

function committedRowUrl(row: UnknownRecord): string {
  const domain = typeof row.domain === "string" ? row.domain : "<missing domain>";
  if (typeof row.mcpUrl !== "string") {
    throw new Error(`committed snapshot row for ${domain} has no string mcpUrl`);
  }
  try {
    return canonicalMcpUrl(row.mcpUrl);
  } catch (error) {
    throw new Error(
      `committed snapshot row for ${domain} has an invalid mcpUrl ${JSON.stringify(row.mcpUrl)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Read the committed snapshot's `importRows`. A missing file is a first
 * refresh (no retention, no floor); an unreadable or malformed one fails
 * loudly because silently disabling retention would let a refresh drop every
 * reviewed row without any visible reason.
 */
export async function readCommittedRows(path: string): Promise<UnknownRecord[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return parseCommittedRows(text, path);
}

export function parseCommittedRows(text: string, path: string): UnknownRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `committed snapshot ${path} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const rows = asRecord(parsed)?.importRows;
  if (!Array.isArray(rows)) {
    throw new Error(`committed snapshot ${path} has no importRows array`);
  }
  return rows.map((row, index) => {
    const record = asRecord(row);
    if (!record) {
      throw new Error(`committed snapshot ${path} importRows[${index}] is not an object`);
    }
    return record;
  });
}

export type RetentionSummary = {
  /** Committed rows upstream no longer listed and the refresh re-probed. */
  candidateRows: number;
  /** Retained candidates that answered as MCP and stay in `importRows`. */
  retainedRows: Array<{ domain: string; mcpUrl: string }>;
  /** Retained candidates the refresh dropped, with the evicting reason. */
  droppedRows: Array<{ domain: string; mcpUrl: string; reason: string }>;
};

export type RefreshedSnapshotDocument = {
  generatedAt: string | null;
  source: typeof SOURCE;
  cleanedAt: string;
  cleaning: ProbedCatalogSnapshot["cleaning"];
  probe: {
    kept: number;
    dropped: number;
    real: number;
    unverified: number;
    googleapisDropped: number;
  };
  retention: RetentionSummary;
  importRows: ProbedCatalogSnapshot["rows"];
  skipped: ProbedCatalogSnapshot["skipped"];
  quarantined: Array<{ row: unknown; reason: string }>;
};

export type BuildRefreshedSnapshotInput = {
  /** The upstream index (or an already-hydrated / precomputed document). */
  rawSnapshot: unknown;
  sourceUrl: string;
  /** `--input` documents are consumed as-is; only live index fetches hydrate. */
  hydrate: boolean;
  /**
   * The committed snapshot's rows, or `null` when no committed file exists.
   * Always used for the shrink floor; merged as candidates only when
   * `retainCommittedRows` is set.
   */
  committedRows: UnknownRecord[] | null;
  retainCommittedRows: boolean;
  allowShrink: boolean;
  outputPath: string;
};

export type BuildRefreshedSnapshotDependencies = {
  fetchDoc?: (url: string) => Promise<unknown>;
  probe?: (normalized: NormalizedCatalogSnapshot) => Promise<ProbedCatalogSnapshot>;
  now?: () => Date;
};

export type BuildRefreshedSnapshotResult = {
  document: RefreshedSnapshotDocument;
  hydration: SurfaceDocHydration;
  upstreamCandidates: number;
  normalized: NormalizedCatalogSnapshot;
  probed: ProbedCatalogSnapshot;
};

export async function buildRefreshedSnapshot(
  input: BuildRefreshedSnapshotInput,
  deps: BuildRefreshedSnapshotDependencies = {},
): Promise<BuildRefreshedSnapshotResult> {
  const probe = deps.probe ?? ((normalized) => probeCatalogSnapshot(normalized));
  const now = deps.now ?? (() => new Date());
  const hydration: SurfaceDocHydration = input.hydrate
    ? await hydrateSurfaceDocs(input.rawSnapshot, input.sourceUrl, deps.fetchDoc)
    : { snapshot: input.rawSnapshot, domains: 0, fetched: 0, failed: [] };
  const hydratedRoot = asRecord(hydration.snapshot);
  const generatedAt =
    [hydratedRoot?.generatedAt, hydratedRoot?.snapshotDate].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? now().toISOString();
  const upstreamCandidates = catalogCandidateRows(hydration.snapshot);
  if (upstreamCandidates.length === 0) {
    throw new Error(
      `upstream catalog normalized to zero candidate rows (${hydration.domains} domains, ${hydration.fetched} discovery documents fetched, ${hydration.failed.length} failed); refusing to overwrite ${input.outputPath}`,
    );
  }
  const committedRows = input.committedRows ?? [];
  const merged = mergeCandidateRows(
    upstreamCandidates,
    input.retainCommittedRows ? committedRows : [],
  );
  // A refresh deliberately starts from unprobed upstream candidates. Keep them
  // long enough for the dedicated MCP probe below; the importer itself remains
  // fail-closed and accepts only real probe evidence.
  const normalized = normalizeCatalogSnapshot(
    { generatedAt, importRows: merged.candidates },
    { allowUnprobedCandidates: true },
  );
  const probed = await probe(normalized);
  const floor = Math.ceil(committedRows.length * MIN_KEPT_RATIO);
  if (!input.allowShrink && committedRows.length > 0 && probed.rows.length < floor) {
    throw new Error(
      `refresh kept ${probed.rows.length} rows but the committed snapshot has ${committedRows.length} (floor ${floor}); this looks like a probe outage rather than upstream evidence. Refusing to overwrite ${input.outputPath}; pass --allow-shrink to override.`,
    );
  }
  return {
    document: {
      generatedAt: probed.generatedAt,
      source: SOURCE,
      cleanedAt: now().toISOString(),
      cleaning: probed.cleaning,
      probe: {
        kept: probed.probe.kept,
        dropped: probed.probe.dropped,
        real: probed.probe.real,
        unverified: probed.probe.unverified,
        googleapisDropped: probed.probe.googleapisDropped,
      },
      retention: summarizeRetention(merged.retained, probed),
      importRows: probed.rows,
      skipped: probed.skipped,
      quarantined: probed.quarantined.map((item) => ({ row: item.row, reason: item.reason })),
    },
    hydration,
    upstreamCandidates: upstreamCandidates.length,
    normalized,
    probed,
  };
}

/**
 * Retention is invisible in `importRows` alone: a retained row is re-emitted
 * byte-identical, so an upstream delisting would otherwise be a zero-diff
 * no-op. Recording the retained surface keys in the header puts every
 * retention decision in the reviewed diff.
 */
export function summarizeRetention(
  retained: UnknownRecord[],
  probed: Pick<ProbedCatalogSnapshot, "rows" | "skipped" | "probe">,
): RetentionSummary {
  const keptByUrl = new Map(probed.rows.map((row) => [canonicalMcpUrl(row.mcpUrl), row]));
  const outcomeByUrl = new Map(
    probed.probe.outcomes.map((item) => [canonicalMcpUrl(item.mcpUrl), item.outcome]),
  );
  const retainedRows: RetentionSummary["retainedRows"] = [];
  const droppedRows: RetentionSummary["droppedRows"] = [];
  for (const row of retained) {
    const mcpUrl = committedRowUrl(row);
    const domain = typeof row.domain === "string" ? row.domain : "";
    const kept = keptByUrl.get(mcpUrl);
    if (kept) {
      retainedRows.push({ domain: kept.domain, mcpUrl: kept.mcpUrl });
      continue;
    }
    const outcome = outcomeByUrl.get(mcpUrl);
    const skipped = probed.skipped.find((item) => item.domain === domain);
    droppedRows.push({
      domain,
      mcpUrl,
      reason: outcome ? `probe_${outcome.reason}` : (skipped?.reason ?? "not_importable"),
    });
  }
  const byKey = (a: { domain: string; mcpUrl: string }, b: { domain: string; mcpUrl: string }) =>
    a.domain.localeCompare(b.domain) || a.mcpUrl.localeCompare(b.mcpUrl);
  return {
    candidateRows: retained.length,
    retainedRows: retainedRows.sort(byKey),
    droppedRows: droppedRows.sort(byKey),
  };
}

export function serializeRefreshedSnapshot(document: RefreshedSnapshotDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const rawSnapshot = args.inputPath
    ? await readSnapshotFile(args.inputPath)
    : await fetchUpstreamJson(args.sourceUrl, DISCOVERY_TIMEOUT_MS);
  const committedRows = await readCommittedRows(args.outputPath);
  const result = await buildRefreshedSnapshot({
    rawSnapshot,
    sourceUrl: args.sourceUrl,
    hydrate: !args.inputPath,
    committedRows,
    retainCommittedRows: args.retainCommittedRows,
    allowShrink: args.allowShrink,
    outputPath: args.outputPath,
  });
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, serializeRefreshedSnapshot(result.document));
  const { document, hydration, normalized, probed } = result;
  console.log(
    JSON.stringify(
      {
        output: args.outputPath,
        generatedAt: document.generatedAt,
        discovery: {
          domains: hydration.domains,
          fetched: hydration.fetched,
          failed: hydration.failed.length,
        },
        upstreamCandidates: result.upstreamCandidates,
        committedRows: committedRows?.length ?? 0,
        retention: document.retention,
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
