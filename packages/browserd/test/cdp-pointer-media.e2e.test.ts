import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";

// The title follows the page's pointer media features as they change.
const page = `data:text/html,${encodeURIComponent(
  `<!doctype html><meta name="viewport" content="width=device-width"><title>-</title><script>
  const queries = ["(hover: hover)", "(any-hover: hover)", "(pointer: fine)", "(pointer: coarse)"];
  const show = () => { document.title = queries.filter((q) => matchMedia(q).matches).join(" ") || "none"; };
  for (const q of queries) matchMedia(q).addEventListener("change", show);
  show();
  </script><body>Pointer</body>`,
)}`;

const DESKTOP = "(hover: hover) (any-hover: hover) (pointer: fine)";
const TOUCH = "(pointer: coarse)";

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
    actor: { kind: "agent", subjectId: "browserd-pointer-media-e2e" },
    observationMode: "none",
    action,
  };
}

const pointerOf = async (driver: AgentBrowserDriver, targetId: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { title } = (await driver.observe(targetId)).target;
    if (title && title !== "-") return title;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (await driver.observe(targetId)).target.title;
};

// A managed desktop browser presents a mouse, as every desktop Chrome does, so
// pages apply their hover styles; a mobile size presents a touch screen; and
// a desktop size or a reset after it keeps the mouse.
e2e(
  "a managed browser presents a desktop mouse, and a touch screen at a mobile size",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-pointer-media-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const act = async (targetId: string, action: BrowserActionCommand["action"]) =>
      await driver.dispatch(command(await driver.observe(targetId), action));
    try {
      const id = (await driver.start(page)).target.id;
      expect(await pointerOf(driver, id)).toBe(DESKTOP);

      await act(id, { type: "viewport", width: 1024, height: 700, mobile: false });
      expect(await pointerOf(driver, id)).toBe(DESKTOP);
      await act(id, { type: "viewport_reset" });
      expect(await pointerOf(driver, id)).toBe(DESKTOP);

      await act(id, { type: "viewport", width: 390, height: 844, mobile: true });
      expect(await pointerOf(driver, id)).toBe(TOUCH);

      // A tab that opens while the mobile size applies is a touch screen too.
      const opened = (await driver.openTarget(page)).target.id;
      expect(await pointerOf(driver, opened)).toBe(TOUCH);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
