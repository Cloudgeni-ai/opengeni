import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("artifact static renderer browser acceptance", () => {
  let browser: Browser;
  let web: StartedProcess;
  let leakServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const leakRequests: string[] = [];

  beforeAll(async () => {
    const webPort = await freePort();
    baseUrl = `http://127.0.0.1:${webPort}`;
    leakServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        leakRequests.push(request.url);
        return new Response("request observed");
      },
    });
    browser = await chromium.launch();
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
        "--strictPort",
        "--force",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (
            await fetch(baseUrl, {
              signal: AbortSignal.timeout(2_000),
            }).catch(() => null)
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([web?.stop(), browser?.close()]);
    leakServer?.stop(true);
  }, 60_000);

  test("preserves static HTML/CSS while scripts, navigation, and network egress stay inert", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const leakUrl = `http://127.0.0.1:${leakServer.port}/leak`;

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      async ({ targetUrl }) => {
        const { buildArtifactSrcDoc } =
          await import("/src/components/artifacts/artifact-sandbox.tsx");
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "");
        iframe.srcdoc = buildArtifactSrcDoc(`
        <style>
          #safe { color: rgb(102, 51, 153); background-image: url("${targetUrl}?css"); }
        </style>
        <meta http-equiv="refresh" content="0;url=${targetUrl}?meta">
        <script>
          fetch("${targetUrl}?fetch");
          location.href = "${targetUrl}?navigation";
        </script>
        <form action="${targetUrl}?form"><button>Send</button></form>
        <main id="safe" onclick="location.href='${targetUrl}?handler'">Static artifact</main>
        <img src="${targetUrl}?image" alt="external image">
      `);
        document.body.replaceChildren(iframe);
      },
      { targetUrl: leakUrl },
    );

    await page.locator("iframe").waitFor({ state: "attached" });
    await page.waitForTimeout(500);
    const artifactFrame = page.frames().find((frame) => frame !== page.mainFrame());
    expect(artifactFrame).toBeDefined();
    expect(artifactFrame!.url()).toBe("about:srcdoc");
    expect(await artifactFrame!.locator("#safe").textContent()).toBe("Static artifact");
    expect(
      await artifactFrame!.locator("#safe").evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(102, 51, 153)");
    expect(
      await artifactFrame!
        .locator("script, meta[http-equiv='refresh'], form, iframe, object, embed")
        .count(),
    ).toBe(0);
    expect(await artifactFrame!.locator("#safe").getAttribute("onclick")).toBeNull();
    expect(await artifactFrame!.locator("img").getAttribute("src")).toBeNull();
    expect(leakRequests).toEqual([]);

    await context.close();
  }, 30_000);
});
