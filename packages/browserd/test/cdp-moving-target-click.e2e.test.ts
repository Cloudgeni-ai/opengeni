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
  "a click in a batch follows a target that the page scrolls back out of the window after an earlier click",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-moving-target-");
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
    // Two accordion sections below an intro. Opening one shows a 2000 px
    // panel and then, as many sites do, scrolls the page to that section
    // with its own animation, which keeps going for 400 ms and pulls a
    // target scrolled to in the meantime back out of the window.
    const fixture = `data:text/html,${encodeURIComponent(
      '<!doctype html><title>Accordion</title><style>.panel{display:none}.panel.open{display:block;height:2000px}</style><div style="height:900px">Intro</div><h3><button aria-expanded="false" onclick="toggle(this)">First section</button></h3><div class="panel">First body</div><h3><button aria-expanded="false" onclick="toggle(this)">Second section</button></h3><div class="panel">Second body</div><script>globalThis.opened=[];function toggle(button){button.setAttribute("aria-expanded","true");button.parentElement.nextElementSibling.classList.add("open");opened.push(button.textContent);const from=scrollY,to=button.getBoundingClientRect().top+scrollY,start=performance.now();const step=()=>{const t=Math.min(1,(performance.now()-start)/400);scrollTo(0,from+(to-from)*t);if(t<1)setTimeout(step,16)};step()}</script>',
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
      actor: { kind: "human", subjectId: "moving-target-fixture" },
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

      const batch = await controller.run(
        command(initial, {
          type: "batch",
          fenceEachAction: true,
          actions: [
            { type: "click", locator: { kind: "role", role: "button", name: "First section" } },
            { type: "click", locator: { kind: "role", role: "button", name: "Second section" } },
          ],
        }),
      );
      expect(batch.error ?? null).toBeNull();
      expect(batch.state).toBe("completed");
      expect(await evaluate("opened")).toEqual(["First section", "Second section"]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
