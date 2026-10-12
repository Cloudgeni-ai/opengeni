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
  "a located scroll moves the nearest scrollable box and refuses when nothing moves",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-scroll-container-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `scroll_${randomUUID().slice(0, 8)}`,
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
    // A wide table inside a plain wrapper inside the real scroller, scrolled
    // sideways. Neither the table nor the wrapper can scroll; the scroller can.
    const fixture = `data:text/html,${encodeURIComponent(
      `<!doctype html><title>Scroll proof</title><div id="scroller" style="width:400px;height:200px;overflow:auto"><div id="wrapper"><table style="width:1500px"><caption>Grid</caption><tr><td>Cell</td></tr></table></div></div><script>globalThis.scrolls=0;scroller.addEventListener("scroll",()=>scrolls++);addEventListener("scroll",()=>scrolls++);scroller.scrollLeft=600;</script>`,
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
      actor: { kind: "human", subjectId: "scroll-container-fixture" },
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
      expect(await evaluate("scroller.scrollLeft")).toBe(600);
      const table = { kind: "role", role: "table", name: "Grid", exact: true } as const;

      const left = await controller.run(
        command(initial, { type: "scroll", locator: table, deltaX: -2000, deltaY: 0 }),
      );
      expect(left.error ?? null).toBeNull();
      expect(left.state).toBe("completed");
      expect(await evaluate("[scroller.scrollLeft, scrollX]")).toEqual([0, 0]);
      // Let the async scroll event land before counting.
      await evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const scrollsAfterMove = await evaluate("scrolls");
      expect(scrollsAfterMove).toBeGreaterThan(0);

      // Already at the left edge and the page cannot scroll sideways: nothing
      // moves, no scroll event fires, and the refusal is definite.
      const edge = await controller.run(
        command(initial, { type: "scroll", locator: table, deltaX: -100, deltaY: 0 }),
      );
      expect(edge.state).toBe("failed");
      expect(edge.error?.code).toBe("invalid_action");
      expect(edge.error?.message).toContain("scroll further");
      await evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      expect(await evaluate("[scroller.scrollLeft, scrolls]")).toEqual([0, scrollsAfterMove]);

      // The page itself is shorter than the viewport, so a page scroll refuses too.
      const page = await controller.run(
        command(initial, { type: "scroll", deltaX: 0, deltaY: 300 }),
      );
      expect(page.state).toBe("failed");
      expect(page.error?.code).toBe("invalid_action");
      expect(await evaluate("scrollY")).toBe(0);
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
