import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A page whose resize work keeps its main thread busy for longer than a
// viewport change waits for it, as a page re-rendering a very large table
// for a phone layout can.
const BUSY_MS = 20_000;
const page = `data:text/html,${encodeURIComponent(
  `<!doctype html><meta name="viewport" content="width=device-width"><title>Busy</title><h1>Busy</h1><script>
  let busy = true;
  addEventListener("resize", () => {
    if (!busy) return;
    busy = false;
    const end = Date.now() + ${BUSY_MS};
    while (Date.now() < end) {}
  });
  </script>`,
)}`;

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
    actor: { kind: "agent", subjectId: "browserd-viewport-busy-e2e" },
    observationMode: "none",
    action,
  };
}

e2e(
  "a viewport change on a page busy with its resize work says so promptly, and the size holds",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-viewport-busy-");
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
    try {
      const id = (await driver.start(page)).target.id;
      const started = Date.now();
      const failure = await driver
        .dispatch(
          command(await driver.observe(id), {
            type: "viewport",
            width: 390,
            height: 844,
            mobile: true,
          }),
        )
        .then(
          () => null,
          (error: unknown) => error as { code?: unknown; message?: unknown },
        );
      // Not a tab that stopped responding, and not after the page's whole
      // resize work.
      expect(failure?.code).toBe("outcome_unknown");
      expect(String(failure?.message)).toContain("still busy laying itself out");
      expect(Date.now() - started).toBeLessThan(BUSY_MS - 5_000);

      // Once the page is done, the tab has the size and touch input set.
      await new Promise((resolve) => setTimeout(resolve, BUSY_MS - (Date.now() - started)));
      expect((await driver.observe(id)).viewport).toMatchObject({
        width: 390,
        height: 844,
        maxTouchPoints: 1,
      });
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
