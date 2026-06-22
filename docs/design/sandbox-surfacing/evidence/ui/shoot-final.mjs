// FINAL render harness: drive the packages/react demo with nix-chromium via
// Playwright and screenshot each Workspace dock surface at narrow / medium /
// maximized. Identical capture logic to shoot.mjs; writes into ./final/.
//
//   node docs/design/sandbox-surfacing/evidence/ui/shoot-final.mjs
//
// Assumes the vite demo is already serving on :3100 and ./result/bin/chromium
// (nix build nixpkgs#chromium) exists at repo root.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "final");
fs.mkdirSync(OUT, { recursive: true });
const REPO = path.resolve(__dirname, "../../../../../");
const { chromium } = await import(path.join(REPO, "node_modules/playwright/index.mjs"));
const EXE = path.join(REPO, "result/bin/chromium");
const URL = "http://localhost:3100/";

const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 1.5;

const COMMON_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--js-flags=--max-old-space-size=512",
  "--renderer-process-limit=1",
  "--disable-background-timer-throttling",
];

const LAUNCH_DOM = {
  executablePath: EXE,
  args: [...COMMON_ARGS, "--disable-gpu", "--disable-software-rasterizer", "--disable-gpu-compositing"],
};

const LAUNCH_GPU = {
  executablePath: EXE,
  args: [...COMMON_ARGS, "--use-gl=angle", "--use-angle=swiftshader", "--in-process-gpu", "--disable-features=Vulkan"],
};

const NARROW = 360;
const MEDIUM = 640;

function log(...a) {
  console.log("[shoot-final]", ...a);
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror:", e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (/Failed to resolve|Cannot find module|is not exported|Failed to fetch dynamically/i.test(t)) {
      log("console-error:", t);
    }
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

async function setDockWidth(page, targetPx) {
  const sep = page.locator('[data-panel-resize-handle-id], [role="separator"]').first();
  const dock = page.locator('#dock, [data-panel-id="dock"]').first();
  for (let i = 0; i < 7; i++) {
    const box = await sep.boundingBox();
    const db = await dock.boundingBox().catch(() => null);
    if (!box || !db) break;
    if (Math.abs(db.width - targetPx) < 18) break;
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
  await captureIsolated("Files", "files");
  await captureIsolated("Terminal", "terminal");
  await captureIsolated("Files", "gitdiff");
  await captureIsolated("Desktop", "desktop", { gpu: true });
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
