import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("private HTTP origin UUID compatibility", () => {
  let browser: Browser;
  let page: Page;
  let web: StartedProcess;
  let fixtureUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    const loopbackBaseUrl = `http://127.0.0.1:${port}`;
    fixtureUrl = `http://insecure.opengeni.test:${port}/test/crypto-random-uuid.html`;
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
        env: { OPENGENI_WEB_ALLOWED_HOSTS: "insecure.opengeni.test" },
        ready: async () =>
          (
            await fetch(`${loopbackBaseUrl}/test/crypto-random-uuid.html`, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({
      headless: true,
      args: ["--host-resolver-rules=MAP insecure.opengeni.test 127.0.0.1"],
    });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  test("boots before application code on a non-trustworthy HTTP hostname", async () => {
    await page.goto(fixtureUrl, { waitUntil: "networkidle" });

    const body = page.locator("body");
    expect(await body.getAttribute("data-secure-context")).toBe("false");
    expect(await body.getAttribute("data-random-uuid-type")).toBe("function");
    expect(await body.getAttribute("data-uuid")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
