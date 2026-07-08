// M7 evidence: screenshot the full `<SandboxWorkspace>` dock across the dossier
// §13 state matrix — every state × dark/light, plus per-surface tabs and dock
// widths (narrow/medium/wide) where layout differs, plus the machine-chip
// popover. Static (mock client, no backend). Writes into pass-<N>/ so each
// review pass has its own before/after set.
//
//   node scripts/m7-evidence.mjs <pass>       # pass = 1|2|3|4 (default 1)
//   node scripts/m7-evidence.mjs 3 --states cold-instant,dense
//
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../demo/dist");
const CHROMIUM = "/nix/store/7xr3qnq93srn4dgak7qw74dw836wpp1y-chromium-138.0.7204.49/bin/chromium";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const args = process.argv.slice(2);
const pass = args.find((a) => /^[1-5]$/.test(a)) ?? "1";
const stateFilter = (() => {
  const i = args.indexOf("--states");
  return i >= 0 && args[i + 1] ? args[i + 1].split(",") : null;
})();
const outDir = join(__dirname, `../.agent/ui-evidence/pass-${pass}`);

// Widths where dock layout meaningfully differs. The dock becomes a full-screen
// overlay below 1024px (DOCK_OVERLAY_BREAKPOINT) → `narrow`/`phone` exercise that;
// `phone` also drops the Files tree+diff to STACKED (container <720) and shrinks the
// Changes rail (max-[560px]).
const WIDTHS = { wide: 1440, medium: 1120, narrow: 900, phone: 520 };

// Pass 4 sweeps widths for a CURATED set (the states where responsive/density
// actually differ), rather than the whole matrix — keeps the review set readable.
const RESPONSIVE = [
  { state: "warm-live", tabs: ["changes", "files", "terminal"] },
  { state: "dense", tabs: ["changes", "files"] },
  { state: "cold-instant", tabs: ["changes"] },
  { state: "selfhosted-offline", tabs: ["files"] },
];

// The matrix. `tabs` lists which surface tabs to capture for that state.
const MATRIX = [
  { state: "warm-live", tabs: ["changes", "files", "terminal"], chip: true },
  { state: "cold-instant", tabs: ["changes", "files"], chip: true },
  { state: "waking", tabs: ["changes"], chip: true },
  { state: "selfhosted-offline", tabs: ["changes", "files"], chip: true },
  { state: "empty", tabs: ["changes", "files"] },
  { state: "dense", tabs: ["changes", "files"] },
  { state: "guard", tabs: ["changes"] },
  { state: "error", tabs: ["changes"], chip: true },
  { state: "permission-gated", tabs: ["changes", "files"] },
  { state: "connecting", tabs: ["changes"] },
];

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path === "/") path = "/index.html";
    const buf = await readFile(join(distDir, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/workbench-dock.html`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROMIUM });
const shots = [];

const TAB_LABEL = { changes: "Changes", files: "Files", terminal: "Terminal", desktop: "Desktop" };

async function shot(state, tab, theme, widthName) {
  const width = WIDTHS[widthName];
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const url = `${base}?state=${state}&theme=${theme}&tab=${tab}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(650);
  // Capability-gated tabs (Terminal/Desktop) only appear after negotiation, so
  // clicking the tab by label (once present) is more robust than an initialTab
  // that gets reset before the tab exists. Falls through if the tab isn't there.
  const tabBtn = page.locator(`[role="tab"]`, { hasText: TAB_LABEL[tab] }).first();
  if (await tabBtn.count()) {
    await tabBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const name = `${state}__${tab}__${theme}__${widthName}.png`;
  await page.screenshot({ path: join(outDir, name) });
  shots.push(name);
  await page.close();
}

async function shotChip(state, theme) {
  const page = await browser.newPage({ viewport: { width: WIDTHS.wide, height: 900 } });
  await page.goto(`${base}?state=${state}&theme=${theme}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(650);
  const chip = page.locator('button[aria-label^="Machine:"]').first();
  if (await chip.count()) {
    await chip.click().catch(() => {});
    await page.waitForTimeout(300);
    const name = `${state}__chip-popover__${theme}__wide.png`;
    await page.screenshot({ path: join(outDir, name) });
    shots.push(name);
  }
  await page.close();
}

// Pass 5 (final polish) proves the two targeted fixes + regresses the states
// most likely to be affected. FIX 1 (diff soft-wrap) reads clearest on the
// Changes pane at a narrow-ish dock width (`medium`) where a long line used to
// clip; FIX 2 (Files declutter — the replicated CHANGES list removed) reads
// clearest on the Files tab at `wide` where the left column is fully shown.
const PASS5 = [
  {
    state: "warm-live",
    shots: [
      ["changes", "medium"],
      ["files", "wide"],
    ],
  },
  {
    state: "dense",
    shots: [
      ["changes", "medium"],
      ["files", "wide"],
    ],
  },
  { state: "cold-instant", shots: [["files", "wide"]] },
  { state: "selfhosted-offline", shots: [["files", "wide"]] },
  {
    state: "empty",
    shots: [
      ["changes", "medium"],
      ["files", "wide"],
    ],
  },
  { state: "guard", shots: [["changes", "medium"]] },
];

if (pass === "5") {
  for (const row of PASS5) {
    if (stateFilter && !stateFilter.includes(row.state)) continue;
    for (const theme of ["dark", "light"]) {
      for (const [tab, width] of row.shots) await shot(row.state, tab, theme, width);
    }
  }
} else if (pass === "4") {
  // Responsive/density sweep: curated states × widths, both themes.
  for (const row of RESPONSIVE) {
    if (stateFilter && !stateFilter.includes(row.state)) continue;
    for (const theme of ["dark", "light"]) {
      for (const tab of row.tabs) {
        for (const w of ["wide", "medium", "narrow", "phone"]) await shot(row.state, tab, theme, w);
      }
    }
  }
} else {
  for (const row of MATRIX) {
    if (stateFilter && !stateFilter.includes(row.state)) continue;
    for (const theme of ["dark", "light"]) {
      for (const tab of row.tabs) await shot(row.state, tab, theme, "medium");
      if (row.chip) await shotChip(row.state, theme);
    }
  }
}

await browser.close();
server.close();
console.log(`pass ${pass}: ${shots.length} screenshots → ${outDir}`);
for (const s of shots.sort()) console.log("  " + s);
