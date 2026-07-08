// M8 live cold-paint proof (the <200ms capture-backed thesis, A1/D1 headline).
// Drives the REAL apps/web session route against the REAL API with the session's
// box STOPPED (cold). Proves: on mount the workbench paints the Changes/Files
// surfaces from the turn-end capture with ZERO Channel-A (/fs, /git, /terminal)
// calls before first paint — only the one capture GET. Network-log + timing proof.
//
//   node scripts/m8-live-coldpaint.mjs <workspaceId> <sessionId>
import { chromium } from "playwright";

const CHROMIUM = "/nix/store/7xr3qnq93srn4dgak7qw74dw836wpp1y-chromium-138.0.7204.49/bin/chromium";
const WS = process.argv[2];
const SID = process.argv[3];
const OUT = "/home/jorge/repos/Cloudgeni-ai/opengeni-workbench-wt/packages/react/.agent/ui-evidence/m8-live";
if (!WS || !SID) { console.error("usage: node m8-live-coldpaint.mjs <ws> <sid>"); process.exit(2); }

const isChannelA = (p) => /\/(fs|git|terminal)\//.test(p) || /\/stream-capabilities$/.test(p);
const isCapture = (p) => /\/workspace\/capture(\/file)?(\?|$)/.test(p);

const b = await chromium.launch({ executablePath: CHROMIUM });
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
const reqs = [];
let navStart = 0;
pg.on("request", (r) => {
  const u = new URL(r.url());
  if (u.port !== "8001") return;
  reqs.push({ t: Date.now() - navStart, method: r.method(), path: u.pathname + u.search });
});

navStart = Date.now();
await pg.goto(`http://127.0.0.1:3000/workspaces/${WS}/sessions/${SID}`, { waitUntil: "domcontentloaded" });

// First paint of capture-backed change data = the "Changes" tab shows its count badge.
// The dock brain fetches the capture on mount (active tab is the host's "run"); the
// badge is derived from that capture, so its presence == capture painted.
const changesTab = pg.locator('[role=tab]', { hasText: /^Changes/ });
await changesTab.first().waitFor({ state: "visible", timeout: 15000 });
// wait until the badge digit is present (capture data reconciled into the count)
await pg.waitForFunction(() => {
  const t = [...document.querySelectorAll('[role=tab]')].find((e) => /^Changes/.test(e.textContent || ""));
  return t && /\d/.test(t.textContent || "");
}, { timeout: 15000 });
const tPaint = Date.now() - navStart;

const before = reqs.filter((r) => r.t <= tPaint);
const channelABefore = before.filter((r) => isChannelA(r.path));
const captureBefore = before.filter((r) => isCapture(r.path));

// Now actually open the Changes tab and confirm the diff paints from capture (cold).
await changesTab.first().click();
await pg.waitForTimeout(1500);
await pg.screenshot({ path: `${OUT}/coldpaint-changes.png` });
const changesBodyLen = (await pg.textContent('body'))?.length ?? 0;

// Files tab — cold tree from capture.
const filesTab = pg.locator('[role=tab]', { hasText: /^Files/ });
await filesTab.first().click();
await pg.waitForTimeout(1200);
await pg.screenshot({ path: `${OUT}/coldpaint-files.png` });

// Machine chip — should read cold/offline with an "as of" label (box stopped).
let chipText = null;
try {
  const chip = pg.locator('[aria-label*="machine" i], [data-og-machine-chip], button:has-text("Offline"), button:has-text("Live")').first();
  chipText = await chip.textContent({ timeout: 2000 });
  await chip.click({ timeout: 2000 });
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: `${OUT}/coldpaint-machinechip-popover.png` });
} catch { /* chip optional */ }

const verdict = {
  sessionId: SID,
  tFirstPaintMs: tPaint,
  requestsBeforePaint: before.length,
  channelACallsBeforePaint: channelABefore.map((r) => `${r.method} ${r.path} @${r.t}ms`),
  captureCallsBeforePaint: captureBefore.map((r) => `${r.method} ${r.path} @${r.t}ms`),
  PASS_no_channelA_before_paint: channelABefore.length === 0,
  PASS_capture_fetched_before_paint: captureBefore.length >= 1,
  chipText,
  changesBodyLen,
  allRequestsFirst25: reqs.slice(0, 25).map((r) => `@${r.t}ms ${r.method} ${r.path}`),
};
console.log(JSON.stringify(verdict, null, 2));
await b.close();
