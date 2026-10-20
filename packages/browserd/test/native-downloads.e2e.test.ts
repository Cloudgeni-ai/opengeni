import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  BrowserAction,
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, AgentBrowserJsonRunner, BrowserDownloadStore } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

// A full Chrome that manages its own downloads saves them under their own
// names, reports them even when the tab that started one closes, and opens a
// finished PDF from its Downloads page in a new tab, as any Chrome does.
e2e(
  "a managed Chrome owns its downloads and its Downloads page opens them",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-native-downloads-");
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(".pdf")) {
          // The popup's file arrives slowly, after its tab has closed.
          const slow = path === "/popup.pdf";
          return new Response(
            slow
              ? new ReadableStream({
                  async start(controller) {
                    await Bun.sleep(600);
                    controller.enqueue(pdf);
                    controller.close();
                  },
                })
              : pdf,
            {
              headers: {
                "content-type": "application/pdf",
                "content-disposition": `attachment; filename="${slow ? "Popup report.pdf" : "Quarterly report.pdf"}"`,
              },
            },
          );
        }
        return new Response(
          '<a href="/report.pdf">Direct download</a> <a target="_blank" href="/popup.pdf">New tab download</a>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const store = await BrowserDownloadStore.open({
      rootDirectory: join(directory, "download-store"),
      browserSessionId,
      controllerGeneration,
    });
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `native_dl_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: store.filesDirectory,
      nativeDownloads: true,
      screenshotDirectory: join(directory, "screenshots"),
      headed: true,
      offscreen: true,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId,
      controllerGeneration,
      runner,
      // As for every managed browser: background tabs render as if in front.
      focusEmulation: true,
      downloadDirectory: store.filesDirectory,
      nativeDownloads: true,
      downloadEvents: {
        begin: store.begin.bind(store),
        progress: store.progress.bind(store),
        reject: store.reject.bind(store),
        followUnreported: store.followUnreported.bind(store),
      },
    });
    try {
      let page = await driver.start(`${server.url}`);
      page = await act(driver, page, clickLink("Direct download"));
      const direct = await completed(store, "Quarterly report.pdf");
      expect(basename((await store.completedFile(direct.id)).path)).toBe("Quarterly report.pdf");

      await act(driver, page, clickLink("New tab download"));
      const popup = await completed(store, "Popup report.pdf");
      const popupFile = await store.completedFile(popup.id);
      expect(basename(popupFile.path)).toBe("Popup report.pdf");
      expect(await readFile(popupFile.path)).toEqual(pdf);

      // The ordinary way to read a download: open it from Chrome's Downloads page.
      const downloads = (await driver.openTargetWithInventory("chrome://downloads")).find(
        (target) => target.url.startsWith("chrome://downloads"),
      )!;
      let list = await driver.selectTarget(downloads.id);
      for (let attempt = 0; attempt < 40 && !hasLink(list, "Quarterly report.pdf"); attempt++) {
        await Bun.sleep(100);
        list = await driver.observe(downloads.id);
      }
      await act(driver, list, clickLink("Quarterly report.pdf"));
      let opened = null;
      for (let attempt = 0; attempt < 50 && !opened; attempt++) {
        opened = (await driver.listTargets()).find(
          (target) =>
            target.url.startsWith("file://") &&
            decodeURIComponent(target.url).endsWith("/Quarterly report.pdf"),
        );
        if (!opened) await Bun.sleep(100);
      }
      expect(opened).toBeDefined();
    } finally {
      await driver.close().catch(() => undefined);
      await store.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function completed(store: BrowserDownloadStore, filename: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const download = (await store.list()).find((entry) => entry.filename === filename);
    if (download && download.status !== "in_progress") {
      expect(download).toMatchObject({ status: "completed", receivedBytes: pdf.byteLength });
      return download;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${filename} did not settle`);
}

function clickLink(name: string): BrowserAction {
  return { type: "click", locator: { kind: "role", role: "link", name, exact: true } };
}

function hasLink(observation: BrowserObservation, name: string): boolean {
  const visit = (node: InteractionSemanticNodeValue): boolean =>
    (node.role.toLowerCase() === "link" && node.name === name) || (node.children ?? []).some(visit);
  return observation.semantic?.kind === "snapshot" && observation.semantic.roots.some(visit);
}

async function act(
  driver: AgentBrowserDriver,
  observation: BrowserObservation,
  action: BrowserAction,
): Promise<BrowserObservation> {
  const command: BrowserActionCommand = {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "native-downloads-e2e" },
    action,
  };
  return await driver.dispatch(command);
}
