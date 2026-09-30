// Run with: bun apps/web/test/artifact-library-browser.ts
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { freePort, startProcess } from "@opengeni/testing";

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output =
  process.env.OPENGENI_ARTIFACT_LIBRARY_SCREENSHOTS ?? "/workspace/.agent/unified-artifact-library";
await mkdir(output, { recursive: true });
const web = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "dev",
    ".",
    "--config",
    "test/artifact-library.vite.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: new URL("..", import.meta.url).pathname,
    ready: async () =>
      (await fetch(`${baseUrl}/test/artifact-library.html`).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  },
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
});
try {
  for (const { width, height } of [
    { width: 1440, height: 950 },
    { width: 390, height: 950 },
    { width: 1440, height: 600 },
  ]) {
    const suffix = height === 950 ? String(width) : `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const activity = () =>
      page.evaluate(
        () =>
          Reflect.get(window, "artifactLibraryFixture") as {
            metadata: string[];
            downloads: string[];
            prompts: string[];
            siteHtml: string[];
          },
      );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const outside: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl))
        outside.push(request.url());
    });
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.data === "site-ran") Reflect.set(window, "siteRan", true);
      });
    });
    await page.goto(`${baseUrl}/test/artifact-library.html`, { waitUntil: "networkidle" });
    // The first load pays Vite's cold transforms, slow on a busy machine.
    await page
      .getByRole("link", { name: "Project mark", exact: true })
      .waitFor({ timeout: 90_000 });
    const site = page.getByRole("link", { name: "Product analytics", exact: true });
    const still = page.getByTitle("Preview of Product analytics", { exact: true });
    if (height === 600) {
      assert.ok(
        await site.evaluate(
          (element) => element.closest("li")!.getBoundingClientRect().top >= innerHeight,
        ),
        "the short viewport starts with the Site card below the visible gallery",
      );
      assert.deepEqual((await activity()).siteHtml, [], "an offscreen Site does not fetch HTML");
      assert.equal(await still.count(), 0, "an offscreen Site does not mount a still");
    }
    await page.getByRole("link", { name: "Project mark", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("img", { name: "Project mark", exact: true }).waitFor();
    await page.locator('[data-slot="content-page"]').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "New artifact", exact: true }).click();
    assert.equal(
      (await activity()).prompts.at(-1),
      "Help me create a workspace artifact. Ask what I want to make before creating it.",
    );
    // The gallery (default) shows a Site as a still: sandboxed with no scripts, no network.
    // Activate this card's viewport gate explicitly, rather than relying on the
    // preceding image scroll to happen to bring a nearby Site into view too.
    await site.scrollIntoViewIfNeeded();
    await still.waitFor({ state: "attached" });
    await still.contentFrame().getByText("Weekly active teams by plan.", { exact: true }).waitFor();
    assert.equal((await activity()).siteHtml.length, 1, "the visible Site fetches its HTML once");
    assert.equal(await still.getAttribute("sandbox"), "", "a Site still runs no code");
    assert.equal(
      await page.locator("iframe:not([sandbox=''])").count(),
      0,
      "catalog must not run a Site",
    );
    assert.equal(await page.evaluate(() => Reflect.get(window, "siteRan") ?? false), false);
    assert.deepEqual(outside, [], "a Site still makes no network requests");
    assert.equal(
      await page.getByRole("radio", { name: "Gallery", exact: true }).getAttribute("aria-checked"),
      "true",
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      "no horizontal overflow",
    );
    await page.screenshot({ path: `${output}/site-still-${suffix}.png`, fullPage: true });
    await page.locator('[data-slot="content-page"]').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: `${output}/gallery-${suffix}.png`, fullPage: true });
    await page.getByRole("radio", { name: "List", exact: true }).click();
    assert.equal(await page.locator("iframe").count(), 0, "the list shows no Site stills");
    assert.equal(await page.locator("[data-slot=list-row]").count(), 7);
    await page.screenshot({ path: `${output}/list-${suffix}.png`, fullPage: true });
    await page.getByRole("radio", { name: "Gallery", exact: true }).click();
    await page.getByRole("tab", { name: "Images", exact: true }).click();
    assert.equal(await page.locator("ul[aria-label=Artifacts] > li").count(), 2);
    await page.getByRole("button", { name: "New artifact", exact: true }).click();
    assert.equal(
      (await activity()).prompts.at(-1),
      "Help me create a workspace image. Ask what it should contain before creating it.",
    );
    await page.getByRole("link", { name: "Project mark", exact: true }).click();
    await page.getByRole("button", { name: "Expand Project mark.svg", exact: true }).waitFor();
    const imageBounds = await page
      .getByRole("img", { name: "Project mark.svg", exact: true })
      .boundingBox();
    assert.ok(imageBounds, "artifact detail image is visible");
    if (width === 1440) {
      assert.ok(imageBounds.width > 800, "image fills the detail viewer width");
      assert.ok(imageBounds.height > 360, "image is not limited to the chat height");
    } else {
      assert.ok(imageBounds.x + imageBounds.width <= width, "image fits the mobile viewport");
    }
    await page.screenshot({ path: `${output}/detail-${suffix}.png`, fullPage: true });
    await page.getByRole("button", { name: "Expand Project mark.svg", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    assert.equal((await download).suggestedFilename(), "Project mark.svg");
    await page.getByRole("link", { name: "Artifacts", exact: true }).click();
    await page.getByRole("link", { name: "Generated cover", exact: true }).click();
    await page.getByRole("button", { name: "Expand Generated cover.svg", exact: true }).waitFor();
    assert.match(
      (await page
        .getByRole("img", { name: "Generated cover.svg", exact: true })
        .getAttribute("src")) ?? "",
      /\/test\/artifact-library-image\.svg$/,
    );
    await page.getByRole("link", { name: "Artifacts", exact: true }).click();
    await page.getByRole("link", { name: "Research export.csv", exact: true }).click();
    await page
      .getByText("Preview is not available for this file. Download it to open it.")
      .waitFor();
    const fileDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    assert.equal((await fileDownload).suggestedFilename(), "Research export.csv");
    await page.getByRole("link", { name: "Artifacts", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search artifacts by title" }).fill("Launch");
    await page.getByRole("link", { name: "Launch brief", exact: true }).waitFor();
    assert.equal(await page.locator('ul[aria-label="Search results"] > li').count(), 1);
    await page.getByRole("searchbox", { name: "Search artifacts by title" }).fill("");
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Archived", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Previous dashboard", exact: true }).waitFor();
    const accessibility = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      accessibility.violations
        .filter((issue) => ["serious", "critical"].includes(issue.impact ?? ""))
        .map((issue) => issue.id),
      [],
    );
    await page.goto(`${baseUrl}/test/artifact-library.html?session=1`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "Project mark", exact: true }).click();
    await page.getByRole("button", { name: "Expand Project mark.svg", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Artifacts", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Browse session artifacts" }).count(), 1);
    const embeddedScroll = await page.locator('[data-slot="content-page"]').evaluate((element) => {
      const bottom = element.getBoundingClientRect().bottom;
      const overflows = element.scrollHeight > element.clientHeight;
      element.scrollTop = element.scrollHeight;
      return {
        bottom,
        overflows,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      };
    });
    assert.ok(embeddedScroll.bottom <= height + 1, "embedded page fits inside the dock");
    assert.ok(embeddedScroll.clientHeight > 0);
    if (embeddedScroll.overflows) {
      assert.ok(embeddedScroll.scrollTop > 0, "bottom image and padding remain reachable");
    }
    await page.screenshot({ path: `${output}/embedded-${suffix}.png`, fullPage: true });
    await page.getByRole("button", { name: "Browse session artifacts" }).click();
    await page.getByRole("heading", { name: "Session artifacts" }).waitFor();
    await page.screenshot({ path: `${output}/session-${suffix}.png`, fullPage: true });
    for (const state of ["loading", "empty", "error"]) {
      await page.goto(`${baseUrl}/test/artifact-library.html?state=${state}`, {
        waitUntil: "networkidle",
      });
      const expected =
        state === "loading"
          ? page.getByRole("status", { name: "Loading artifacts" })
          : page.getByText(state === "error" ? "Couldn't load artifacts" : /No artifacts yet/);
      await expected.waitFor();
    }
    for (const view of ["gallery", "list"]) {
      await page.evaluate(
        (next) => localStorage.setItem("opengeni:artifact-library:view:v1", next),
        view,
      );
      await page.goto(`${baseUrl}/test/artifact-library.html?many=1`, { waitUntil: "networkidle" });
      // Network idleness can precede the fixture's async React render and
      // IntersectionObserver delivery. Observe a loaded nearby thumbnail before
      // checking the request counts; retain the offscreen bounds below.
      await page.getByRole("img", { name: "Gallery image 1", exact: true }).waitFor();
      const initial = await activity();
      const lastId = "77777777-7777-4777-8777-000000000059";
      assert.ok(
        initial.metadata.length > 0 && initial.metadata.length < 60,
        `${view} only reads nearby image metadata`,
      );
      assert.ok(
        initial.downloads.length > 0 && initial.downloads.length < 60,
        `${view} only downloads nearby images`,
      );
      assert.ok(!initial.metadata.includes(lastId));
      assert.ok(!initial.downloads.includes(lastId));
      await page
        .getByRole("link", { name: "Gallery image 60", exact: true })
        .scrollIntoViewIfNeeded();
      await page.getByRole("img", { name: "Gallery image 60", exact: true }).waitFor();
      const scrolled = await activity();
      assert.ok(scrolled.metadata.includes(lastId));
      assert.ok(scrolled.downloads.includes(lastId));
      console.log(
        `${suffix}/${view}: ${initial.downloads.length} initial downloads for 60 images; offscreen last image loaded after scroll.`,
      );
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Artifact library ${suffix}: gallery with Site stills, list toggle, CTA, type tabs, viewport-gated thumbnails, search, filters, image/lightbox/download, session scrolling, empty/error/loading, accessibility passed.`,
    );
  }
} finally {
  await browser.close();
  await web.stop();
}
