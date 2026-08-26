import { readdir } from "node:fs/promises";
import path from "node:path";

import { DIRECT_SESSION_RAW_BUDGET, KIB as kib } from "./web-bundle-budget-policy";

type ManifestEntry = {
  file: string;
  imports?: string[];
  css?: string[];
  isEntry?: boolean;
};

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
  // one-byte margin. The pre-migration Bun 1.3.14 Linux/x64 baseline measured the combined
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
  // The rail workspace switcher lists every accessible workspace instead of
  // the current org only. Linux/x64 production CI measured the direct-session
  // gzip graph at 579,618 bytes, 34 over the 566 KiB envelope.
  // Opening sandbox file links at a cited Files line adds the numbered viewer
  // plus session wiring to the direct-session graph. macOS/arm64 production
  // measured 2,086,125 raw / 580,320 gzip bytes; gzip still fits 567 KiB.
  // The always-loaded rail click/failure handoff and direct-session
  // optimistic reconciliation, combined with current main's corrected
  // sandbox-file link support, measure 1,518,543 raw / 413,439 gzip bytes in
  // the initial graph and 2,106,263 raw / 586,764 gzip bytes on a direct session
  // load. Advance only the exceeded aggregate envelopes to their next whole
  // KiB; per-file,
  // lazy, file-count, CSS, and the still-sufficient initial-gzip cap remain
  // unchanged.
  // The chat-native structured human-input exchange keeps pending and resolved
  // multi-question decisions in the direct session graph. Combined with the
  // current main graph, the configured macOS/arm64 production build measures
  // 1,520,528 initial raw / 414,073 initial gzip bytes and 2,112,063 raw /
  // 588,276 gzip bytes on a direct session load. Advance only those four
  // aggregate envelopes to the next whole KiB; all per-file and unrelated
  // graph limits stay fixed.
  // Heartbeat-backed machine liveness plus canonical filesystem-root links
  // measure 2,134,519 raw / 593,854 gzip bytes on a direct session load. Move
  // only the exceeded raw aggregate to its next whole-KiB envelope; compressed,
  // file-count, initial, per-file, lazy-chunk, and CSS limits remain unchanged.
  // Session-owned background-command list/cancel methods add 1,322 raw / 329
  // gzip bytes to that shared SDK client. The exact Linux/x64 production graph
  // measures 2,135,841 raw / 594,183 gzip bytes. Advance only those two direct-
  // session aggregate envelopes to their next whole KiB; every initial,
  // per-file, file-count, lazy-chunk, and CSS cap remains unchanged.
  initialRaw: 1485 * kib,
  // The managed personal-resource create/composer controls plus current main
  // measured 1,484,426 initial raw and 577,450 direct-session gzip bytes on
  // macOS/arm64. The final uncertain-Send reconciliation repair measured
  // 2,077,807 direct-session raw bytes in the exact production build, so its
  // next full-KiB envelope is 2,030 KiB (2,078,720 bytes). The 1,450 KiB
  // initial-raw and 564 KiB direct-session-gzip envelopes, plus every unrelated
  // graph and per-file cap, stay fixed.
  initialGzip: 405 * kib,
  // 77 KiB: the largest shared chunk sits 22 bytes over 76 KiB under CI's
  // bun chunking with the channels/For-you rail code; the graph totals above
  // still bound the aggregate.
  initialFileGzip: 77 * kib,
  initialFiles: 17,
  // The OpenSandbox session work on current main measures 2,112,678 bytes in
  // the Linux/x64 CI production build. That change advanced only the
  // direct-session raw envelope to the next whole KiB; its gzip, file-count,
  // lazy, CSS, and all other graph limits stayed fixed at that point.
  // Personal GitHub repository authority adds the typed selection and consent
  // methods to the shared SDK client. Combined with current main, the exact
  // macOS/arm64 production graph measures 2,115,776 raw / 589,075 gzip bytes.
  // Advance only those two aggregate envelopes to their next whole KiB; every
  // initial, per-file, file-count, lazy-chunk, and CSS cap stays fixed.
  // Generic event automations add the shared SDK contracts that let ordinary
  // session surfaces carry Pack-owned trigger metadata. The pre-migration Bun 1.3.14
  // production graph measures 2,121,826 raw / 588,620 gzip bytes. Advance only
  // the raw aggregate to its next whole-KiB envelope; gzip, file-count, initial,
  // per-file, lazy-chunk, and CSS caps remain unchanged.
  // The exact merged-main Linux/x64 workload build, which also embeds the
  // immutable deployment revision, measures 2,122,755 raw bytes. Advance only
  // this aggregate to the next whole-KiB envelope; every compressed, file-count,
  // per-file, lazy-chunk, CSS, and initial-graph cap remains unchanged.
  // Surfacing goal pause/hold/backoff reasons in the session chrome and the
  // "N need you · X h" waiting durations in the rail, priority feed, and
  // agents panel adds the reason copy plus the waiting helpers to the shared
  // session graph. The same macOS/arm64 production build measures current
  // main at 2,123,006 raw / 588,924 gzip bytes and this change at 2,126,938
  // raw / 591,668 gzip bytes. Advance only those two aggregate envelopes to
  // the next whole KiB, with one extra KiB on gzip for the up-to-1.5-KiB
  // Linux/x64 skew observed above; every initial, per-file, file-count,
  // lazy-chunk, and CSS cap stays fixed.
  // Child lifecycle notices add the five typed child notice payload schemas
  // and wake classes to the shared contracts plus their queue-chrome and
  // timeline labels. The same macOS/arm64 production build measures main at
  // 2,126,938 raw / 591,668 gzip bytes (the measurement above) and this
  // change at 2,129,504 raw / 592,296 gzip bytes. Advance only those two
  // aggregate envelopes: raw to the next whole KiB above one KiB of headroom,
  // gzip to the next whole KiB above 1.5 KiB of headroom for the Linux/x64
  // skew; every initial, per-file, file-count, lazy-chunk, and CSS cap stays
  // fixed.
  // The Slack orchestration-notice workspace toggles add two checkbox rows
  // plus their resolved-settings plumbing to the Capabilities surface. The
  // same macOS/arm64 production build measures merged main at 2,135,841 raw
  // / 594,183 gzip bytes and this change at 2,136,237 raw / 594,259 gzip
  // bytes. Gzip stays comfortably under its existing envelope; advance only
  // the raw aggregate to its next whole KiB above one KiB of headroom. Every
  // other cap, including gzip, stays fixed.
  // Receipt-routed chat/queue placement, finite interactive-command settlement,
  // local recovery states, and the first-message route handoff measure
  // 2,147,168 raw / 596,777 gzip bytes on the current merged macOS/arm64 graph.
  // Advance only those aggregates: raw to the next whole KiB above one KiB of
  // headroom and gzip above the observed 1.5-KiB Linux/x64 skew. Initial,
  // per-file, file-count, lazy-chunk, and CSS caps remain fixed.
  // Capability bundle defaults on that merged graph measure 2,161,915 raw /
  // 602,728 gzip bytes across 24 files. Advance only these direct-session
  // envelopes; initial, per-file, lazy-chunk, and CSS caps remain unchanged.
  // Managed organization bootstrap adds the authenticated principal routing
  // needed to accept an invitation or create an organization before a user has
  // any workspace. The sign-in surface remains lazy while the authenticated
  // no-workspace gate stays in the shell; the merged
  // macOS/arm64 graph measures 2,165,667 raw / 604,766 gzip bytes. Advance only
  // the raw aggregate to the next whole KiB above one KiB of headroom.
  // Restoring the rail creator monogram on root rows adds the shared chip
  // component and the accessible-name composition. The same macOS/arm64
  // production build measures merged main at 2,165,667 raw / 604,766 gzip bytes
  // and this change at 2,166,852 raw / 605,187 gzip bytes, clearing both
  // envelopes. Advance those two aggregates: raw to the next whole KiB above
  // one KiB of headroom, gzip above the observed 1.5-KiB Linux/x64 skew. Every
  // initial, per-file, file-count, lazy-chunk, and CSS cap stays fixed.
  // Atomic personal Connected Machine attachment adds its authority catalog,
  // create-time consent, and accepted-turn intent to the direct session graph.
  // The merged macOS/arm64 production build measures 2,169,981 raw bytes.
  // Advance only that aggregate to the next whole KiB above one KiB of
  // headroom; gzip, file-count, initial, per-file, lazy-chunk, and CSS caps stay
  // fixed.
  //
  // The document-authority reclassification work adds
  // `reclassifyDocumentAuthority`,
  // `listDocumentAuthorityReclassifications` and
  // `runDocumentDefaultCollectionBackfill` to the SDK. The web app calls none of
  // them, but they are instance methods on the single `OpenGeniCoreClient` class
  // the app imports wholesale, so they are retained and the direct-session graph
  // grows. That is dead weight shipped to every browser session, and it is
  // structural rather than specific to this change: every future SDK method
  // taxes the browser bundle whether or not the browser uses it.
  //
  // Two independent growths stack in this head - that SDK surface and the
  // Connected Machine attachment graph above - so the measurement is taken on
  // the merged tree rather than on either change alone: 2,171,431 raw. The
  // 2121-KiB cap left only 473 bytes, short of the one KiB of headroom the rule
  // above mandates, so this advances to 2122 KiB. Every other cap stays fixed.
  // It remains a stopgap; the real fix is to make the client
  // tree-shakeable, tracked separately.
  // Source-aware channel reconciliation adds the browser-only projection
  // authority and fresh-read revision fence to the always-loaded rail/route
  // graph. Its exact Linux/x64 Bun 1.4 production build measured 2,173,204 raw
  // / 607,228 gzip bytes.
  // Held-turn commentary projection adds the bounded waiting-state copy to
  // the shared session graph. The exact Linux/x64 production builds measure
  // 2,173,426-2,173,468 raw bytes and 607,161-607,169 gzip bytes. Preserve the
  // larger merged envelope for the stacked growth below: one-KiB raw headroom
  // and the 1.5-KiB gzip platform-skew allowance. Every file-count, initial,
  // per-file, lazy-chunk, and CSS cap stays fixed.
  // The organization-admin document migration audit adds three typed SDK
  // methods to the same non-tree-shakeable client. Exact Linux/x64 PR CI
  // measures the direct-session graph at 2,175,302 raw / 607,439 gzip bytes.
  // Causal channel authority for independently polled root, pins-only, detail,
  // and post-move reads measures 2,175,936 raw / 607,961 gzip bytes in the exact
  // Linux/x64 production build. The current-main compatibility merge stacks
  // both surfaces at 2,179,430 raw / 608,650 gzip bytes. Advance only these two
  // aggregates to 2,130 KiB raw and 596 KiB gzip so the guard retains one KiB
  // of raw headroom and the 1.5-KiB gzip platform-skew allowance; every other
  // cap remains fixed. The separately tracked structural fix is to remove this
  // browser tax, not keep growing the shared client class.
  // Durable move settlement, start-ordered mutation evidence, compaction-safe
  // accepted-read fences, reactive rail projection, and queued-successor read
  // sharing measure 2,181,466 raw bytes against the reviewed head's 2,180,493.
  // Advance only this aggregate to the next whole-KiB envelope above one KiB
  // of headroom; every compressed, file-count, initial, lazy, and CSS cap stays
  // fixed.
  // The final one-time setup path keeps multiple pending invitations explicit,
  // removes implicit shared-workspace creation, and scrubs setup authority from
  // browser URLs. Main measured that graph at 2,180,307 raw / 608,688 gzip
  // bytes on Bun 1.4 Linux/x64. Causal post-settlement move verification and
  // rejected-detail projection bring the exact merged graph to 2,186,879 raw /
  // 610,576 gzip bytes. Advance only these aggregates to 2,137 KiB raw and 598
  // KiB gzip, preserving one KiB of raw headroom and the 1.5-KiB Linux/x64
  // platform-skew allowance. The measured 31,498-byte CSS asset and every
  // initial, per-file, file-count, lazy-chunk, and CSS cap stay fixed.
  // Shared lineage request-start identity relay, stable re-entry promises,
  // request-causal cleanup authority, and current main's causal older-history
  // receipt measure 2,190,732 raw / 612,758 gzip bytes in the exact Linux/x64
  // Bun 1.4 production merge. Calibrate only these aggregates to the
  // policy-derived 2,141-KiB raw envelope (1,652 bytes of headroom) and the next
  // whole-KiB gzip envelope above the 1.5-KiB platform-skew allowance. Every
  // file-count, initial, per-file, lazy-chunk, and CSS cap remains fixed.
  directSessionRaw: DIRECT_SESSION_RAW_BUDGET,
  directSessionGzip: 600 * kib,
  directSessionFiles: 24,
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
