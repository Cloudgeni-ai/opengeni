import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const html = (body: string) =>
  new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } });

e2e(
  "a tab that closed says when and who closed it, and how to carry on",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/popup")
          // Closes itself a moment after it opens, as a sign-in popup does.
          return html(
            `<title>Popup</title><p>Popup</p><script>setTimeout(() => window.close(), 1500)</script>`,
          );
        return html(
          `<title>Opener</title><button onclick="window.open('/popup', 'popup', 'popup')">Open popup</button>`,
        );
      },
    });
    const directory = await mkdtemp("/tmp/ogb-gone-target-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const click = (observed: BrowserObservation, name: string) =>
      driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId,
        actor: { kind: "system", subjectId: "public-gone-target-fixture" },
        action: { type: "click", locator: { kind: "role", role: "button", name, exact: true } },
      });
    const waitFor = async <T>(read: () => Promise<T | null | undefined>): Promise<T> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error("timed out");
        await Bun.sleep(50);
      }
    };
    try {
      const opener = await driver.start(`http://127.0.0.1:${server.port}/`);
      await click(opener, "Open popup");
      const popup = await waitFor(async () =>
        (await driver.listTargets()).find((target) => target.url.endsWith("/popup")),
      );
      // The page closed its own tab.
      await waitFor(async () =>
        (await driver.listTargets()).every((target) => target.id !== popup.id),
      );
      await expect(driver.observe(popup.id)).rejects.toThrow(
        /^browser target does not exist: this tab was closed at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ by its page, or by a person or agent using this browser; list the current tabs and use one of their IDs$/u,
      );

      // A tab closed through the driver says so.
      const second = await driver.openTarget(`http://127.0.0.1:${server.port}/second`);
      await driver.closeTarget(second.target.id);
      await expect(driver.captureScreenshot(second.target.id)).rejects.toThrow(
        /^browser target does not exist: this tab was closed at \S+ by a close-tab call; /u,
      );
      // An ID that never belonged to this browser.
      await expect(driver.observe("0123456789ABCDEF0123456789ABCDEF")).rejects.toThrow(
        "browser target does not exist: no open tab in this browser has this ID; list the current tabs and use one of their IDs",
      );
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
