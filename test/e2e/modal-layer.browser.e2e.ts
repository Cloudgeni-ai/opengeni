import { afterAll, beforeAll, expect, test } from "bun:test";
import { freePort } from "@opengeni/testing/compose";
import { startProcess, type StartedProcess } from "@opengeni/testing/process";
import { chromium, type Browser, type Page } from "playwright";

const reactRoot = new URL("../../packages/react/", import.meta.url).pathname;
let browser: Browser;
let server: StartedProcess;
let fixture: string;

beforeAll(async () => {
  const port = await freePort();
  fixture = `http://127.0.0.1:${port}/test/fixtures/modal-layer/`;
  server = await startProcess(
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
      cwd: reactRoot,
      ready: async () => (await fetch(fixture).catch(() => null))?.ok === true,
      timeoutMs: 30_000,
    },
  );
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
}, 45_000);

afterAll(async () => {
  await Promise.allSettled([browser?.close(), server?.stop()]);
});

async function reorderPortal(page: Page, contained = false) {
  await page.evaluate((isContained) => {
    const portal = isContained ? document.getElementById("contained-portal")! : document.body;
    const sentinel = document.createElement("div");
    portal.append(sentinel);
    // Simulate an extension preserving its last body child: it reparents the
    // later-added portal nodes in reverse order, but not their descendants.
    const nodes = [...portal.children].filter((child) => child.hasAttribute("data-state"));
    for (const child of nodes.reverse()) portal.insertBefore(child, sentinel);
  }, contained);
}

async function receivesPointer(page: Page, selector: string) {
  return page.locator(selector).evaluate((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  });
}

test("dialog stays above its backdrop when body children are reordered", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 780 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(fixture);
    const trigger = page.getByRole("button", { name: "Open dialog" });
    await trigger.click();
    const content = page.getByRole("dialog", { name: "Share this project" });
    await content.waitFor();
    await reorderPortal(page);
    expect(await receivesPointer(page, '[data-slot="dialog-content"]')).toBe(true);
    expect(
      await page
        .locator('body > [data-slot="dialog-overlay"] [data-slot="dialog-content"]')
        .count(),
    ).toBe(1);

    const copy = content.getByRole("button", { name: "Copy link" });
    await copy.click();
    expect(await content.getByRole("button", { name: "Link copied" }).count()).toBe(1);
    for (let index = 0; index < 3; index++) {
      await page.keyboard.press("Tab");
      expect(await content.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    expect(await page.locator("body[data-scroll-locked]").count()).toBe(1);

    await page.mouse.click(10, 10);
    await content.waitFor({ state: "detached" });
    await page.locator('body > [data-slot="dialog-overlay"]').waitFor({ state: "detached" });
    await page.locator("body[data-scroll-locked]").waitFor({ state: "detached" });
    expect(await trigger.evaluate((node) => node === document.activeElement)).toBe(true);
  } finally {
    await page.close();
  }
}, 15_000);

test("contained portals stay contained and non-modal dialogs have no backdrop", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(`${fixture}?contained&theme=dark`);
    await page.getByRole("button", { name: "Open dialog" }).click();
    const content = page.getByRole("dialog");
    await content.waitFor();
    await reorderPortal(page, true);
    expect(await receivesPointer(page, '[data-slot="dialog-content"]')).toBe(true);
    expect(
      await page
        .locator('#contained-portal > [data-slot="dialog-overlay"] [role="dialog"]')
        .count(),
    ).toBe(1);
    await page.keyboard.press("Escape");
    await content.waitFor({ state: "detached" });

    await page.goto(`${fixture}?nonmodal`);
    await page.getByRole("button", { name: "Open dialog" }).click();
    await content.waitFor();
    expect(await page.locator('body > [data-slot="dialog-content"]').count()).toBe(1);
    expect(
      await page.locator('[data-slot="dialog-overlay"], body[data-scroll-locked]').count(),
    ).toBe(0);
    await page.mouse.click(10, 10);
    await content.waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 15_000);

test("the force-mounted lightbox keeps its own backdrop click and exit", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(5_000);
  try {
    await page.goto(fixture);
    const trigger = page.getByRole("button", { name: "Open screenshot" });
    await trigger.click();
    const lightbox = page.getByRole("dialog", { name: "Screenshot preview" });
    const image = lightbox.getByRole("img", { name: "Project preview" });
    await image.waitFor();
    await reorderPortal(page);
    await image.click();
    expect(await lightbox.count()).toBe(1);
    await page.mouse.click(10, 10);
    await lightbox.waitFor({ state: "detached" });
    await page.locator("body[data-scroll-locked]").waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
}, 15_000);
