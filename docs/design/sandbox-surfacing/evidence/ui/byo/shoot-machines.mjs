// ----------------------------------------------------------------------------
// M9 / V12 screenshot harness: render every Machines / enrollment state-matrix
// cell via nix-Chromium (Playwright executablePath) over the seeded
// packages/react demo `machines.html` page, organized into 5 passes. Also reads
// getComputedStyle on key elements (per render-ui-bugs-in-browser memory — not
// static cascade reasoning) and writes a `style-probe.json` audit.
//
//   node docs/design/sandbox-surfacing/evidence/ui/byo/shoot-machines.mjs
//
// Assumes the vite demo serves on PORT (default 3107) and ./result/bin/chromium
// (nix build nixpkgs#chromium) exists at the worktree root.
// ----------------------------------------------------------------------------
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const REPO = path.resolve(__dirname, "../../../../../../");
const { chromium } = await import(path.join(REPO, "node_modules/playwright/index.mjs"));
const EXE = path.join(REPO, "result/bin/chromium");
const PORT = process.env.PORT ?? "3107";
const BASE = `http://localhost:${PORT}/machines.html`;

// Responsive breakpoints: desktop / tablet / mobile (the matrix's second axis).
const WIDTHS = { desktop: 1280, tablet: 834, mobile: 390 };
const SCALE = 1.5;

const ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-gpu-compositing",
  "--js-flags=--max-old-space-size=512",
  "--renderer-process-limit=1",
  "--disable-background-timer-throttling",
];

function log(...a) {
  console.log("[shoot-machines]", ...a);
}

// The 5 passes. Each entry: { pass, view, name, theme?, breakpoints }.
// breakpoints: which device widths to capture for this view.
const ALL = ["desktop", "tablet", "mobile"];
const PASSES = [
  // Pass 1 — IA / flow: enrollment device-flow -> Machines list -> attach/swap.
  { pass: "1-flow", view: "flow-device", name: "01-device-flow", breakpoints: ALL },
  { pass: "1-flow", view: "flow-list", name: "02-machines-list", breakpoints: ALL },
  { pass: "1-flow", view: "flow-swap", name: "03-attach-swap", breakpoints: ["desktop"] },
  // Pass 2 — layout: dock parity selfhosted vs Modal side by side.
  { pass: "2-layout", view: "dock-parity", name: "04-dock-parity", breakpoints: ALL },
  { pass: "2-layout", view: "dashboard-modal", name: "05-modal-card", breakpoints: ["desktop"] },
  // Pass 3 — state coverage: all 8 states.
  { pass: "3-states", view: "state-empty", name: "06-state-empty", breakpoints: ALL },
  { pass: "3-states", view: "state-enrolling", name: "07-state-enrolling", breakpoints: ALL },
  { pass: "3-states", view: "state-online", name: "08-state-online", breakpoints: ALL },
  { pass: "3-states", view: "state-reconnecting", name: "09-state-reconnecting", breakpoints: ALL },
  { pass: "3-states", view: "state-offline", name: "10-state-offline", breakpoints: ALL },
  { pass: "3-states", view: "state-consent_required", name: "11-state-permission-denied", breakpoints: ALL },
  { pass: "3-states", view: "state-display_unavailable", name: "12-state-desktop-unavailable", breakpoints: ALL },
  { pass: "3-states", view: "state-shared", name: "13-state-shared-in-use", breakpoints: ALL },
  { pass: "3-states", view: "dashboard-contended", name: "14-state-contended-metrics", breakpoints: ["desktop"] },
  // Pass 4 — responsive/density: the full dashboard at all three widths.
  { pass: "4-responsive", view: "dashboard-full", name: "15-dashboard", breakpoints: ALL },
  // Pass 5 — polish: status pill, swap transition, shared disclosure, consent.
  { pass: "5-polish", view: "status-pills", name: "16-status-pills", breakpoints: ["desktop"] },
  { pass: "5-polish", view: "shared-disclosure", name: "17-shared-disclosure", breakpoints: ["desktop", "mobile"] },
  { pass: "5-polish", view: "consent-whole-machine", name: "18-consent-whole-machine", breakpoints: ALL },
  { pass: "5-polish", view: "consent-headless", name: "19-consent-headless", breakpoints: ["desktop"] },
  { pass: "5-polish", view: "consent-approved", name: "20-consent-approved", breakpoints: ["desktop"] },
  { pass: "5-polish", view: "consent-denied", name: "21-consent-denied", breakpoints: ["desktop"] },
  // Dark + light polish on the headline dashboard.
  { pass: "5-polish", view: "dashboard-full", name: "22-dashboard-light", theme: "light", breakpoints: ["desktop"] },
];

