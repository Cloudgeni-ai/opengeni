import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("published HTML artifact browser acceptance", () => {
  let browser: Browser;
  let web: StartedProcess;
  let resourceServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const resourceRequests: string[] = [];

  beforeAll(async () => {
    const webPort = await freePort();
    baseUrl = `http://127.0.0.1:${webPort}`;
    resourceServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        resourceRequests.push(request.url);
        return new Response("window.externalResourceLoaded = true", {
          headers: {
            "access-control-allow-origin": "*",
            "content-type": "text/javascript",
          },
        });
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
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([web?.stop(), browser?.close()]);
    resourceServer?.stop(true);
  }, 60_000);

  test("executes exact HTML and external resources without parent-origin authority", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const resourceUrl = `http://127.0.0.1:${resourceServer.port}/artifact.js`;

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const parentUrl = page.url();
    await page.evaluate(
      async ({ sourceUrl }) => {
        document.documentElement.dataset.artifactParent = "unchanged";
        const { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX } =
          await import("/src/components/artifacts/artifact-sandbox.tsx");
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX);
        iframe.srcdoc = `<!doctype html>
          <form id="form"><input name="value"></form>
          <script src="${sourceUrl}"></script>
          <script>
            document.body.dataset.inlineScriptRan = "yes";
            try { document.body.dataset.parent = parent.document.documentElement.dataset.artifactParent; }
            catch { document.body.dataset.parentBlocked = "yes"; }
            try { localStorage.setItem("artifact", "escaped"); }
            catch { document.body.dataset.storageBlocked = "yes"; }
          </script>`;
        document.body.replaceChildren(iframe);
      },
      { sourceUrl: resourceUrl },
    );

    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    expect(frame).toBeDefined();
    await frame!.waitForFunction(() => document.body.dataset.inlineScriptRan === "yes");
    await frame!.waitForFunction(
      () =>
        (window as typeof window & { externalResourceLoaded?: boolean }).externalResourceLoaded ===
        true,
    );

    expect(await frame!.locator("body").getAttribute("data-inline-script-ran")).toBe("yes");
    expect(await frame!.locator("body").getAttribute("data-parent-blocked")).toBe("yes");
    expect(await frame!.locator("body").getAttribute("data-storage-blocked")).toBe("yes");
    expect(await frame!.locator("#form").count()).toBe(1);
    expect(page.url()).toBe(parentUrl);
    expect(await page.locator("html").getAttribute("data-artifact-parent")).toBe("unchanged");
    expect(resourceRequests.some((url) => url === resourceUrl)).toBe(true);

    await context.close();
  }, 30_000);

  test("retains the document bootstrap for a Site client created after load", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX, publishedHtmlArtifactDocument } =
        await import("/src/components/artifacts/artifact-sandbox.tsx");
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX);
      iframe.srcdoc = publishedHtmlArtifactDocument(
        `<!doctype html><body><script>
          window.addEventListener("load", () => setTimeout(function connect(attempt = 0) {
            const bootstrap = window.__opengeniSiteBridgeBootstrapV2?.port;
            if (!bootstrap) {
              if (attempt >= 100) {
                document.body.dataset.bootstrap = "missing";
                return;
              }
              setTimeout(() => connect(attempt + 1), 0);
              return;
            }
            const channel = new MessageChannel();
            channel.port1.addEventListener("message", event => {
              if (event.data?.type === "opengeni.site.ready" && event.data?.version === 2) {
                document.body.dataset.bootstrap = "connected";
              }
            });
            channel.port1.start();
            bootstrap.postMessage({ type: "opengeni.site.connect", version: 2 }, [channel.port2]);
          }, 0));
        </script></body>`,
        true,
      );
      iframe.addEventListener("load", () => {
        const bootstrap = new MessageChannel();
        bootstrap.port1.addEventListener("message", (event) => {
          if (
            event.data?.type !== "opengeni.site.connect" ||
            event.data?.version !== 2 ||
            event.ports.length !== 1
          ) {
            return;
          }
          const toolPort = event.ports[0]!;
          toolPort.start();
          toolPort.postMessage({ type: "opengeni.site.ready", version: 2 });
        });
        bootstrap.port1.start();
        iframe.contentWindow?.postMessage({ type: "opengeni.site.ready", version: 2 }, "*", [
          bootstrap.port2,
        ]);
      });
      document.body.replaceChildren(iframe);
    });

    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    expect(frame).toBeDefined();
    await page.waitForTimeout(1_000);
    expect(
      await frame!.evaluate(() => ({
        state: document.body.dataset.bootstrap ?? null,
        retained: Boolean(
          (
            window as typeof window & {
              __opengeniSiteBridgeBootstrapV2?: { port?: MessagePort };
            }
          ).__opengeniSiteBridgeBootstrapV2?.port,
        ),
      })),
    ).toEqual({ state: "connected", retained: true });

    await context.close();
  }, 30_000);
});
