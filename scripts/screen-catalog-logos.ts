import { readFile, writeFile } from "node:fs/promises";
import { fetchLogoAsset, type LogoFetch } from "./catalog-vendored-logos";

/**
 * Screens the snapshot's logo sources for generated letter avatars.
 *
 * integrations.sh answers a domain it has no logo for with HTTP 200 and a
 * generated SVG letter. Left in the snapshot, every surface that falls back to
 * the row's original logo URL shows that letter as if it were the provider's
 * mark, and our own calm monogram never takes over. A screened row records
 * `logoSourceUrl: null`, which the importer already treats as "no published
 * logo". Only a fetched-and-recognized placeholder is cleared: an unreachable
 * logo host is transient evidence and leaves the row unchanged.
 *
 * `catalog:refresh` runs this on every refresh; `bun run catalog:screen-logos`
 * re-screens the committed snapshot in place.
 */

const DEFAULT_SNAPSHOT_PATH = "data/catalog/integrations-snapshot.json";
const DEFAULT_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20_000;

export type LogoScreenSummary = {
  screenedAt: string;
  /** Rows whose logo source was fetched and inspected. */
  checked: number;
  /** Rows whose source served a generated letter instead of a logo. */
  placeholderRows: Array<{ domain: string; mcpUrl: string }>;
  /** Rows whose logo source could not be fetched; left unchanged. */
  unreachable: number;
};

type ScreenableRow = { domain?: unknown; mcpUrl?: unknown; logoSourceUrl?: unknown };

export async function screenCatalogRowLogos<T extends ScreenableRow>(
  rows: readonly T[],
  input: {
    fetchImpl?: LogoFetch;
    concurrency?: number;
    now?: () => Date;
  } = {},
): Promise<{ rows: T[]; summary: LogoScreenSummary }> {
  const fetchImpl: LogoFetch =
    input.fetchImpl ??
    ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const now = input.now ?? (() => new Date());
  const screened = [...rows];
  const placeholderRows: LogoScreenSummary["placeholderRows"] = [];
  let checked = 0;
  let unreachable = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= screened.length) return;
      const row = screened[index]!;
      if (typeof row.logoSourceUrl !== "string" || !row.logoSourceUrl) continue;
      const asset = await fetchLogoAsset(row.logoSourceUrl, fetchImpl);
      checked += 1;
      if (asset.ok) continue;
      if (asset.reason === "generated_letter_placeholder") {
        screened[index] = { ...row, logoSourceUrl: null };
        placeholderRows.push({
          domain: typeof row.domain === "string" ? row.domain : "",
          mcpUrl: typeof row.mcpUrl === "string" ? row.mcpUrl : "",
        });
      } else if (
        asset.reason.startsWith("fetch_failed") ||
        asset.reason.startsWith("http_status")
      ) {
        unreachable += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, screened.length) }, worker));
  placeholderRows.sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.mcpUrl.localeCompare(b.mcpUrl),
  );
  return {
    rows: screened,
    summary: { screenedAt: now().toISOString(), checked, placeholderRows, unreachable },
  };
}

/**
 * Re-screens a committed snapshot document. Rows already screened (null) stay
 * null; the summary lists every row that is null because of a placeholder,
 * including ones cleared by an earlier screen, so the header stays complete.
 */
export async function screenSnapshotDocument(
  document: Record<string, unknown>,
  input: Parameters<typeof screenCatalogRowLogos>[1] = {},
): Promise<{ document: Record<string, unknown>; summary: LogoScreenSummary }> {
  const rows = document.importRows;
  if (!Array.isArray(rows)) {
    throw new Error("snapshot has no importRows array to screen");
  }
  const { rows: screened, summary } = await screenCatalogRowLogos(rows as ScreenableRow[], input);
  const previous = (document.logoScreen as Partial<LogoScreenSummary> | undefined)?.placeholderRows;
  const stillNull = new Set(
    screened
      .filter((row) => row.logoSourceUrl === null)
      .map((row) => `${String(row.domain)}\n${String(row.mcpUrl)}`),
  );
  const merged = new Map(
    [...(Array.isArray(previous) ? previous : []), ...summary.placeholderRows]
      .filter((row) => stillNull.has(`${row.domain}\n${row.mcpUrl}`))
      .map((row) => [`${row.domain}\n${row.mcpUrl}`, row]),
  );
  const placeholderRows = [...merged.values()].sort(
    (a, b) => a.domain.localeCompare(b.domain) || a.mcpUrl.localeCompare(b.mcpUrl),
  );
  const completeSummary = { ...summary, placeholderRows };
  // Keep the header next to the other refresh facts, before the rows.
  const { importRows: _rows, skipped, quarantined, logoScreen: _old, ...header } = document;
  return {
    document: {
      ...header,
      logoScreen: completeSummary,
      importRows: screened,
      skipped,
      quarantined,
    },
    summary: completeSummary,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let snapshotPath = DEFAULT_SNAPSHOT_PATH;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--snapshot") {
      snapshotPath = args[++index] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run catalog:screen-logos [--snapshot <snapshot.json>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const document = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
  const { document: screened, summary } = await screenSnapshotDocument(document);
  await writeFile(snapshotPath, `${JSON.stringify(screened, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        snapshot: snapshotPath,
        checked: summary.checked,
        placeholders: summary.placeholderRows.length,
        unreachable: summary.unreachable,
      },
      null,
      2,
    ),
  );
}
