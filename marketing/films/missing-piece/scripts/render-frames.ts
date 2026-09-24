/**
 * Frame-exact capture of the film page with headless Chrome.
 *
 *   bun scripts/render-frames.ts                       # all frames → out/frames/
 *   bun scripts/render-frames.ts --frames 0,300,720    # stills → out/stills/
 *   bun scripts/render-frames.ts --every 30 --out out/sheet
 *
 * Every visual is a pure function of the frame number, so workers can render
 * disjoint frame ranges in parallel and the result is identical to a serial run.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { serveFilm } from "./serve";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const stills = opt("frames");
const every = Number(opt("every", "1"));
const workers = Number(opt("workers", "3"));
const outDir = join(ROOT, opt("out", stills ? "out/stills" : "out/frames")!);
const format = (opt("format", "png") as "png" | "jpeg");
const scale = Number(opt("scale", "1"));
const chrome = process.env.CHROME_PATH ?? "/usr/local/bin/google-chrome";

async function main() {
  await mkdir(outDir, { recursive: true });
  const server = serveFilm();
  const url = `http://127.0.0.1:${server.port}/index.html?render`;
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-dev-shm-usage",
    ],
  });

  const probe = await browser.newPage();
  await probe.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await probe.goto(url, { waitUntil: "load", timeout: 30_000 });
  await probe.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
  const meta = (await probe.evaluate(() => window.__meta))!;
  const cues = await probe.evaluate(() => window.__cues);
  await mkdir(join(ROOT, "out"), { recursive: true });
  await writeFile(join(ROOT, "out/cues.json"), JSON.stringify(cues, null, 2));
  await probe.close();

  const frames: number[] = stills
    ? stills.split(",").map((s) => (s.endsWith("s") ? Math.round(Number(s.slice(0, -1)) * meta.fps) : Number(s)))
    : Array.from({ length: Math.ceil(meta.frames / every) }, (_, i) => i * every);

  const started = performance.now();
  let done = 0;
  const lanes = Array.from({ length: Math.min(workers, frames.length) }, (_, lane) =>
    frames.filter((_, i) => i % Math.min(workers, frames.length) === lane),
  );

  /** Open a page and wait until fonts and images are ready; retry a tab that stalls. */
  async function readyPage() {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: meta.width, height: meta.height, deviceScaleFactor: scale });
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await page.waitForFunction(() => window.__ready === true, { timeout: 30_000 });
        return page;
      } catch (error) {
        await page.close().catch(() => undefined);
        if (attempt === 3) throw error;
        console.warn(`page not ready (attempt ${attempt}), retrying`);
      }
    }
    throw new Error("unreachable");
  }

  const pages = [];
  for (let i = 0; i < lanes.length; i += 1) pages.push(await readyPage());

  await Promise.all(
    lanes.map(async (lane, index) => {
      const page = pages[index]!;
      for (const frame of lane) {
        await page.evaluate((f) => window.__setFrame!(f), frame);
        const buffer = await page.screenshot({
          type: format,
          ...(format === "jpeg" ? { quality: 92 } : {}),
          optimizeForSpeed: true,
          captureBeyondViewport: false,
        });
        await writeFile(join(outDir, `f_${String(frame).padStart(5, "0")}.${format === "jpeg" ? "jpg" : "png"}`), buffer);
        done += 1;
        if (done % 60 === 0 || done === frames.length) {
          const secs = (performance.now() - started) / 1000;
          process.stdout.write(`\r${done}/${frames.length} frames · ${(done / secs).toFixed(1)} fps   `);
        }
      }
      await page.close();
    }),
  );

  if (done !== frames.length) throw new Error(`rendered ${done} of ${frames.length} frames`);
  process.stdout.write("\n");
  await browser.close();
  server.stop(true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
