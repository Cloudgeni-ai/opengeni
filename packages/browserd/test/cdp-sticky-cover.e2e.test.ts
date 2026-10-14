import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a click reveals a target hidden under a sticky column before giving up",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-sticky-cover-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `sticky_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
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
    // A data grid scrolled sideways: "Quantity" sits inside the scroller's
    // visible area, so Chromium sees nothing to scroll, but the opaque sticky
    // first column covers it. A real user scrolls the grid back first.
    const cells = Array.from({ length: 6 }, (_, index) => `<div class="cell">C${index}</div>`).join(
      "",
    );
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Sticky proof</title><style>.row{display:flex;width:1150px}.cell,button{flex:none;width:100px;height:30px}.name{position:sticky;left:0;z-index:1;flex:none;width:250px;background:#fff}</style><div id="grid" style="width:400px;overflow-x:auto"><div class="row"><div class="name">Name</div><div class="cell">A</div><button>Quantity</button>${cells}</div></div><div style="position:sticky;top:0;height:40px;background:#fff;z-index:1;margin-bottom:-40px">Bar</div><button>Pinned</button><script>globalThis.clicks=0;document.querySelectorAll("button").forEach((button)=>button.addEventListener("click",()=>clicks++));grid.scrollLeft=300;</script>`,
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
      actor: { kind: "human", subjectId: "sticky-cover-fixture" },
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
      // Precondition: the button is covered at its centre by the sticky column.
      expect(
        await evaluate(
          '(() => { const r = document.querySelector("button").getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).className; })()',
        ),
      ).toBe("name");

      const clicked = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Quantity", exact: true },
        }),
      );
      expect(clicked.error ?? null).toBeNull();
      expect(clicked.state).toBe("completed");
      expect(await evaluate("clicks")).toBe(1);
      expect(await evaluate("grid.scrollLeft")).toBeLessThan(300);

      // A sticky bar that no scrolling can move off its target: nothing
      // scrolls, no pointer input is sent, and the refusal is definite.
      const pinned = await controller.run(
        command(initial, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Pinned", exact: true },
        }),
      );
      expect(pinned.state).toBe("failed");
      expect(pinned.error?.code).toBe("invalid_action");
      expect(pinned.error?.message).toContain("covered");
      expect(await evaluate("[clicks, scrollY]")).toEqual([1, 0]);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
