// M8 live cold-paint + D1 proof via the REAL-client embedder harness.
// Serves demo/dist and proxies /v1 -> :8001 (same-origin; SSE-safe), then mounts
// `<SandboxWorkspace>` (no host initialTab) against the real capture data with
// the session's box COLD. Proves:
//   - cold-paint: workbench paints Changes/tree from the ONE capture GET with
//     ZERO Channel-A (/fs,/git,/terminal) calls before first paint;
//   - D1: the workbench picks Changes as its own default tab pre-paint (changes
//     exist), with no post-paint tab switch.
//
//   node scripts/m8-live-embed.mjs <workspaceId> <sessionId>
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../demo/dist");
const CHROMIUM = "/nix/store/7xr3qnq93srn4dgak7qw74dw836wpp1y-chromium-138.0.7204.49/bin/chromium";
const OUT = join(__dirname, "../.agent/ui-evidence/m8-live");
const API = { host: "127.0.0.1", port: 8001 };
const WS = process.argv[2];
const SID = process.argv[3];
const preload = process.argv[4] === "preload"; // fetch events before mount (apps/web-style)
const tag = preload ? "preload" : "async";
if (!WS || !SID) { console.error("usage: node m8-live-embed.mjs <ws> <sid> [preload]"); process.exit(2); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const isChannelA = (p) => /\/(fs|git|terminal)\//.test(p);

// Static + /v1 proxy server (same-origin so no CORS; pipes SSE through).
const server = createServer((req, res) => {
  if (req.url.startsWith("/v1")) {
    const proxyReq = httpRequest({ host: API.host, port: API.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${API.host}:${API.port}` } }, (pr) => {
      res.writeHead(pr.statusCode ?? 502, pr.headers);
      pr.pipe(res);
    });
    proxyReq.on("error", () => { res.writeHead(502); res.end("proxy error"); });
    req.pipe(proxyReq);
    return;
  }
  let path = req.url.split("?")[0];
  if (path === "/") path = "/workbench-embed.html";
  readFile(join(distDir, path))
    .then((buf) => { res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" }); res.end(buf); })
    .catch(() => { res.writeHead(404); res.end("not found"); });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: CHROMIUM });
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
const reqs = [];
let navStart = 0;
pg.on("request", (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/v1")) return;
  reqs.push({ t: Date.now() - navStart, method: r.method(), path: u.pathname + u.search });
});
const errs = [];
pg.on("pageerror", (e) => errs.push(String(e)));

navStart = Date.now();
await pg.goto(`${base}/workbench-embed.html?ws=${WS}&sid=${SID}${preload ? "&preload=1" : ""}`, { waitUntil: "domcontentloaded" });

// First capture-backed paint: with the box cold, ANY file-rail/diff row in the
// active panel can ONLY have come from the capture. Wait for the Changes rail to
// render at least one file row.
await pg.locator('[role=tab]').first().waitFor({ state: "visible", timeout: 15000 });
await pg.waitForFunction(() => {
  // a rendered diff section or file-rail row anywhere in the dock body
  return document.querySelector('[data-diff-section]') || document.querySelector('[data-og-file-rail-row]') ||
    [...document.querySelectorAll('*')].some((e) => /^\s*(app\.py|data\.txt|notes\.txt|created-by-echo)/.test(e.textContent || "") && e.childElementCount === 0);
}, { timeout: 15000 }).catch(() => {});
const tPaint = Date.now() - navStart;

// D1: which tab is selected on first paint?
const selectedTab = await pg.evaluate(() => {
  const t = [...document.querySelectorAll('[role=tab]')].find((e) => e.getAttribute("aria-selected") === "true");
  return t?.textContent?.trim() ?? null;
});
const allTabs = await pg.$$eval('[role=tab]', (els) => els.map((e) => e.textContent?.trim()));

const before = reqs.filter((r) => r.t <= tPaint);
const channelABefore = before.filter((r) => isChannelA(r.path));
const captureBefore = before.filter((r) => /\/workspace\/capture/.test(r.path));

await pg.screenshot({ path: `${OUT}/embed-${tag}-default.png` });

// D1: confirm no tab switch after a settle (record selected tab again).
await pg.waitForTimeout(2500);
const selectedTabAfter = await pg.evaluate(() => {
  const t = [...document.querySelectorAll('[role=tab]')].find((e) => e.getAttribute("aria-selected") === "true");
  return t?.textContent?.trim() ?? null;
});
await pg.screenshot({ path: `${OUT}/embed-${tag}-settled.png` });

// Files tab (cold tree from capture).
try {
  await pg.locator('[role=tab]', { hasText: /^Files/ }).first().click();
  await pg.waitForTimeout(1000);
  await pg.screenshot({ path: `${OUT}/embed-${tag}-files.png` });
} catch {}

// whole-cold-session channel-A tally (should be 0 until user intent).
const channelAAll = reqs.filter((r) => isChannelA(r.path));

const verdict = {
  mode: tag,
  sessionId: SID,
  tFirstCapturePaintMs: tPaint,
  D1_defaultTabAtPaint: selectedTab,
  D1_defaultTabAfterSettle: selectedTabAfter,
  D1_noTabSwitch: selectedTab === selectedTabAfter,
  D1_PASS_defaultIsChanges: /^Changes/.test(selectedTab ?? ""),
  tabs: allTabs,
  requestsBeforePaint: before.length,
  captureCallsBeforePaint: captureBefore.map((r) => `${r.method} ${r.path.split("/").slice(-1)[0]} @${r.t}ms`),
  channelACallsBeforePaint: channelABefore.map((r) => `${r.method} ${r.path} @${r.t}ms`),
  channelACallsWholeColdSession: channelAAll.map((r) => `${r.method} ${r.path} @${r.t}ms`),
  PASS_no_channelA_before_paint: channelABefore.length === 0,
  PASS_capture_fetched_before_paint: captureBefore.length >= 1,
  pageErrors: errs.slice(0, 5),
  allV1RequestsFirst30: reqs.slice(0, 30).map((r) => `@${r.t}ms ${r.method} ${r.path.replace(`/v1/workspaces/${WS}/sessions/${SID}`, "…")}`),
};
console.log(JSON.stringify(verdict, null, 2));
await b.close();
server.close();
