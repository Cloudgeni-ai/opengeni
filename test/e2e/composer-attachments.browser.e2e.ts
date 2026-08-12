import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const FILE_ID_PREFIX = "aaaaaaaa";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1xkAAAAASUVORK5CYII=",
  "base64",
);

type AttachmentState = {
  attachmentCount: number;
  readyResourceCount: number;
  restoredResourceCount: number;
  draftResourceCount: number;
  removeButtonCount: number;
  blobImageCount: number;
  dataImageCount: number;
  imageCount: number;
  hasGenericFileLabel: boolean;
  hasDurableFilename: boolean;
};

async function attachmentState(page: Page): Promise<AttachmentState> {
  return await page.evaluate((fileIdPrefix) => {
    const harness = document.querySelector<HTMLElement>('[data-testid="attachment-harness"]');
    const images = [...document.querySelectorAll<HTMLImageElement>("img")];
    const text = document.body.textContent ?? "";
    return {
      attachmentCount: Number(harness?.dataset.attachmentCount ?? -1),
      readyResourceCount: Number(harness?.dataset.readyResourceCount ?? -1),
      restoredResourceCount: Number(harness?.dataset.restoredResourceCount ?? -1),
      draftResourceCount: Number(harness?.dataset.draftResourceCount ?? -1),
      removeButtonCount: document.querySelectorAll('button[aria-label="Remove durable.png"]')
        .length,
      blobImageCount: images.filter((image) => image.src.startsWith("blob:")).length,
      dataImageCount: images.filter((image) => image.src.startsWith("data:image/png")).length,
      imageCount: images.length,
      hasGenericFileLabel: text.includes(`File ${fileIdPrefix}`),
      hasDurableFilename: text.includes("durable.png"),
    };
  }, FILE_ID_PREFIX);
}

async function waitForAttachmentState(
  page: Page,
  expected: Partial<AttachmentState>,
  timeout = 5_000,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedState, fileIdPrefix }) => {
      const harness = document.querySelector<HTMLElement>('[data-testid="attachment-harness"]');
      if (!harness) return false;
      const images = [...document.querySelectorAll<HTMLImageElement>("img")];
      const text = document.body.textContent ?? "";
      const current: AttachmentState = {
        attachmentCount: Number(harness.dataset.attachmentCount ?? -1),
        readyResourceCount: Number(harness.dataset.readyResourceCount ?? -1),
        restoredResourceCount: Number(harness.dataset.restoredResourceCount ?? -1),
        draftResourceCount: Number(harness.dataset.draftResourceCount ?? -1),
        removeButtonCount: document.querySelectorAll('button[aria-label="Remove durable.png"]')
          .length,
        blobImageCount: images.filter((image) => image.src.startsWith("blob:")).length,
        dataImageCount: images.filter((image) => image.src.startsWith("data:image/png")).length,
        imageCount: images.length,
        hasGenericFileLabel: text.includes(`File ${fileIdPrefix}`),
        hasDurableFilename: text.includes("durable.png"),
      };
      return Object.entries(expectedState).every(
        ([key, value]) => current[key as keyof AttachmentState] === value,
      );
    },
    { expectedState: expected, fileIdPrefix: FILE_ID_PREFIX },
    { timeout },
  );
  expect(await attachmentState(page)).toMatchObject(expected);
}

describe("durable composer attachment presentation", () => {
  let browser: Browser;
  let demo: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const configuredChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const sandboxChromium = "/usr/local/bin/chromium";
    const executablePath =
      configuredChromium ?? (existsSync(sandboxChromium) ? sandboxChromium : undefined);
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
    demo = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "demo",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
        "--force",
      ],
      {
        cwd: `${repoRoot}/packages/react`,
        ready: async () =>
          (
            await fetch(`${baseUrl}/composer-attachments.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([demo?.stop(), browser?.close()]);
  }, 30_000);

  test("one image stays one card through autosave, soft reload, hard refresh, fallback, and removal", async () => {
    const context = await browser.newContext({
      viewport: { width: 900, height: 700 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/composer-attachments.html?reset=1`, {
      waitUntil: "networkidle",
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "durable.png",
      mimeType: "image/png",
      buffer: PNG,
    });

    await waitForAttachmentState(page, {
      attachmentCount: 1,
      readyResourceCount: 1,
      draftResourceCount: 1,
      removeButtonCount: 1,
      blobImageCount: 1,
      hasGenericFileLabel: false,
    });

    await page.getByRole("button", { name: "Reload draft" }).click();
    await waitForAttachmentState(page, {
      attachmentCount: 1,
      readyResourceCount: 1,
      restoredResourceCount: 1,
      removeButtonCount: 1,
      blobImageCount: 1,
      hasGenericFileLabel: false,
    });

    await page.goto(`${baseUrl}/composer-attachments.html`, { waitUntil: "networkidle" });
    await waitForAttachmentState(page, {
      attachmentCount: 1,
      readyResourceCount: 1,
      removeButtonCount: 1,
      dataImageCount: 1,
      hasGenericFileLabel: false,
    });

    await page.goto(`${baseUrl}/composer-attachments.html?preview=broken`, {
      waitUntil: "networkidle",
    });
    await waitForAttachmentState(page, {
      attachmentCount: 1,
      removeButtonCount: 1,
      imageCount: 0,
      hasGenericFileLabel: false,
      hasDurableFilename: true,
    });

    await page.getByRole("button", { name: "Remove durable.png" }).click();
    await waitForAttachmentState(page, {
      attachmentCount: 0,
      readyResourceCount: 0,
      draftResourceCount: 0,
      removeButtonCount: 0,
    });

    await page.reload({ waitUntil: "networkidle" });
    await waitForAttachmentState(page, { attachmentCount: 0, removeButtonCount: 0 });
    await context.close();
  }, 60_000);
});
