import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserAction, BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, AgentBrowserJsonRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a real hung renderer returns tab_not_responding without losing healthy tabs or replaying input",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-hung-renderer-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `hung_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    let shortDeadlines = false;
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      connect: async (endpoint) => {
        const connection = await CdpConnection.connect(endpoint);
        return {
          send: (method, params, options) =>
            connection.send(method, params, {
              ...options,
              // Only shorten the real renderer response deadline, not browser
              // startup. The test never fabricates a CDP timeout or failure.
              ...(shortDeadlines && options?.sessionId ? { timeoutMs: 500 } : {}),
            }),
          on: connection.on.bind(connection),
          onDisconnect: connection.onDisconnect.bind(connection),
          waitForEvent: connection.waitForEvent.bind(connection),
          close: connection.close.bind(connection),
        };
      },
    });
    let cdp: CdpConnection | null = null;
    const url =
      "data:text/html," + encodeURIComponent('<button onclick="while(true){}">Hang</button>');
    try {
      const page = await driver.start(url);
      const peer = await driver.openTarget("data:text/html,<h1>Healthy peer</h1>");
      const controller = new BrowserInteractionController({
        browserSessionId: page.browserSessionId,
        controllerGeneration: page.target.controllerGeneration,
        driver,
      });
      cdp = await CdpConnection.connect(
        (await runner.run<{ cdpUrl: string }>(["get", "cdp-url"])).cdpUrl,
      );
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: page.target.id,
        flatten: true,
      });
      // Await a real timed-out evaluation to prove that the renderer is hung.
      await expect(
        cdp.send(
          "Runtime.evaluate",
          { expression: "while(true){}" },
          {
            sessionId,
            timeoutMs: 500,
          },
        ),
      ).rejects.toThrow("timed out");
      shortDeadlines = true;
      for (const read of [
        () => driver.observe(page.target.id),
        () => driver.targetState(page.target.id),
        () =>
          driver.readDom(page.target.id, {
            kind: "count",
            selector: "button",
            expectedTargetGeneration: page.target.targetGeneration,
            expectedDocumentGeneration: page.target.documentGeneration!,
            expectedFrameId: page.frameId!,
          }),
      ]) {
        await expect(read()).rejects.toMatchObject({
          code: "tab_not_responding",
          retryable: false,
        });
      }
      const action = command(page, {
        type: "click",
        locator: { kind: "role", role: "button", name: "Hang" },
      });
      const receipt = await controller.run(action);
      expect(receipt).toMatchObject({
        state: "failed",
        dispatchedAt: null,
        error: {
          code: "tab_not_responding",
          retryable: false,
        },
      });
      expect(receipt.error!.message).toMatch(/not responding.*close.*new tab/i);
      expect(await controller.run(action)).toEqual(receipt);
      expect((await driver.observe(peer.target.id)).target.id).toBe(peer.target.id);
      await driver.closeTarget(page.target.id);

      // A click which itself hangs the renderer has a definite diagnosis, but
      // must not claim its already-dispatched effects never happened.
      shortDeadlines = false;
      const clickable = await driver.openTarget(url);
      shortDeadlines = true;
      const click = command(clickable, {
        type: "click",
        locator: { kind: "role", role: "button", name: "Hang" },
      });
      const afterInput = await controller.run(click);
      expect(afterInput).toMatchObject({
        state: "outcome_unknown",
        error: {
          code: "tab_not_responding",
          retryable: false,
        },
      });
      expect(afterInput.error!.message).toMatch(/do not repeat/i);
      expect(await controller.run(click)).toEqual(afterInput);
      expect((await driver.observe(peer.target.id)).target.id).toBe(peer.target.id);
      await driver.closeTarget(clickable.target.id);
    } finally {
      cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function command(page: BrowserObservation, action: BrowserAction): BrowserActionCommand {
  return {
    protocolVersion: page.protocolVersion,
    operationId: randomUUID(),
    browserSessionId: page.browserSessionId,
    controllerGeneration: page.target.controllerGeneration,
    targetId: page.target.id,
    expectedTargetGeneration: page.target.targetGeneration,
    expectedDocumentGeneration: page.target.documentGeneration,
    expectedFrameId: page.frameId!,
    actor: { kind: "human", subjectId: "fixture" },
    action,
  };
}
