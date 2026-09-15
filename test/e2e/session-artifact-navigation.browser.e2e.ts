import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser } from "playwright";

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const sessionId = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const unknownEditableId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const fileId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const libraryPath = `/workspaces/${workspaceId}/artifacts`;
const sessionPath = `/workspaces/${workspaceId}/sessions/${sessionId}`;
const nativeIds = {
  document: "d10307ab68064d36855af499c9e3ccc7",
  spreadsheet: "475e389ff5d34f63b308f4901f52492b",
  presentation: "a0cc8ea0a2284b8dbc951820d0093a08",
} as const;

function chromiumLaunchOptions() {
  const playwrightPath = chromium.executablePath();
  const executablePath =
    process.env.OPENGENI_TEST_CHROMIUM ||
    (existsSync(playwrightPath)
      ? undefined
      : ["/usr/bin/google-chrome", "/usr/local/bin/chromium", "/usr/bin/chromium"].find((path) =>
          existsSync(path),
        ));
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(executablePath ? { executablePath } : {}),
  };
}

let browser: Browser;
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
        (await fetch(`${baseUrl}/test/session-artifact-navigation.html`).catch(() => null))?.ok ===
        true,
      timeoutMs: 45_000,
    },
  );
  browser = await chromium.launch(chromiumLaunchOptions());
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([browser?.close(), web?.stop()]);
}, 30_000);

function routerPath(href: string | null) {
  if (!href) return href;
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : href;
  return hash.startsWith("/") ? hash : href;
}

function fixtureUrl(path: string) {
  return `${baseUrl}/test/session-artifact-navigation.html#${path}`;
}

async function assertLibraryReturn(page: import("playwright").Page, fromSession: boolean) {
  const all = page.getByRole("link", { name: "All artifacts", exact: true });
  await all.waitFor();
  expect(await all.count()).toBe(1);
  expect(routerPath(await all.getAttribute("href"))).toBe(
    fromSession ? `${libraryPath}?fromSession=${sessionId}` : libraryPath,
  );
  const back = page.getByRole("link", { name: "Back to session", exact: true });
  expect(await back.count()).toBe(fromSession ? 1 : 0);
  if (fromSession) expect(routerPath(await back.getAttribute("href"))).toBe(sessionPath);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

for (const width of [1440, 390]) {
  for (const modality of ["document", "spreadsheet", "presentation"] as const) {
    test(`${modality} full-page navigation at ${width}px survives direct entry and reload`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        for (const fromSession of [false, true]) {
          const entry = `/workspaces/${workspaceId}/artifacts/editable/${nativeIds[modality]}${fromSession ? `?fromSession=${sessionId}` : ""}`;
          await page.goto(fixtureUrl(entry));
          await page
            .getByRole("heading", { name: `Native ${modality} editor`, exact: true })
            .waitFor();
          for (const reload of [false, true]) {
            if (reload) await page.reload();
            await assertLibraryReturn(page, fromSession);
          }
          if (process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT_DIR) {
            await page.screenshot({
              path: `${process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT_DIR}/${modality}-${width}-${fromSession ? "session" : "direct"}.png`,
            });
          }
          await page.getByRole("link", { name: "All artifacts", exact: true }).click();
          await page.getByRole("heading", { name: "Workspace artifacts", exact: true }).waitFor();
          if (fromSession) {
            await page.reload();
            await page.getByRole("link", { name: "Back to session", exact: true }).waitFor();
            await page.goBack();
            await page
              .getByRole("heading", { name: `Native ${modality} editor`, exact: true })
              .waitFor();
            await page.goForward();
            await page.getByRole("heading", { name: "Workspace artifacts", exact: true }).waitFor();
            await page.getByRole("link", { name: "Back to session", exact: true }).click();
            await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
          }
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  test(`Site full-page navigation at ${width}px preserves fromSession across reload`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const entry = `/workspaces/${workspaceId}/artifacts/${siteId}?fromSession=${sessionId}`;
      await page.goto(fixtureUrl(entry));
      await page.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
      await assertLibraryReturn(page, true);
      await page.reload();
      await assertLibraryReturn(page, true);
      if (process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT_DIR) {
        await page.screenshot({
          path: `${process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT_DIR}/site-${width}-session.png`,
        });
      }
      await page.getByRole("link", { name: "All artifacts", exact: true }).click();
      await page.getByRole("heading", { name: "Workspace artifacts", exact: true }).waitFor();
      await page.reload();
      await page.getByRole("link", { name: "Back to session", exact: true }).waitFor();
      await page.getByRole("link", { name: "Back to session", exact: true }).click();
      await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);

  test(`retained-file stub navigation at ${width}px preserves fromSession`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      const entry = `/workspaces/${workspaceId}/artifacts/files/${fileId}?fromSession=${sessionId}`;
      await page.goto(fixtureUrl(entry));
      await page.getByRole("heading", { name: "Retained file", exact: true }).waitFor();
      await assertLibraryReturn(page, true);
      await page.getByRole("link", { name: "All artifacts", exact: true }).click();
      await page.getByRole("heading", { name: "Workspace artifacts", exact: true }).waitFor();
      await page.reload();
      await page.getByRole("link", { name: "Back to session", exact: true }).click();
      await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("desktop chat link opens the dock and full-page close returns to chat", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/test/session-artifact-navigation.html`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("link", { name: "Open Project overview", exact: true }).click();
    await page.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
    expect(
      await page.getByRole("tab", { name: "Artifacts", exact: true }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(browser.contexts().length).toBe(1);
    expect(page.context().pages().length).toBe(1);
    await page.getByRole("link", { name: "Open Project overview full-page" }).click();
    await page.getByRole("link", { name: "Back to session" }).waitFor();
    await page
      .getByRole("heading", { name: "Build a project overview" })
      .waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "Back to session" }).click();
    await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
    await page.getByRole("heading", { name: "Project overview", exact: true }).waitFor();
    if (process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT)
      await page.screenshot({ path: process.env.OPENGENI_ARTIFACT_NAV_SCREENSHOT });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("unknown editable modality is not intercepted and opens the full-page editor", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/test/session-artifact-navigation.html`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("link", { name: "Open unknown artifact", exact: true }).click();
    await page.getByRole("heading", { name: "Native unknown editor", exact: true }).waitFor();
    expect(await page.getByRole("tab", { name: "Artifacts", exact: true }).count()).toBe(0);
    expect(page.url()).toContain(`/artifacts/editable/${unknownEditableId}`);
  } finally {
    await page.close();
  }
}, 60_000);

for (const modality of ["document", "spreadsheet", "presentation"] as const) {
  test(`known session ${modality} opens the dock editor instead of leaving the session`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${baseUrl}/test/session-artifact-navigation.html`, {
        waitUntil: "networkidle",
      });
      await page.getByRole("link", { name: `Open Alpha ${modality}`, exact: true }).click();
      await page.getByRole("heading", { name: `Native ${modality} editor`, exact: true }).waitFor();
      expect(
        await page
          .getByRole("tab", { name: "Artifacts", exact: true })
          .getAttribute("aria-selected"),
      ).toBe("true");
      await page.getByRole("heading", { name: "Build a project overview" }).waitFor();
    } finally {
      await page.close();
    }
  }, 60_000);
}
