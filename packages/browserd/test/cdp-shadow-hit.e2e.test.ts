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
  "a web-component button with slotted text is clickable, and a cover over one is still refused",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-shadow-hit-");
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
    // Design-system buttons render a native <button> in a shadow root and
    // slot their label in from the light DOM, as text or as an element.
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Shadow buttons</title><x-button id="text" onclick="clicked.push(this.id)">View permissions</x-button><x-button id="span" onclick="clicked.push(this.id)"><span>Update</span></x-button><x-button id="hidden" onclick="clicked.push(this.id)">Close</x-button><div id="layer" role="dialog" aria-label="Overlay" style="position:fixed;left:0;right:0;top:0;height:0"></div><script>globalThis.clicked=[];customElements.define("x-button",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML=\'<button style="padding:16px 32px"><slot></slot></button>\';}});</script>',
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
      actor: { kind: "human", subjectId: "shadow-hit-fixture" },
      observationMode: "none",
      action,
    });
    const button = (name: string) => ({ kind: "role", role: "button", name, exact: true }) as const;
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
      const view = await driver.observe(initial.target.id);

      for (const name of ["View permissions", "Update"]) {
        const clicked = await controller.run(
          command(view, { type: "click", locator: button(name) }),
        );
        expect(clicked.error?.message).toBeUndefined();
        expect(clicked.state).toBe("completed");
      }
      expect(await evaluate("clicked")).toEqual(["text", "span"]);

      // A real layer over a shadow-DOM button is still a cover, named as before.
      await evaluate(
        'document.getElementById("layer").style.height = "100vh"; document.getElementById("layer").style.bottom = "0"',
      );
      const covered = await controller.run(
        command(await driver.observe(initial.target.id), {
          type: "click",
          locator: button("Close"),
        }),
      );
      expect(covered.state).toBe("failed");
      expect(covered.error?.message).toContain('covered by dialog "Overlay" at its center');
      expect(await evaluate("clicked")).toEqual(["text", "span"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
