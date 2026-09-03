import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;
const SETUP_TOKEN = "A".repeat(43);

describe("setup-account query-token compatibility", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let webBaseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    webBaseUrl = `http://127.0.0.1:${port}`;
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
        cwd: `${repoRoot}/apps/web`,
        env: { VITE_API_BASE_URL: "" },
        ready: async () =>
          (await fetch(webBaseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))
            ?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("consumes a query bearer under generic Vite serving without URL or Referer persistence", async () => {
    const leakedReferrers: string[] = [];
    const previewBodies: unknown[] = [];
    page.on("request", (request) => {
      const referrer = request.headers().referer;
      if (referrer?.includes(SETUP_TOKEN)) leakedReferrers.push(referrer);
      if (new URL(request.url()).pathname === "/v1/auth/organization-setup/preview") {
        previewBodies.push(request.postDataJSON());
      }
    });
    await page.route("**/v1/auth/organization-setup/preview", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          state: "pending",
          organizationId: "00000000-0000-4000-8000-000000000001",
          organizationName: "Compatibility Organization",
          targetEmail: "invitee@example.test",
          targetName: "Invited User",
          organizationRole: "member",
          sharedWorkspaceAccess: [],
          expiresAt: "2099-09-10T00:00:00.000Z",
        }),
      });
    });

    await page.goto(`${webBaseUrl}/setup-account?token=${SETUP_TOKEN}&preview=1`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Join Compatibility Organization" })
      .waitFor({ timeout: 30_000 });

    expect(page.url()).toBe(`${webBaseUrl}/setup-account?preview=1`);
    expect(await page.locator("body").textContent()).not.toContain(SETUP_TOKEN);
    expect(previewBodies.length).toBeGreaterThan(0);
    expect(
      previewBodies.every(
        (body) => JSON.stringify(body) === JSON.stringify({ token: SETUP_TOKEN }),
      ),
    ).toBe(true);
    expect(leakedReferrers).toEqual([]);
  });
});
