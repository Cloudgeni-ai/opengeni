import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const page = (title: string, body: string) =>
  new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`, {
    headers: { "content-type": "text/html" },
  });

e2e(
  "a click whose page then closes its own tab completes promptly",
  async () => {
    // A sign-in window as providers open it: the app opens the provider in a
    // popup, Continue posts to the provider, which redirects to the app's
    // callback on another site, and the callback tells the app and closes
    // the popup.
    let port = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "0.0.0.0",
      async fetch(request) {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/app":
            return page(
              "App",
              `<button onclick="window.open('http://localhost:${port}/dialog','signin','width=500,height=600')">Log in with provider</button><p id="status">waiting</p><script>addEventListener('message',(e)=>{document.getElementById('status').textContent='linked '+e.data})</script>`,
            );
          case "/dialog":
            return page(
              "Provider",
              '<form method="post" action="/confirm"><button type="submit">Continue</button></form>',
            );
          case "/confirm":
            await request.formData();
            await Bun.sleep(200);
            return new Response(null, {
              status: 302,
              headers: { location: `http://127.0.0.1:${port}/callback` },
            });
          case "/callback":
            return page(
              "Callback",
              "<script>window.opener.postMessage('ok','*');window.close()</script>",
            );
          default:
            return new Response("not found", { status: 404 });
        }
      },
    });
    port = server.port!;
    const directory = await mkdtemp("/tmp/ogb-click-closes-tab-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    const click = (observation: BrowserObservation, role: string, name: string) =>
      ({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId,
        controllerGeneration,
        targetId: observation.target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "human", subjectId: "click-closes-tab-fixture" },
        observationMode: "full",
        action: { type: "click", locator: { kind: "role", role, name, exact: true } },
      }) satisfies BrowserActionCommand;
    try {
      const app = await driver.start(`http://127.0.0.1:${port}/app`);
      const opened = await controller.run(click(app, "button", "Log in with provider"));
      expect(opened.state).toBe("completed");
      let popup: string | undefined;
      for (let tries = 0; tries < 50 && !popup; tries++) {
        popup = (await driver.listTargets()).find((tab) => tab.title === "Provider")?.id;
        if (!popup) await Bun.sleep(100);
      }
      expect(popup).toBeDefined();
      const provider = await driver.selectTarget(popup!);

      const startedAt = Date.now();
      const receipt = await controller.run(click(provider, "button", "Continue"));
      // The input reached the page and the page closed its tab: the click
      // completed. It must not wait out the navigation bound for a tab that
      // no longer exists, nor report an unknown outcome inviting a repeat.
      expect(receipt.error).toBeNull();
      expect(receipt.state).toBe("completed");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(receipt.observation).toBeNull();
      expect(receipt.notes).toEqual([
        {
          actionIndex: 0,
          kind: "observation_unavailable",
          message: expect.stringContaining("this tab closed"),
        },
      ]);
      const tabs = await driver.listTargets();
      expect(tabs.map((tab) => tab.id)).not.toContain(popup);
      const after = await driver.observe(app.target.id);
      expect(JSON.stringify(after.semantic)).toContain("linked ok");
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
