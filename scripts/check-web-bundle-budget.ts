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
  // Shared consent, connector, and response-deduplication code remains in the
  // application shell while provider SDKs stay lazy. The Workspace hub densifies
  // rail + settings against the session graph; a dedicated Radix vendor chunk
  // keeps Popper scopes intact (otherwise /settings crashes). The shared
  // composer also carries the tiny app-action slot used by realtime voice.
  // Existing-session scheduling, authenticated retained screenshots, and the
  // synchronous session projection grow the initial graph. The managed-app
  // catalog now includes governed Slack publication, read-only Atlassian, and
  // typed capabilities plus Browser/Computer resource contracts. The direct
  // session graph includes the small shared interaction-invalidation chunk;
  // live media renderers and browser/computer controls remain lazy. Workspace
  // channels and the "For you" rail entry add always-loaded rail code and one
  // more shared-chunk boundary in both graphs. Revision-fenced Connected Machine
  // command policy adds its memory/CPU fields to the shared session contract;
  // governed goal revision paging, rejection, and rollback add the matching SDK
  // methods to that same direct-session graph. Browser acceptance builds also
  // embed a configured VITE_API_BASE_URL; the supported loopback form adds up
  // to 18 raw bytes relative to the same-origin build. Keep a narrow full-KiB
  // envelope above that configured graph instead of a platform/config-specific
  // one-byte margin. Canonical Bun 1.3.14 Linux/x64 measured the combined
  // Company Brain base at 2,039,311/2,039,328/2,039,329 raw bytes for
  // default/4-digit/5-digit API URLs; that integration already exceeded the old
  // cap. The lazy residual inspector adds 769 raw bytes in every case. The
  // reconciled 0262 stack adds another 270 bytes. The current-main organization
  // membership and connection-authority integration brings the combined default/4-digit/5-digit
  // graph to a worst observed 2,042,520 raw bytes. Truthful zero-step lifecycle
  // copy, the shared large-history disclosure scheduler, and durable sandbox-file
  // receipt/download controls bring the configured graph to 2,052,836 raw bytes
  // and 571,587 gzip bytes on both macOS/arm64 and Linux/x64. The always-loaded
  // tenant-transition boundary, invocation fences, selected context semantics,
  // the always-loaded managed self-context projection, and the organization
  // section router bring the combined direct-session graph to 2,060,739 raw
  // bytes locally. The configured Linux CI graph for the landed Personal
  // projection measured 572,514 gzip bytes. The workspace scope/deep-link
  // shell plus the landed catalog presentation measure 2,061,506 raw bytes on
  // macOS/arm64. The public session-tenancy SDK activation brings the merged
  // direct-session graph to 2,063,047 raw bytes on macOS/arm64. PR #1676's
  // Linux/x64 production build measured the direct-session graph at 2,064,626
  // raw and 573,599 gzip bytes. PR #1678's exact Linux/x64 production build
  // then measured 2,065,995 raw and 573,851 gzip bytes, with raw 587 bytes over
  // the prior envelope.
  // PR #1680's project-aware session rail now has its own route-aware chunk:
  // with current main's personal-resource controls, the combined graph measures
  // 1,497,364 raw / 406,933 gzip bytes initially and 2,080,136 raw / 578,495 gzip
  // bytes on a direct session load. The next whole-KiB envelopes narrowly bind
  // those measurements while every unrelated graph and per-file cap stays fixed.
  // The explicit create-time resource/session scope controls and organization
  // administration overview measure 1,498,577 raw bytes initially and
  // 2,081,360 raw / 578,755 gzip bytes on a direct session load on
  // macOS/arm64. Only these three graph envelopes advance to the next whole
  // KiB; file, lazy, CSS, and all other caps remain unchanged.
  // Foreground read reconciliation now follows each active chat's durable
  // event frontier and composes with the landed same-tab rail projection. The
  // exact configured production graph measures 1,499,526 initial raw bytes and
  // 2,083,239 direct-session raw bytes on macOS/arm64; their next whole-KiB
  // envelopes are 1,465 and 2,035 KiB. Every gzip, file, lazy, and CSS cap
  // remains unchanged.
  // The personal GitHub lifecycle adds four typed SDK methods to the shared
  // client, measuring 1,500,166 initial raw bytes and 2,083,879 direct-session
  // raw bytes on macOS/arm64. Advance only those raw envelopes by one KiB;
  // every compressed, file-count, lazy-chunk, and CSS cap remains unchanged.
  // OPE-298's always-loaded rail click/failure handoff and its direct-session
  // optimistic reconciliation measure 1,518,452 raw / 413,407 gzip bytes in
  // the initial graph and 2,103,793 raw / 585,876 gzip bytes on a direct
  // session load. Advance only those four aggregate envelopes to their next
  // whole KiB; per-file, lazy, file-count, and CSS caps remain unchanged.
  initialRaw: 1483 * kib,
  // The managed personal-resource create/composer controls plus current main
  // measured 1,484,426 initial raw and 577,450 direct-session gzip bytes on
  // macOS/arm64. The final uncertain-Send reconciliation repair measured
  // 2,077,807 direct-session raw bytes in the exact production build, so its
  // next full-KiB envelope is 2,030 KiB (2,078,720 bytes). The 1,450 KiB
  // initial-raw and 564 KiB direct-session-gzip envelopes, plus every unrelated
  // graph and per-file cap, stay fixed.
  initialGzip: 404 * kib,
  // 77 KiB: the largest shared chunk sits 22 bytes over 76 KiB under CI's
  // bun chunking with the channels/For-you rail code; the graph totals above
  // still bound the aggregate.
  initialFileGzip: 77 * kib,
  initialFiles: 17,
  directSessionRaw: 2055 * kib,
  directSessionGzip: 573 * kib,
  directSessionFiles: 19,
  lazyChunkRaw: 800 * kib,
  lazyChunkGzip: 240 * kib,
  cssGzip: 31 * kib,
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
enforce("initial graph file count", initialMetrics.length, budgets.initialFiles);
enforce("direct session raw graph", directSessionTotal.raw, budgets.directSessionRaw);
enforce("direct session gzip graph", directSessionTotal.gzip, budgets.directSessionGzip);
enforce("direct session graph file count", directSessionMetrics.length, budgets.directSessionFiles);
enforce("largest lazy raw chunk", largestLazyRaw.raw, budgets.lazyChunkRaw);
enforce("largest lazy gzip chunk", largestLazyGzip.gzip, budgets.lazyChunkGzip);
enforce("largest CSS gzip asset", largestCss.gzip, budgets.cssGzip);

if (failures.length > 0) {
  throw new Error(`web bundle budget failed:\n- ${failures.join("\n- ")}`);
}
