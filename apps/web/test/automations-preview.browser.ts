// Browser check for the Automations and Event sources pages over the real
// components and deterministic data. Run with:
//   bun apps/web/test/automations-preview.browser.ts
// OPENGENI_AUTOMATIONS_PREVIEW_URL reuses a preview server that is already running.
// OPENGENI_AUTOMATIONS_PREVIEW_OUTPUT saves a screenshot of each page there.
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, type Page } from "playwright/test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess } from "@opengeni/testing/process";

const reuse = process.env.OPENGENI_AUTOMATIONS_PREVIEW_URL;
const port = reuse ? 0 : await freePort();
const base = reuse ?? `http://127.0.0.1:${port}`;
const web = reuse
  ? null
  : await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--config",
        "test/automations-preview.vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        ready: async () =>
          (await fetch(`${base}/test/automations-preview.html`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
const output = process.env.OPENGENI_AUTOMATIONS_PREVIEW_OUTPUT;
if (output) await mkdir(output, { recursive: true });

const workspace = "/workspaces/11111111-1111-4111-8111-111111111111";
const github = "5ce00000-0000-4000-8000-000000000001";
const linear = "5ce00000-0000-4000-8000-000000000003";
const prReview = "00000000-0000-4000-8000-000000000001";
const finishedOnce = "00000000-0000-4000-8000-000000000004";

const visible = (page: Page, text: string) =>
  page.getByText(text).filter({ visible: true }).first();

// Form pages scroll inside their own container; `tall` fits the whole form in one capture.
const pages: Array<{
  name: string;
  path: string;
  query?: string;
  tall?: boolean;
  check: (page: Page) => Promise<void>;
}> = [
  {
    name: "list",
    path: `${workspace}/automations`,
    check: async (page) => {
      await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
      await expect(page.getByRole("switch")).toHaveCount(6);
      await expect(visible(page, "On events")).toBeVisible();
      // A finished run-once automation reads Off, and turning it on re-arms it.
      const finished = page.getByRole("switch", { name: "Answer the first order from Norway" });
      await expect(finished).toHaveAttribute("aria-checked", "false");
    },
  },
  {
    name: "list-without-events",
    path: `${workspace}/automations`,
    query: "events=0",
    check: async (page) => {
      await expect(page.getByRole("switch")).toHaveCount(2);
      await expect(page.getByRole("link", { name: "Event sources" })).toHaveCount(0);
    },
  },
  {
    name: "detail",
    path: `${workspace}/automations/${prReview}`,
    check: async (page) => {
      await expect(page.getByText("Holding events back")).toBeVisible();
      await expect(
        page.getByText("From Acme on GitHub, only when 2 conditions hold"),
      ).toBeVisible();
    },
  },
  {
    name: "detail-finished",
    path: `${workspace}/automations/${finishedOnce}`,
    check: async (page) => {
      await expect(page.getByText("Finished").first()).toBeVisible();
    },
  },
  {
    name: "new-pr-review",
    path: `${workspace}/automations/new?template=pr-review`,
    tall: true,
    check: async (page) => {
      await expect(page.getByRole("heading", { name: "New automation" })).toBeVisible();
      await expect(page.getByText("pull_request.opened").first()).toBeVisible();
      await expect(page.getByLabel("Field for condition 1")).toHaveValue("data.pull_request.draft");
    },
  },
  {
    name: "edit",
    path: `${workspace}/automations/${prReview}/edit`,
    tall: true,
    check: async (page) => {
      await page.getByRole("button", { name: /^Settings/ }).click();
      await expect(page.getByText("Event runs per hour")).toBeVisible();
    },
  },
  {
    name: "sources",
    path: `${workspace}/automations/sources`,
    check: async (page) => {
      await expect(page.getByRole("heading", { name: "Event sources" })).toBeVisible();
      await expect(visible(page, "Needs attention")).toBeVisible();
    },
  },
  {
    name: "source-github",
    path: `${workspace}/automations/sources/${github}`,
    check: async (page) => {
      await page.getByRole("tab", { name: "Deliveries" }).click();
      await expect(
        page.getByText("The signature did not match the source's secret."),
      ).toBeVisible();
    },
  },
  {
    name: "source-linear-awaiting-secret",
    path: `${workspace}/automations/sources/${linear}`,
    check: async (page) => {
      await expect(page.getByText("signing secret").first()).toBeVisible();
    },
  },
  {
    name: "source-new",
    path: `${workspace}/automations/sources/new`,
    check: async (page) => {
      await expect(page.getByText("Your own app")).toBeVisible();
    },
  },
  {
    name: "source-new-linear",
    path: `${workspace}/automations/sources/new?kind=linear`,
    check: async (page) => {
      await expect(page.getByText("Linear").first()).toBeVisible();
    },
  },
];

const only = process.env.OPENGENI_AUTOMATIONS_PREVIEW_ONLY?.split(",");
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.OPENGENI_TEST_CHROMIUM
    ? { executablePath: process.env.OPENGENI_TEST_CHROMIUM }
    : {}),
});
const failures: string[] = [];
try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      for (const entry of pages) {
        if (only && !only.includes(entry.name)) continue;
        // Dark mode is checked on the main pages only.
        if (
          theme === "dark" &&
          !["list", "detail", "new-pr-review", "source-github"].includes(entry.name)
        )
          continue;
        const page = await context.newPage();
        if (entry.tall) await page.setViewportSize({ width, height: 2400 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const query = new URLSearchParams(entry.query ?? "");
        query.set("path", entry.path);
        query.set("theme", theme);
        await page.goto(`${base}/test/automations-preview.html?${query}`, {
          waitUntil: "networkidle",
        });
        const label = `${entry.name} ${theme} ${width}`;
        try {
          await entry.check(page);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
          );
          if (overflow) failures.push(`${label}: the page scrolls sideways`);
          if (theme === "light") {
            const axe = await new AxeBuilder({ page }).disableRules(["region"]).analyze();
            for (const violation of axe.violations) {
              failures.push(`${label}: axe ${violation.id} (${violation.nodes.length})`);
            }
          }
        } catch (error) {
          failures.push(
            `${label}: ${(error as Error).message.split("\n").slice(0, 4).join(" | ")}`,
          );
        }
        const unmodeled = await page.evaluate(() => window.automationsPreviewUnmodeled ?? []);
        if (unmodeled.length > 0)
          console.log(`${label}: unmodeled ${[...new Set(unmodeled)].join(", ")}`);
        for (const error of errors) failures.push(`${label}: ${error}`);
        if (output) {
          await page.screenshot({
            path: `${output}/${entry.name}-${theme}-${width}.png`,
            fullPage: true,
          });
        }
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await web?.stop();
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("automations preview: every page rendered cleanly");
