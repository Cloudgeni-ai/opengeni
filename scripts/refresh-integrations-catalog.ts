import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readSnapshotFile, writeCleanCatalogSnapshot } from "./import-integrations-catalog";

const DEFAULT_SOURCE_URL = "https://integrations.sh/api.json";
const DEFAULT_OUTPUT_PATH = "data/catalog/integrations-snapshot.json";

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
  console.log("Usage: bun run catalog:refresh [--url <catalog-json-url> | --input <raw-snapshot.json>] [--output data/catalog/integrations-snapshot.json]");
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
  const snapshot = args.inputPath ? await readSnapshotFile(args.inputPath) : await fetchSnapshot(args.sourceUrl);
  await mkdir(dirname(args.outputPath), { recursive: true });
  const normalized = await writeCleanCatalogSnapshot(args.outputPath, snapshot);
  console.log(JSON.stringify({
    output: args.outputPath,
    generatedAt: normalized.generatedAt,
    before: normalized.cleaning.inputRows,
    after: normalized.cleaning.outputRows,
    skipped: normalized.skipped.length,
    quarantined: normalized.quarantined.length,
    cleaning: normalized.cleaning,
  }, null, 2));
}
