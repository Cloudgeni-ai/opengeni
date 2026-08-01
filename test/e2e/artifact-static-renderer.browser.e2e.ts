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

  test("preserves static HTML/CSS and native interactions with zero egress or parent escape", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const leakUrl = `http://127.0.0.1:${leakServer.port}/leak`;
    const popupUrls: string[] = [];
    context.on("page", (popup) => popupUrls.push(popup.url()));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const parentUrl = page.url();
    await page.evaluate(
      async ({ targetUrl }) => {
        document.documentElement.dataset.artifactParent = "unchanged";
        const { buildArtifactDataUrl } =
          await import("/src/components/artifacts/artifact-sandbox.tsx");
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "");
        iframe.src = buildArtifactDataUrl(`
        <style>
          @import "${targetUrl}?import";
          @font-face { font-family: leak; src: url("${targetUrl}?font"); }
          #safe {
            display: grid;
            color: rgb(102, 51, 153);
            background-color: rgb(240, 248, 255);
            background-image: url("${targetUrl}?css");
            cursor: image-set(url(data:image/png;base64,AAAA) 1x), auto;
          }
          #artifact-target:target { outline: 4px solid rgb(0, 128, 0); }
        </style>
        <meta http-equiv="refresh" content="0;url=${targetUrl}?redirect">
        <script>
          fetch("${targetUrl}?fetch");
          window.open("${targetUrl}?popup", "_blank");
          top.location.href = "${targetUrl}?top";
          parent.location.href = "${targetUrl}?parent";
          document.body.dataset.parentUrl = parent.location.href;
          document.body.dataset.parentFrames = String(parent.frames.length);
          localStorage.setItem("artifact", "escaped");
          navigator.serviceWorker.register("${targetUrl}?worker");
        </script>
        <form action="${targetUrl}?form"><button>Send</button></form>
        <a id="fragment" href="#artifact-target">Jump to target</a>
        <a id="http" href="${targetUrl}?http" target="_blank" download>HTTP</a>
        <a id="protocol-relative" href="//127.0.0.1:${new URL(targetUrl).port}/relative">Relative</a>
        <a id="javascript" href="javascript:location='${targetUrl}?javascript'">JS</a>
        <a id="data" href="data:text/html,bad">Data</a>
        <a id="blob" href="blob:${targetUrl}">Blob</a>
        <label><input id="checkbox" type="checkbox"> Native checkbox</label>
        <details id="details"><summary>Native details</summary><p>Details content</p></details>
        <main id="safe" onclick="location.href='${targetUrl}?handler'">Static artifact</main>
        <section id="artifact-target">Fragment target</section>
        <img id="http-image" src="${targetUrl}?image" alt="external image">
        <img id="data-image" src="data:image/png;base64,AAAA" alt="data image">
        <img id="blob-image" src="blob:${targetUrl}" alt="blob image">
        <picture><source id="source" src="${targetUrl}?source" srcset="${targetUrl}?srcset 1x"></picture>
        <svg width="10" height="10">
          <rect id="svg-urls" width="10" height="10"
            fill="url(${targetUrl}?paint)" stroke="url(//127.0.0.1/stroke)"
            filter="url(data:image/svg+xml,bad)" mask="url(blob:${targetUrl})"
            marker-start="url(javascript:bad)" />
        </svg>
      `);
        document.body.replaceChildren(iframe);
      },
      { targetUrl: leakUrl },
    );

    await page.locator("iframe").waitFor({ state: "attached" });
    await page.waitForTimeout(500);
    const artifactFrame = page.frames().find((frame) => frame !== page.mainFrame());
    expect(artifactFrame).toBeDefined();
    expect(artifactFrame!.url()).toStartWith("data:text/html;charset=utf-8,");
    expect(page.frames()).toHaveLength(2);
    expect(await artifactFrame!.locator("#safe").textContent()).toBe("Static artifact");
    expect(
      await artifactFrame!.locator("#safe").evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(102, 51, 153)");
    expect(
      await artifactFrame!
        .locator("#safe")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    expect(
      await artifactFrame!
        .locator("script, meta[http-equiv='refresh'], form, iframe, object, embed")
        .count(),
    ).toBe(0);
    expect(await artifactFrame!.locator("#safe").getAttribute("onclick")).toBeNull();
    for (const selector of ["#http-image", "#data-image", "#blob-image", "#source"]) {
      expect(await artifactFrame!.locator(selector).getAttribute("src")).toBeNull();
    }
    expect(await artifactFrame!.locator("#source").getAttribute("srcset")).toBeNull();
    for (const id of ["http", "protocol-relative", "javascript", "data", "blob"]) {
      expect(await artifactFrame!.locator(`#${id}`).getAttribute("href")).toBeNull();
    }
    expect(await artifactFrame!.locator("#http").getAttribute("target")).toBeNull();
    expect(await artifactFrame!.locator("#http").getAttribute("download")).toBeNull();
    for (const attribute of ["fill", "stroke", "filter", "mask", "marker-start"]) {
      expect(await artifactFrame!.locator("#svg-urls").getAttribute(attribute)).toBeNull();
    }
    const styleText = (await artifactFrame!.locator("style").textContent()) ?? "";
    expect(styleText).toContain("display: grid");
    expect(styleText).not.toMatch(/url\s*\(|@import|@font-face|https?:|data:|blob:|javascript:/i);

    await artifactFrame!.locator("#checkbox").click();
    expect(await artifactFrame!.locator("#checkbox").isChecked()).toBe(true);
    await artifactFrame!.locator("#details summary").click();
    expect(await artifactFrame!.locator("#details").getAttribute("open")).not.toBeNull();
    expect(await artifactFrame!.locator("#fragment").getAttribute("href")).toBe("#artifact-target");
    await artifactFrame!.locator("#fragment").click();
    await artifactFrame!.waitForFunction(() => location.hash === "#artifact-target");
    expect(await artifactFrame!.evaluate(() => location.hash)).toBe("#artifact-target");
    expect(
      await artifactFrame!
        .locator("#artifact-target")
        .evaluate((element) => getComputedStyle(element).outlineColor),
    ).toBe("rgb(0, 128, 0)");

    expect(page.url()).toBe(parentUrl);
    expect(await page.locator("html").getAttribute("data-artifact-parent")).toBe("unchanged");
    expect(await artifactFrame!.locator("body").getAttribute("data-parent-url")).toBeNull();
    expect(await artifactFrame!.locator("body").getAttribute("data-parent-frames")).toBeNull();
    expect(context.pages()).toHaveLength(1);
    expect(popupUrls).toEqual([]);
    expect(leakRequests).toEqual([]);

    await context.close();
  }, 30_000);
});
