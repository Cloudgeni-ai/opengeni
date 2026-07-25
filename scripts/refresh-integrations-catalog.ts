import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { probeCatalogSnapshot } from "./integrations-catalog-probe";
import { normalizeCatalogSnapshot, readSnapshotFile } from "./import-integrations-catalog";

const DEFAULT_SOURCE_URL = "https://integrations.sh/api.json";
const DEFAULT_OUTPUT_PATH = "data/catalog/integrations-snapshot.json";
const SOURCE = "integrations.sh";

type RefreshArgs = {
  sourceUrl: string;
  inputPath?: string;
  outputPath: string;
};

function parseArgs(argv: string[]): RefreshArgs {
  let sourceUrl = DEFAULT_SOURCE_URL;
  let inputPath: string | undefined;
  let outputPath = DEFAULT_OUTPUT_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--url") {
      sourceUrl = argv[++index] ?? "";
    } else if (arg === "--input") {
      inputPath = argv[++index] ?? "";
    } else if (arg === "--output") {
      outputPath = argv[++index] ?? "";
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
  return { sourceUrl, ...(inputPath ? { inputPath } : {}), outputPath };
}

function printUsage(): void {
  console.log(
    "Usage: bun run catalog:refresh [--url <catalog-json-url> | --input <raw-snapshot.json>] [--output data/catalog/integrations-snapshot.json]",
  );
}

async function fetchSnapshot(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`failed to fetch integrations catalog from ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = args.inputPath
    ? await readSnapshotFile(args.inputPath)
    : await fetchSnapshot(args.sourceUrl);
  await mkdir(dirname(args.outputPath), { recursive: true });
  // A refresh deliberately starts from an unprobed upstream snapshot. Keep
  // those candidates long enough for the dedicated MCP probe below; the
  // importer itself remains fail-closed and accepts only real probe evidence.
  let normalized = normalizeCatalogSnapshot(snapshot, { allowUnprobedCandidates: true });
  let fallbackInput: string | null = null;
  if (!args.inputPath && normalized.rows.length === 0) {
    fallbackInput = args.outputPath;
    normalized = normalizeCatalogSnapshot(await readSnapshotFile(args.outputPath));
  }
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
        ...(fallbackInput
          ? { fallbackInput, fallbackReason: "source_normalized_to_zero_rows" }
          : {}),
        generatedAt: probed.generatedAt,
        before: normalized.cleaning.inputRows,
        after: probed.cleaning.outputRows,
        kept: probed.probe.kept,
        dropped: probed.probe.dropped,
        unverified: probed.probe.unverified,
        googleapisDropped: probed.probe.googleapisDropped,
        skipped: probed.skipped.length,
        quarantined: probed.quarantined.length,
        cleaning: probed.cleaning,
      },
      null,
      2,
    ),
  );
}
