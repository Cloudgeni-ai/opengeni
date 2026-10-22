import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser, type Page } from "playwright";
import { resolveSiteClientScript } from "../../packages/sdk/src/site-document";
import type { OpenGeniSiteClient, OpenGeniSiteClientOptions } from "../../packages/sdk/src/site";

describe("Site conversation navigation", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let baseUrl: string;
  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        ready: async () =>
          (await fetch(`${baseUrl}/test/site-conversations.html`).catch(() => null))?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("injected runtime executes the documented access-filtered conversation list", async () => {
    await page.goto(`${baseUrl}/test/site-conversations.html`, {
      waitUntil: "networkidle",
    });
    await page.setContent(
      resolveSiteClientScript('<script src="/__opengeni/site-tools/client.js"></script>'),
    );
    const result = await page.evaluate(async () => {
      const create = (
        globalThis as unknown as {
          createOpenGeniSiteClient: (options: OpenGeniSiteClientOptions) => OpenGeniSiteClient;
        }
      ).createOpenGeniSiteClient;
      const paths: string[] = [];
      const site = create({
        localCodemodePath: "/__opengeni/site-tools",
        fetch: (async (input) => {
          paths.push(String(input));
          return Response.json({
            pinned: [],
            sessions: [],
            nextCursor: null,
            filtersApplied: true,
            siteAccessId: "pinned-site",
          });
        }) as typeof fetch,
      });
      try {
        const list = await site.client.listSessionPage(site.workspaceId, {
          siteAccessId: "current",
        });
        let refusal: string | undefined;
        try {
          await site.client.listSessionPage(site.workspaceId);
        } catch (error) {
          refusal = (error as Error).name;
        }
        return { paths, list, refusal };
      } finally {
        site.close();
      }
    });
    expect(result.paths).toEqual([
      "/__opengeni/site-tools/sdk/v1/workspaces/site-host/sessions?view=page&siteAccessId=current",
    ]);
    expect(result.list.siteAccessId).toBe("pinned-site");
    expect(result.refusal).toBe("SiteSessionPathError");
  }, 30_000);

  for (const theme of ["light", "dark"])
    test(`${theme}: linked origin, group disclosure, paginated/searchable host panel`, async () => {
      const errors: string[] = [];
      const onError = (error: Error) => errors.push(error.message);
      page.on("pageerror", onError);
      try {
        await page.goto(`${baseUrl}/test/site-conversations.html`, {
          waitUntil: "networkidle",
        });
        await page.evaluate((selectedTheme) => {
          document.documentElement.dataset.ogTheme = selectedTheme;
          document.documentElement.style.colorScheme = selectedTheme;
        }, theme);
        const originLinks = page.getByRole("link", {
          name: "Created through Product analytics. Open Site",
        });
        expect(await originLinks.count()).toBe(2);
        expect(await originLinks.first().getAttribute("href")).toContain(
          "/sites/22222222-2222-4222-8222-222222222222",
        );
        const disclosure = page.getByRole("button", {
          name: "Expand 3 conversations from Product analytics",
        });
        await disclosure.focus();
        await page.keyboard.press("Enter");
        expect(
          await page
            .getByRole("button", {
              name: "Collapse 3 conversations from Product analytics",
            })
            .getAttribute("aria-expanded"),
        ).toBe("true");
        await page.getByRole("link", { name: "Review conversion trends" }).waitFor();
        await page.getByRole("button", { name: "Load older conversations" }).click();
        await page.getByRole("link", { name: "Investigate onboarding drop-off" }).waitFor();
        await page.getByRole("searchbox", { name: "Search Site conversations" }).fill("conversion");
        await page
          .getByRole("link", { name: "Explain last week’s activity" })
          .waitFor({ state: "hidden" });
        await page.getByRole("radio", { name: "Archived", exact: true }).click();
        await page.getByText("No matching conversations.").waitFor();
        expect(errors).toEqual([]);
      } finally {
        page.off("pageerror", onError);
      }
    }, 30_000);
});