const probes = [];

async function probeStyles(page, view, bp) {
  // getComputedStyle on key elements — verify the tokens RESOLVED (not the raw
  // var() literal), proving the theme wired up. Per render-ui-bugs-in-browser.
  const data = await page.evaluate(() => {
    const out = {};
    const root = document.querySelector("[data-shot]");
    if (root) out.shotBg = getComputedStyle(root).backgroundColor;
    const pill = document.querySelector('[data-connection-status="online"]');
    if (pill) out.onlinePillColor = getComputedStyle(pill).color;
    const offPill = document.querySelector('[data-connection-status="offline"]');
    if (offPill) out.offlinePillColor = getComputedStyle(offPill).color;
    const approve = document.querySelector("[data-approve]");
    if (approve) out.approveBg = getComputedStyle(approve).backgroundColor;
    const card = document.querySelector("[data-machine-card]");
    if (card) out.cardBorder = getComputedStyle(card).borderTopColor;
    const metricBar = document.querySelector("[data-machine-metrics] .h-1 > div");
    if (metricBar) out.metricBarWidth = getComputedStyle(metricBar).width;
    return out;
  });
  // A style is "resolved" iff it is an rgb()/rgba() (not "var(--…)" / "" ).
  const unresolved = Object.entries(data).filter(
    ([, v]) => typeof v === "string" && (v.includes("var(") || v === ""),
  );
  probes.push({ view, bp, styles: data, unresolved: unresolved.map(([k]) => k) });
}

async function capture(browser, item) {
  for (const bp of item.breakpoints) {
    const width = WIDTHS[bp];
    const ctx = await browser.newContext({
      viewport: { width, height: 1200 },
      deviceScaleFactor: SCALE,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("pageerror:", item.view, e.message));
    const url = `${BASE}?view=${item.view}&w=${width}${item.theme ? `&theme=${item.theme}` : ""}`;
    await page.goto(url, { waitUntil: "networkidle" });
    // Wait for the harness to signal layout settled (double-rAF), with a cap.
    await page.waitForSelector('[data-og-theme], [data-ready="true"], .og-root', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector("[data-shot]") != null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(450);

    await probeStyles(page, item.view, bp);

    const dir = path.join(OUT, item.pass);
    fs.mkdirSync(dir, { recursive: true });
    const shot = page.locator("[data-shot]").first();
    const box = await shot.boundingBox().catch(() => null);
    const file = path.join(dir, `${item.name}.${bp}.png`);
    if (box && box.width > 8 && box.height > 8) {
      await page.screenshot({ path: file, clip: box });
    } else {
      await page.screenshot({ path: file });
    }
    log("wrote", path.relative(OUT, file));
    await ctx.close();
  }
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`nix-chromium missing at ${EXE} — run: nix build nixpkgs#chromium`);
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  try {
    for (const item of PASSES) {
      await capture(browser, item);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, "style-probe.json"), JSON.stringify(probes, null, 2));
  const broken = probes.filter((p) => p.unresolved.length > 0);
  log(`style probe: ${probes.length} captures, ${broken.length} with unresolved tokens`);
  if (broken.length > 0) {
    for (const b of broken) log("  UNRESOLVED:", b.view, b.bp, b.unresolved.join(","));
  }
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
