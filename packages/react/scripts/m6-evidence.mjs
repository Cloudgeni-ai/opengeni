// M6 evidence: real-browser proofs of the terminal overhaul against the demo
// build (nix chromium), plus the themed screenshot suite for the review passes.
//
//   E1  renderer tier attaches; forced-fail steps down the ladder (→ DOM)
//   E2  resolved Terminal.options.fontFamily is concrete (no `var(`)
//   E3  full ANSI theme both modes (screenshots + probe theme has 16 slots)
//   E4  no 80x24 flash: the container is hidden until the first post-fit reveal
//   E5  projection→PTY (read-only→interactive) preserves the visible buffer text
//   E6  bursty output stays responsive (frame-time sample, no long stall)
//
// All proofs read REAL behavior (renderer attribute, resolved options, buffer
// text, sampled frame deltas) — never a proxy.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../demo/dist");
const outDir = join(__dirname, "../.agent/ui-evidence/m6");
const CHROMIUM = "/nix/store/7xr3qnq93srn4dgak7qw74dw836wpp1y-chromium-138.0.7204.49/bin/chromium";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

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
const base = `http://127.0.0.1:${port}/terminal.html`;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  // Maximize the chance a WebGL context inits headless (SwiftShader).
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const results = [];

// Records the (visibility, ready) sequence for the terminal container from the
// very first paint — installed BEFORE page scripts so no early frame is missed.
const RECORD_FRAMES = () => {
  window.__ogFrames = [];
  const sel = "[data-opengeni-terminal]";
  const sample = () => {
    const el = document.querySelector(sel);
    if (el) {
      window.__ogFrames.push({
        t: performance.now(),
        vis: getComputedStyle(el).visibility,
        ready: el.getAttribute("data-og-term-ready") === "true",
      });
    }
    if (window.__ogFrames.length < 400) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

async function open(view, theme, extra = "") {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  await page.addInitScript(RECORD_FRAMES);
  await page.goto(`${base}?view=${view}&theme=${theme}${extra}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ogReady === true, { timeout: 8000 }).catch(() => {});
  return page;
}

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

// ── Screenshots + E3 theme probe (idle, both themes) ─────────────────────────
for (const theme of ["dark", "light"]) {
  const page = await open("idle", theme);
  const info = await page.evaluate(() => window.__ogTermInfo ?? null);
  await shot(page, `terminal-idle-${theme}`);
  const ansiKeys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];
  const theme3 = info?.theme ?? {};
  const ansiPresent = ansiKeys.every((k) => typeof theme3[k] === "string" && theme3[k].length > 0);
  if (theme === "dark") {
    results.push({ proof: "E1 renderer attached (idle)", renderer: info?.renderer, PASS: info?.renderer === "webgl" || info?.renderer === "dom" });
    results.push({ proof: "E2 fontFamily concrete (no var()", fontFamily: info?.fontFamily, hasVar: info?.hasVarInFont, PASS: info?.hasVarInFont === false && !!info?.fontFamily });
  }
  results.push({ proof: `E3 full ANSI theme (${theme})`, ansiPresent, hasSelection: !!theme3.selectionBackground, hasCursor: !!theme3.cursor, PASS: ansiPresent && !!theme3.selectionBackground && !!theme3.cursor });
  await page.close();
}

// ── E1: forced-fail ladder ───────────────────────────────────────────────────
for (const fail of ["webgl", "webgl,canvas"]) {
  const page = await open("idle", "dark", `&fail=${encodeURIComponent(fail)}`);
  const renderer = await page.evaluate(() => document.querySelector("[data-opengeni-terminal]")?.getAttribute("data-og-term-renderer"));
  // With no canvas loader shipped, any forced webgl failure lands on DOM.
  results.push({ proof: `E1 fallback with fail=${fail}`, renderer, PASS: renderer === "dom" });
  if (fail === "webgl") await shot(page, "terminal-fallback-dom-dark");
  await page.close();
}

// ── E4: no 80x24 flash (hidden-until-fit ordering) ───────────────────────────
{
  const page = await open("idle", "dark");
  const frames = await page.evaluate(() => window.__ogFrames ?? []);
  const firstReady = frames.findIndex((f) => f.ready);
  const sawHiddenBeforeReady = frames.slice(0, firstReady < 0 ? frames.length : firstReady).some((f) => f.vis === "hidden");
  const visibleAtReady = firstReady >= 0 && frames[firstReady].vis === "visible";
  const cols = await page.evaluate(() => window.__ogTerm?.cols ?? null);
  results.push({
    proof: "E4 no 80x24 flash (hidden until post-fit reveal)",
    frameCount: frames.length,
    sawHiddenBeforeReady,
    visibleAtReady,
    fittedCols: cols,
    PASS: sawHiddenBeforeReady && visibleAtReady,
  });
  await page.close();
}

// ── E5: projection→PTY preserves the visible buffer ──────────────────────────
{
  const page = await open("handoff", "dark");
  const readBuffer = () =>
    page.evaluate(() => {
      const term = window.__ogTerm;
      if (!term?.buffer?.active) return null;
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const l = buf.getLine(i);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join("\n").replace(/\s+$/, "");
    });
  await page.waitForTimeout(300);
  const before = await readBuffer();
  await shot(page, "terminal-handoff-before-dark");
  const wasReadOnly = await page.evaluate(() => document.body.innerText.toLowerCase().includes("read-only"));
  await page.evaluate(() => window.__ogFlipInteractive?.());
  await page.waitForTimeout(400);
  const after = await readBuffer();
  await shot(page, "terminal-handoff-after-dark");
  const nowInteractive = await page.evaluate(() => !document.body.innerText.toLowerCase().includes("read-only"));
  results.push({
    proof: "E5 projection→PTY preserves visible text",
    beforeLines: before?.split("\n").length,
    preserved: !!before && before === after,
    wasReadOnly,
    nowInteractive,
    PASS: !!before && before === after && wasReadOnly && nowInteractive,
  });
  await page.close();
}

// ── E6: bursty output responsiveness (frame-time sample) ─────────────────────
{
  const page = await open("burst", "dark");
  await page.waitForTimeout(200);
  const sample = await page.evaluate(async () => {
    const term = window.__ogTerm;
    if (!term) return null;
    const deltas = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Flood: ~4000 lines of varied output written in chunks.
    const chunk = [];
    for (let i = 0; i < 4000; i++) chunk.push(`\x1b[3${i % 8}mline ${i} \x1b[1mburst\x1b[0m payload token ${i * 7}\r\n`);
    const text = chunk.join("");
    for (let i = 0; i < text.length; i += 8000) term.write(text.slice(i, i + 8000));
    await new Promise((r) => setTimeout(r, 1200));
    running = false;
    deltas.sort((a, b) => a - b);
    const p50 = deltas[Math.floor(deltas.length * 0.5)] ?? 0;
    const p95 = deltas[Math.floor(deltas.length * 0.95)] ?? 0;
    const max = deltas[deltas.length - 1] ?? 0;
    return { frames: deltas.length, p50: Math.round(p50), p95: Math.round(p95), max: Math.round(max), cols: term.cols, rows: term.rows };
  });
  await shot(page, "terminal-burst-dark");
  // Lenient: no long stall (no frame > 300ms) and the render loop kept ticking.
  const pass = !!sample && sample.frames > 20 && sample.max < 300;
  results.push({ proof: "E6 bursty output responsive", ...sample, PASS: pass });
  await page.close();
}

// ── Booting screenshot (boot-in-terminal) ────────────────────────────────────
{
  const page = await open("booting", "dark");
  // Activate the terminal (focus) so the boot-in-terminal status lines paint.
  await page.click("[data-opengeni-terminal]").catch(() => {});
  await page.waitForTimeout(2600);
  const hasBoot = await page.evaluate(() => {
    const term = window.__ogTerm;
    if (!term?.buffer?.active) return false;
    const buf = term.buffer.active;
    let text = "";
    for (let i = 0; i < buf.length; i++) text += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
    return text.toLowerCase().includes("waking machine");
  });
  await shot(page, "terminal-booting-dark");
  results.push({ proof: "boot-in-terminal status line", hasBoot, PASS: hasBoot });
  await page.close();
}

await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
const allPass = results.every((r) => r.PASS);
console.log(allPass ? "\nALL M6 REAL-BROWSER PROOFS PASSED" : "\nSOME M6 PROOFS FAILED");
process.exit(allPass ? 0 : 1);
