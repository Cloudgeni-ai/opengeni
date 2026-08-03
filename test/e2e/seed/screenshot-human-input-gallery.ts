// screenshot-human-input-gallery — Playwright captures for seeded human-input
// sessions. Reads tmp/human-input-ux-review/manifest.json from the seed script.
//
//   set -a && . ./.env.runtime && set +a
//   bun --env-file=/dev/null test/e2e/seed/screenshot-human-input-gallery.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const OUT_DIR = join(import.meta.dir, "../../../tmp/human-input-ux-review");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

type Manifest = {
  workspaceId: string;
  webUrl: string;
  scenarios: Array<{ id: string; title: string; sessionId: string; url: string }>;
};

type Shot = {
  id: string;
  title: string;
  file: string;
  viewport: "desktop" | "mobile";
  interaction?: string;
};

async function waitForForm(page: Page): Promise<void> {
  // SSE keeps the page from reaching networkidle; wait on the durable form.
  await page.waitForSelector("[data-human-input-request]", { timeout: 45_000 });
  await page.waitForTimeout(700);
}

async function shot(page: Page, file: string, options: { fullPage?: boolean } = {}): Promise<void> {
  await page.screenshot({
    path: join(OUT_DIR, file),
    fullPage: options.fullPage ?? false,
  });
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const shots: Shot[] = [];

  try {
    for (const scenario of manifest.scenarios) {
      // Desktop default view
      {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForForm(page);
        const file = `${scenario.id}__desktop.png`;
        await shot(page, file);
        shots.push({
          id: scenario.id,
          title: scenario.title,
          file,
          viewport: "desktop",
        });

        // Validation errors on a few representative forms
        if (
          scenario.id === "text-basic" ||
          scenario.id === "multi-bounds-other" ||
          scenario.id === "mixed-kitchen"
        ) {
          await page
            .locator('[data-human-input-request] button[type="submit"]')
            .first()
            .click({ force: true });
          await page.waitForTimeout(250);
          const errFile = `${scenario.id}__desktop-validation.png`;
          await shot(page, errFile);
          shots.push({
            id: scenario.id,
            title: scenario.title,
            file: errFile,
            viewport: "desktop",
            interaction: "empty submit → client validation",
          });
        }

        if (scenario.id === "single-desc-other") {
          // Select Other without typing → validation
          await page.getByText("Other", { exact: true }).click();
          await page
            .locator('[data-human-input-request] button[type="submit"]')
            .first()
            .click({ force: true });
          await page.waitForTimeout(250);
          const errFile = `${scenario.id}__desktop-other-empty.png`;
          await shot(page, errFile);
          shots.push({
            id: scenario.id,
            title: scenario.title,
            file: errFile,
            viewport: "desktop",
            interaction: "Other selected, empty value",
          });
        }

        if (scenario.id === "many-questions" || scenario.id === "many-options") {
          const region = page.locator("[data-human-input-request]").first();
          if (await region.count()) {
            const fileRegion = `${scenario.id}__desktop-scroll-region.png`;
            await region.screenshot({ path: join(OUT_DIR, fileRegion) });
            shots.push({
              id: scenario.id,
              title: scenario.title,
              file: fileRegion,
              viewport: "desktop",
              interaction: "form surface crop",
            });
          }
        }

        await context.close();
      }

      // Mobile for denser / layout-sensitive cases
      if (
        [
          "mixed-kitchen",
          "parallel-two",
          "long-copy",
          "many-questions",
          "allow-skip",
          "with-expiry",
        ].includes(scenario.id)
      ) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        });
        const page = await context.newPage();
        await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForForm(page);
        const file = `${scenario.id}__mobile.png`;
        await shot(page, file);
        shots.push({
          id: scenario.id,
          title: scenario.title,
          file,
          viewport: "mobile",
        });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const index = {
    createdAt: new Date().toISOString(),
    outDir: OUT_DIR,
    shots,
  };
  writeFileSync(join(OUT_DIR, "shots.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[screenshot:human-input] ${shots.length} shots → ${OUT_DIR}`);
  for (const s of shots) {
    console.log(`  - ${s.file}${s.interaction ? ` (${s.interaction})` : ""}`);
  }
}

await main();
