// M5 evidence: screenshots of the Changes tab + virtualized file tree in every
// state the review passes need, PLUS the D2 real-browser windowing proof
// (scroll the diff pane in real chromium; assert the MOUNTED section window
// shifts and stays bounded — REAL behavior, scrollTop-driven, not a proxy).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../demo/dist");
const outDir = join(__dirname, "../.agent/ui-evidence/m5");
const CHROMIUM = "/nix/store/7xr3qnq93srn4dgak7qw74dw836wpp1y-chromium-138.0.7204.49/bin/chromium";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

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
const base = `http://127.0.0.1:${port}/workbench.html`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROMIUM });
const results = [];

async function shot(view, theme, w = 1200, h = 820) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}?view=${view}&theme=${theme}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  // The residue "open when live" row only appears once the residue dir is
  // expanded — expand node_modules so the state is visible in the screenshot.
  if (view === "files-residue") {
    const btn = page.locator('[role="treeitem"] button', { hasText: "node_modules" }).first();
    await btn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: join(outDir, `${view}-${theme}.png`) });
  await page.close();
}

for (const view of [
  "changes-large",
  "changes-small",
  "changes-guard",
  "files-dense",
  "files-residue",
]) {
  for (const theme of ["dark", "light"]) await shot(view, theme);
}

// --- D2: real-browser windowing proof (Changes tab, 40 files) ---
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  await page.goto(`${base}?view=changes-large&theme=dark`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const readIdx = () =>
    page.$$eval("[data-diff-section]", (els) =>
      els.map((e) => Number(e.getAttribute("data-diff-index"))).sort((a, b) => a - b),
    );
  const paneMetrics = () =>
    page.$eval("[data-opengeni-changes-pane]", (el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

  const atTop = await readIdx();
  const { scrollHeight, clientHeight } = await paneMetrics();
  // Scroll ~75% down the pane.
  const target = Math.floor((scrollHeight - clientHeight) * 0.75);
  await page.$eval(
    "[data-opengeni-changes-pane]",
    (el, t) => {
      el.scrollTop = t;
      el.dispatchEvent(new Event("scroll"));
    },
    target,
  );
  await page.waitForTimeout(400);
  const scrolled = await readIdx();

  const bounded = atTop.length < 40 && scrolled.length < 40 && atTop.length > 0;
  const shifted = scrolled[0] > atTop[0] && !scrolled.includes(0);
  results.push({
    proof: "D2 changes windowing",
    atTopFirst: atTop[0],
    atTopCount: atTop.length,
    scrolledFirst: scrolled[0],
    scrolledCount: scrolled.length,
    scrollHeight,
    target,
    bounded,
    shifted,
    PASS: bounded && shifted,
  });
  await page.close();
}

// --- Files: bounded mounted rows on a 2000-file VISIBLE list (real browser) ---
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  await page.goto(`${base}?view=files-flat&theme=dark`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const rows = await page.$$eval('[role="treeitem"]', (els) => els.length);
  // 2000 files are all visible; virtua mounts only a bounded window near the
  // viewport (~viewport/rowHeight + buffer), never all 2000.
  results.push({
    proof: "Files virtualization (2000 visible)",
    mountedTreeItems: rows,
    bounded: rows < 200,
    PASS: rows > 0 && rows < 200,
  });
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
const allPass = results.every((r) => r.PASS);
console.log(allPass ? "\nALL REAL-BROWSER PROOFS PASSED" : "\nSOME PROOFS FAILED");
process.exit(allPass ? 0 : 1);
