import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A list of images whose alt-text buttons show the text once it is set, and a
// dialog that a component library mounts a moment after the click, in a layer
// at the end of the page with an overlay over everything else. The text it
// focuses is a textarea; OK saves it on the image's button.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Image alt text</title>
<style>
  body { font: 14px sans-serif; margin: 20px }
  main button { display: block; margin: 12px auto; padding: 8px }
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4) }
  [role=dialog] { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    background: #fff; padding: 20px; width: 420px }
  textarea { width: 100%; height: 80px }
</style>
<main>
  <button id="first">Ask for changes in plain language and watch them happen in the workbook.</button>
  <button id="second">Add image alt text</button>
</main>
<script>
  second.addEventListener("click", () => {
    setTimeout(() => {
      const layer = document.createElement("div");
      layer.innerHTML = '<div class="overlay"></div><div role="dialog" aria-modal="true" aria-labelledby="title">' +
        '<h2 id="title">Add image alt text</h2><textarea></textarea>' +
        '<p><button id="ok">OK</button> <button id="cancel">Cancel</button></p></div>';
      document.body.append(layer);
      layer.querySelector("textarea").focus();
      layer.querySelector("#ok").addEventListener("click", () => {
        second.textContent = layer.querySelector("textarea").value;
        layer.remove();
      });
      layer.querySelector("#cancel").addEventListener("click", () => layer.remove());
    }, 400);
  });
</script>`;

e2e(
  "a role name is matched as whole words, so a wait for OK waits for the dialog's OK",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-locator-names-");
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
    try {
      const start = await driver.start(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: start.target.id,
        flatten: true,
      });
      const read = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId },
          )
        ).result.value;
      const act = async (action: BrowserActionCommand["action"]) =>
        await controller.run(command(await driver.observe(start.target.id), action));
      const button = (name: string) => ({ kind: "role", role: "button", name }) as const;

      // Open the dialog, wait for its OK, type into the field it focuses and
      // press OK, all in one batch.
      const alt = "Select a range and ask what it does.";
      const batch = await act({
        type: "batch",
        actions: [
          { type: "click", locator: button("Add image alt text") },
          { type: "wait", condition: "visible", locator: button("OK"), timeoutMs: 5_000 },
          { type: "type", text: alt },
          { type: "click", locator: button("OK") },
        ],
      });
      expect({ state: batch.state, error: batch.error?.message }).toEqual({
        state: "completed",
        error: undefined,
      });
      expect(await read("second.textContent")).toBe(alt);
      expect(await read("document.querySelector('[role=dialog]') === null")).toBe(true);

      // "OK" is not a word of "…in the workbook.", and "work" is not one of
      // its words either; a whole word or phrase still matches.
      const visible = async (locator: { kind: "role"; role: string; name: string }) =>
        (await act({ type: "wait", condition: "visible", locator, timeoutMs: 300 })).state;
      expect(await visible(button("OK"))).toBe("failed");
      expect(await visible(button("work"))).toBe("failed");
      expect(await visible(button("plain language"))).toBe("completed");
      expect(await visible(button("the WORKBOOK."))).toBe("completed");
    } finally {
      cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-locator-names-e2e" },
    action,
  };
}
