import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const toggle = `onclick="this.setAttribute('aria-checked', String(this.getAttribute('aria-checked') !== 'true'))"`;

// Checkboxes and switches as component libraries draw them: ARIA roles on
// buttons and divs, and native inputs that take no pointer input under a box
// their label draws.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Checkable controls</title>
<style>body { font: 14px sans-serif; margin: 20px } p { margin: 12px 0 }</style>
<p><button role="checkbox" aria-checked="false" id="terms" ${toggle}>Accept terms</button></p>
<p><div role="switch" tabindex="0" aria-checked="false" aria-label="Dark mode" id="dark"
  style="width: 40px; height: 20px; border: 1px solid" ${toggle}></div></p>
<p><div role="switch" tabindex="0" aria-checked="false" aria-label="Sync" id="sync"
  style="width: 40px; height: 20px; border: 1px solid"
  onclick="setTimeout(() => this.setAttribute('aria-checked', 'true'), 300)"></div></p>
<p><div role="checkbox" tabindex="0" aria-checked="false" aria-label="Locked" id="locked"
  style="width: 20px; height: 20px; border: 1px solid"></div></p>
<p><input type="checkbox" id="news"><label for="news">Newsletter</label></p>
<p style="position: relative">
  <input type="checkbox" id="category" style="pointer-events: none; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; margin: 0">
  <label for="category" style="position: relative; display: inline-block; padding-left: 28px; line-height: 20px">
    <span style="position: absolute; left: 0; top: 0; width: 18px; height: 18px; border: 1px solid; background: #fff"></span>Category A</label>
</p>`;

e2e(
  "check and click work on checkboxes and switches as people see them",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-check-controls-");
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
      const role = (name: string, kind = "checkbox") =>
        ({ kind: "role", role: kind, name, exact: true }) as const;

      // ARIA checkbox and switch: the state is aria-checked.
      expect(
        (await act({ type: "check", locator: role("Accept terms"), checked: true })).state,
      ).toBe("completed");
      expect(await read("terms.getAttribute('aria-checked')")).toBe("true");
      expect(
        (await act({ type: "check", locator: role("Accept terms"), checked: false })).state,
      ).toBe("completed");
      expect(await read("terms.getAttribute('aria-checked')")).toBe("false");
      expect(
        (await act({ type: "check", locator: role("Dark mode", "switch"), checked: true })).state,
      ).toBe("completed");
      expect(await read("dark.getAttribute('aria-checked')")).toBe("true");

      // A switch that shows its new state a moment after the click completes.
      expect(
        (await act({ type: "check", locator: role("Sync", "switch"), checked: true })).state,
      ).toBe("completed");
      expect(await read("sync.getAttribute('aria-checked')")).toBe("true");

      // A control that does not change says so instead of reporting success.
      const locked = await act({ type: "check", locator: role("Locked"), checked: true });
      expect(locked.state).toBe("outcome_unknown");
      expect(locked.error?.message).toBe(
        "the control was clicked but does not show checked; look at it before clicking it again",
      );

      // A label stands for its control.
      expect(
        (
          await act({
            type: "check",
            locator: { kind: "css", selector: "label[for=news]" },
            checked: true,
          })
        ).state,
      ).toBe("completed");
      expect(await read("news.checked")).toBe(true);

      // A native checkbox that takes no pointer input, drawn by its label:
      // check and click both reach it through the label.
      expect((await act({ type: "check", locator: role("Category A"), checked: true })).state).toBe(
        "completed",
      );
      expect(await read("category.checked")).toBe(true);
      expect((await act({ type: "click", locator: role("Category A") })).state).toBe("completed");
      expect(await read("category.checked")).toBe(false);
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
    actor: { kind: "agent", subjectId: "browserd-check-controls-e2e" },
    action,
  };
}
