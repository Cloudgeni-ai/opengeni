import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a click waits for a dialog that is still fading out over its target; a still cover is not waited for",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-animating-cover-");
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
    let cdp: CdpConnection | null = null;
    // A dialog's heading sits over the "Releases" tab. Its Close button fades
    // the dialog out over 600 ms and only then removes it.
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Fading dialog</title><div role="tablist"><button role="tab" onclick="opened++">Releases</button><button role="tab" aria-selected="true">Testers</button></div><div id="dialog" role="dialog" aria-label="Edit list" style="position:fixed;top:0;left:0;width:400px;transition:opacity 600ms linear;background:white"><h2 style="margin:0;padding:20px">Edit list</h2><button onclick="const d=document.getElementById(\'dialog\');d.style.opacity=0;d.addEventListener(\'transitionend\',()=>d.remove())">Close</button></div><script>globalThis.opened=0;</script>',
    )}`;
    const command = (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "animating-cover-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(fixture);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const evaluate = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const releases = { kind: "role", role: "tab", name: "Releases", exact: true } as const;

      // The dialog is still: the tab under its heading is refused at once.
      const startedAt = Date.now();
      const refused = await controller.run(command(initial, { type: "click", locator: releases }));
      expect(refused.state).toBe("failed");
      expect(refused.error?.message).toContain("covered by dialog");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(await evaluate("opened")).toBe(0);

      // Close, then the tab, in one batch: the click waits for the fade.
      const batch = await controller.run(
        command(initial, {
          type: "batch",
          fenceEachAction: true,
          actions: [
            { type: "click", locator: { kind: "role", role: "button", name: "Close" } },
            { type: "click", locator: releases },
          ],
        }),
      );
      expect(batch.error ?? null).toBeNull();
      expect(batch.state).toBe("completed");
      expect(await evaluate("[opened, Boolean(document.getElementById('dialog'))]")).toEqual([
        1,
        false,
      ]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
