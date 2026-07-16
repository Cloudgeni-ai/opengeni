import { readdir } from "node:fs/promises";
import path from "node:path";

type ManifestEntry = {
  file: string;
  imports?: string[];
  css?: string[];
  isEntry?: boolean;
};

const kib = 1024;
const budgets = {
  initialRaw: 750 * kib,
  initialGzip: 210 * kib,
  initialFileGzip: 70 * kib,
  directSessionRaw: 1900 * kib,
  directSessionGzip: 540 * kib,
  lazyChunkRaw: 800 * kib,
  lazyChunkGzip: 240 * kib,
  cssGzip: 30 * kib,
} as const;

const repoRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(repoRoot, "apps/web/dist");
const manifestPath = path.join(distDir, ".vite/manifest.json");
const manifest = (await Bun.file(manifestPath).json()) as Record<string, ManifestEntry>;

function staticGraph(startKeys: Iterable<string>): Set<string> {
  const visited = new Set<string>();
  const pending = [...startKeys];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    const entry = manifest[key];
    if (!entry) throw new Error(`bundle manifest is missing static import ${key}`);
    visited.add(key);
    pending.push(...(entry.imports ?? []));
  }
  return visited;
}

function assetPaths(keys: Iterable<string>, includeDocument = false): Set<string> {
  const assets = new Set<string>();
  if (includeDocument) assets.add("index.html");
  for (const key of keys) {
    const entry = manifest[key]!;
    assets.add(entry.file);
    for (const css of entry.css ?? []) assets.add(css);
  }
  return assets;
}

type AssetMetric = { file: string; raw: number; gzip: number };

async function metric(file: string): Promise<AssetMetric> {
  const bytes = await Bun.file(path.join(distDir, file)).bytes();
  return { file, raw: bytes.byteLength, gzip: Bun.gzipSync(bytes).byteLength };
}

async function metrics(files: Iterable<string>): Promise<AssetMetric[]> {
  return await Promise.all([...files].sort().map(metric));
}

function total(items: AssetMetric[]): { raw: number; gzip: number } {
  return items.reduce((sum, item) => ({ raw: sum.raw + item.raw, gzip: sum.gzip + item.gzip }), {
    raw: 0,
    gzip: 0,
  });
}

function largest(items: AssetMetric[], field: "raw" | "gzip"): AssetMetric {
  const sorted = [...items].sort((left, right) => right[field] - left[field]);
  const item = sorted[0];
  if (!item) throw new Error("web bundle contains no measured assets");
  return item;
}

const entryKeys = Object.entries(manifest)
  .filter(([, entry]) => entry.isEntry)
  .map(([key]) => key);
if (entryKeys.length !== 1) {
  throw new Error(`expected one web entry, found ${entryKeys.length}`);
}

const initialGraph = staticGraph(entryKeys);
const initialMetrics = await metrics(assetPaths(initialGraph, true));
const initialTotal = total(initialMetrics);
const largestInitial = largest(initialMetrics, "gzip");

const sessionRouteKey = "src/routes/session.tsx";
if (!manifest[sessionRouteKey]) {
  throw new Error(`bundle manifest is missing ${sessionRouteKey}`);
}
const directSessionGraph = staticGraph([...entryKeys, sessionRouteKey]);
const directSessionMetrics = await metrics(assetPaths(directSessionGraph, true));
const directSessionTotal = total(directSessionMetrics);

const assetDir = path.join(distDir, "assets");
const allChunkFiles = (await readdir(assetDir))
  .filter((file) => file.endsWith(".js"))
  .map((file) => `assets/${file}`);
const initialFiles = assetPaths(initialGraph, true);
const lazyMetrics = await metrics(allChunkFiles.filter((file) => !initialFiles.has(file)));
const largestLazyRaw = largest(lazyMetrics, "raw");
const largestLazyGzip = largest(lazyMetrics, "gzip");

const cssMetrics = await metrics(
  (await readdir(assetDir)).filter((file) => file.endsWith(".css")).map((file) => `assets/${file}`),
);
const largestCss = largest(cssMetrics, "gzip");

const report = {
  initial: { ...initialTotal, files: initialMetrics.length, largestGzip: largestInitial },
  directSession: { ...directSessionTotal, files: directSessionMetrics.length },
  lazy: {
    files: lazyMetrics.length,
    largestRaw: largestLazyRaw,
    largestGzip: largestLazyGzip,
  },
  css: { files: cssMetrics.length, largestGzip: largestCss },
  budgets,
};
console.log(JSON.stringify(report, null, 2));

const failures: string[] = [];
function enforce(label: string, actual: number, limit: number): void {
  if (actual > limit) failures.push(`${label}: ${actual} bytes exceeds ${limit}`);
}

enforce("initial raw graph", initialTotal.raw, budgets.initialRaw);
enforce("initial gzip graph", initialTotal.gzip, budgets.initialGzip);
enforce("largest initial gzip asset", largestInitial.gzip, budgets.initialFileGzip);
enforce("direct session raw graph", directSessionTotal.raw, budgets.directSessionRaw);
enforce("direct session gzip graph", directSessionTotal.gzip, budgets.directSessionGzip);
enforce("largest lazy raw chunk", largestLazyRaw.raw, budgets.lazyChunkRaw);
enforce("largest lazy gzip chunk", largestLazyGzip.gzip, budgets.lazyChunkGzip);
enforce("largest CSS gzip asset", largestCss.gzip, budgets.cssGzip);

if (failures.length > 0) {
  throw new Error(`web bundle budget failed:\n- ${failures.join("\n- ")}`);
}
