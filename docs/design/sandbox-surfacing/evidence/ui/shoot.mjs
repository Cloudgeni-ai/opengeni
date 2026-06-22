// Render harness: drive the packages/react demo with nix-chromium via Playwright
// and screenshot each Workspace dock surface at three dock widths.
//
//   node docs/design/sandbox-surfacing/evidence/ui/shoot.mjs
//
// Assumes the vite demo is already serving on :3100 and ./result/bin/chromium
// (nix build nixpkgs#chromium) exists at repo root.

import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const REPO = path.resolve(__dirname, "../../../../../");
const { chromium } = await import(path.join(REPO, "node_modules/playwright/index.mjs"));
const EXE = path.join(REPO, "result/bin/chromium");
const URL = "http://localhost:3100/";

// Outer viewport is fixed; we vary the DOCK width by dragging the separator.
const VIEWPORT = { width: 1440, height: 900 };
// deviceScaleFactor 2 doubles the backing store; under memory pressure swiftshader
// OOM-crashes the renderer. 1.5 keeps the screenshots crisp without the blow-up.
const SCALE = 1.5;

const COMMON_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  // Trim the renderer's appetite so it survives a memory-starved host.
  "--js-flags=--max-old-space-size=512",
  "--renderer-process-limit=1",
  "--disable-background-timer-throttling",
];

// The Files / Terminal / git-diff surfaces are pure DOM (xterm uses its DOM
// renderer here, no WebGL). Software GL compositing under swiftshader leaves a
// stale-texture smear on the top scanline of the xterm viewport — a capture
// artifact, NOT a product defect (the live DOM text is clean). Disabling the GPU
// for these surfaces composites on the CPU and screenshots them clean.
const LAUNCH_DOM = {
  executablePath: EXE,
  args: [...COMMON_ARGS, "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-compositing"],
};

// The Desktop surface is a noVNC <canvas> that needs a working WebGL context, so
// it gets swiftshader software GL.
const LAUNCH_GPU = {
  executablePath: EXE,
  args: [...COMMON_ARGS, "--use-gl=angle", "--use-angle=swiftshader", "--in-process-gpu", "--disable-features=Vulkan"],
};

// Dock target widths (px) at the three steps. "max" uses the maximize control.
const NARROW = 360;
const MEDIUM = 640;

function log(...a) {
  console.log("[shoot]", ...a);
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror:", e.message));
  await page.goto(URL, { waitUntil: "networkidle" });
  // Let the scripted client seed events (terminal transcript, git diff, caps).
  await page.waitForTimeout(2500);
  return { ctx, page };
}

/** Drag the dock separator so the dock panel becomes ~targetPx wide. */
async function setDockWidth(page, targetPx) {
  const sep = page.locator('[data-panel-resize-handle-id], [role="separator"]').first();
  const dock = page.locator('#dock, [data-panel-id="dock"]').first();
  for (let i = 0; i < 7; i++) {
    const box = await sep.boundingBox();
    const db = await dock.boundingBox().catch(() => null);
    if (!box || !db) break;
    if (Math.abs(db.width - targetPx) < 18) break;
    // dock right edge stays fixed; place the separator targetPx left of it.
    const dockRight = db.x + db.width;
    const targetX = dockRight - targetPx;
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(targetX, fromY, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(260);
  }
  await page.waitForTimeout(400);
}

async function selectTab(page, label) {
  await page.locator(`[role="tab"]:has-text("${label}")`).first().click();
  await page.waitForTimeout(700);
}

async function maximize(page) {
  await page.locator('button[title="Maximize"]').first().click();
  await page.waitForTimeout(600);
}

async function shotFull(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  log("wrote", `${name}.png`);
}

async function shotDock(page, name) {
  // Clip to the dock panel (or full-screen overlay when maximized).
  const overlay = page.locator(".fixed.inset-0.z-40").first();
  const target = (await overlay.count()) > 0 && (await overlay.isVisible())
    ? overlay
    : page.locator('#dock, [data-panel-id="dock"]').first();
  const box = await target.boundingBox().catch(() => null);
  if (box && box.width > 8) {
    await page.screenshot({ path: path.join(OUT, `${name}.dock.png`), clip: box });
    log("wrote", `${name}.dock.png`);
  }
}

async function captureSurface(browser, tab, fileBase, { skipMax = false } = {}) {
  // narrow + medium in one page
  {
    const { ctx, page } = await newPage(browser);
    await selectTab(page, tab);
    await setDockWidth(page, NARROW);
    await selectTab(page, tab);
    await shotFull(page, `${fileBase}-narrow`);
    await shotDock(page, `${fileBase}-narrow`);

    await setDockWidth(page, MEDIUM);
    await shotFull(page, `${fileBase}-medium`);
    await shotDock(page, `${fileBase}-medium`);
    await ctx.close();
  }
  if (!skipMax) {
    const { ctx, page } = await newPage(browser);
    await selectTab(page, tab);
    await maximize(page);
    await selectTab(page, tab);
    await shotFull(page, `${fileBase}-max`);
    await shotDock(page, `${fileBase}-max`);
    await ctx.close();
  }
}

// One surface = one fresh browser. A renderer crash on a memory-starved host
// then only loses that surface; the next launch starts clean. We also retry a
// crashed surface once.
async function captureIsolated(tab, fileBase, opts = {}) {
  const launch = opts.gpu ? LAUNCH_GPU : LAUNCH_DOM;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const browser = await chromium.launch(launch);
    try {
      await captureSurface(browser, tab, fileBase, opts);
      await browser.close().catch(() => {});
      return;
    } catch (e) {
      await browser.close().catch(() => {});
      log(`${fileBase} capture error (attempt ${attempt}):`, e.message);
      if (attempt === 2) log(`${fileBase}: giving up after retry`);
    }
  }
}

async function main() {
  // Files surface (review-first git tree)
  await captureIsolated("Files", "files");
  // Terminal surface (xterm)
  await captureIsolated("Terminal", "terminal");
  // Git diff: the Files surface IS the review-first diff; gitdiff-* = Files with a
  // changed file selected + diff shown.
  await captureIsolated("Files", "gitdiff");
  // Desktop surface — noVNC canvas needs WebGL; isolate it with software GL.
  await captureIsolated("Desktop", "desktop", { gpu: true });
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
