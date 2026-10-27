import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";

// A display whose own scale is fractional, as under OS display zoom: Chromium
// lays an emulated size out in whole pixels of it.
const DISPLAY_SCALE = 1.046875;

const page = (title: string) =>
  `data:text/html,${encodeURIComponent(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="margin:0"><h1>${title}</h1>`,
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
    actor: { kind: "agent", subjectId: "browserd-viewport-reset-e2e" },
    observationMode: "none",
    action,
  };
}

async function withDriver(body: (driver: AgentBrowserDriver) => Promise<void>) {
  const directory = await mkdtemp("/tmp/ogb-viewport-reset-");
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed,
    launchArguments: [`--force-device-scale-factor=${DISPLAY_SCALE}`],
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
    await body(driver);
  } finally {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const act = async (
  driver: AgentBrowserDriver,
  targetId: string,
  action: BrowserActionCommand["action"],
) => await driver.dispatch(command(await driver.observe(targetId), action));

const size = async (driver: AgentBrowserDriver, targetId: string) => {
  const { viewport } = await driver.observe(targetId);
  return {
    width: viewport?.width,
    height: viewport?.height,
    deviceScaleFactor: viewport?.deviceScaleFactor,
    maxTouchPoints: viewport?.maxTouchPoints,
  };
};

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

/** The tab's own size once its window is laid out: a headed window that has
 * just mapped can still change size for a moment. */
const settledSize = async (driver: AgentBrowserDriver, targetId: string) => {
  let last = await size(driver, targetId);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await pause(250);
    const next = await size(driver, targetId);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  return last;
};

e2e(
  "a resized tab is reset to the window's own size and scale, and later tabs are not emulated",
  async () => {
    await withDriver(async (driver) => {
      const first = await driver.start(page("First"));
      const id = first.target.id;
      const own = await settledSize(driver, id);
      expect(own.deviceScaleFactor).toBe(DISPLAY_SCALE);
      expect(own.maxTouchPoints).toBe(0);

      await act(driver, id, { type: "viewport", width: 768, height: 1024, mobile: true });
      expect(await size(driver, id)).toMatchObject({ width: 768, height: 1024, maxTouchPoints: 1 });
      // A tab opened now gets the size the agent set, as from a resized window.
      const during = await driver.openTarget(page("During"));
      expect(await size(driver, during.target.id)).toMatchObject({ width: 768, height: 1024 });

      // Setting the tab's observed size back is not the same: the window is a
      // fractional CSS size at this scale, observed rounded, and the emulated
      // size is laid out in whole display pixels at an emulated scale of 1.
      await act(driver, id, {
        type: "viewport",
        width: own.width!,
        height: own.height!,
        mobile: false,
      });
      const setBack = await size(driver, id);
      expect(Math.abs(setBack.width! - own.width!)).toBeLessThanOrEqual(1);
      expect(Math.abs(setBack.height! - own.height!)).toBeLessThanOrEqual(1);
      expect(setBack.deviceScaleFactor).not.toBe(DISPLAY_SCALE);

      await act(driver, id, { type: "viewport_reset" });
      expect(await size(driver, id)).toEqual(own);
      // A tab opened after the reset has the window's own size and scale.
      const after = await driver.openTarget(page("After"));
      expect(await size(driver, after.target.id)).toEqual(own);
      // A tab that took the set size keeps it until it is reset itself.
      expect(await size(driver, during.target.id)).toMatchObject({ width: 768, height: 1024 });
      await act(driver, during.target.id, { type: "viewport_reset" });
      expect(await size(driver, during.target.id)).toEqual(own);
    });
  },
  90_000,
);

// A live view of the tab samples it with clipped screenshots, which change the
// page's emulation for each capture and then put back what they saw first.
e2e(
  "a viewport change and its reset take, and stay, while the tab's frames stream",
  async () => {
    await withDriver(async (driver) => {
      const first = await driver.start(page("Streamed"));
      const id = first.target.id;
      const own = await settledSize(driver, id);
      const frames = await driver.subscribeFrames(id);
      const iterator = frames[Symbol.asyncIterator]();
      try {
        await act(driver, id, {
          type: "viewport",
          width: 600,
          height: 900,
          mobile: false,
          deviceScaleFactor: 2,
        });
        await act(driver, id, {
          type: "viewport",
          width: 800,
          height: 600,
          mobile: false,
          deviceScaleFactor: 1,
        });
        const set = await size(driver, id);
        expect(set.width).toBe(800);
        expect(Math.abs(set.height! - 600)).toBeLessThanOrEqual(1);
        expect(set.deviceScaleFactor).toBeCloseTo(1, 5);
        await pause(1_000);
        expect(await size(driver, id)).toEqual(set);

        await act(driver, id, {
          type: "viewport",
          width: 600,
          height: 900,
          mobile: false,
          deviceScaleFactor: 2,
        });
        await act(driver, id, { type: "viewport_reset" });
        expect(await size(driver, id)).toEqual(own);
        await pause(1_000);
        expect(await size(driver, id)).toEqual(own);
        // Frames keep coming once the change is applied.
        const frame = await Promise.race([
          iterator.next(),
          pause(5_000).then(() => {
            throw new Error("no frame after the reset");
          }),
        ]);
        expect(frame.done).toBe(false);
      } finally {
        await frames.close();
      }

      // With the stream closed, a later resize and reset are exact too.
      await act(driver, id, {
        type: "viewport",
        width: 600,
        height: 900,
        mobile: false,
        deviceScaleFactor: 2,
      });
      await act(driver, id, { type: "viewport_reset" });
      expect(await size(driver, id)).toEqual(own);
    });
  },
  90_000,
);

// Every tab the agent opens starts in the background, where Chromium does not
// lay a page out again when its emulation is cleared until the tab is shown.
e2e(
  "a background tab is resized and reset exactly without being shown",
  async () => {
    await withDriver(async (driver) => {
      const front = await driver.start(page("Front"));
      const background = await driver.openTarget(
        `data:text/html,${encodeURIComponent(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>Background</title><body style="margin:0"><h1>Background</h1><script>document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") document.title += " shown"; });</script>`,
        )}`,
      );
      const id = background.target.id;
      const frontOwn = await settledSize(driver, front.target.id);
      const own = await settledSize(driver, id);
      expect(own.deviceScaleFactor).toBe(DISPLAY_SCALE);
      for (const viewport of [
        { width: 600, height: 900, mobile: false, deviceScaleFactor: 2 },
        { width: 768, height: 1024, mobile: true },
        { width: 800, height: 600, mobile: false },
      ]) {
        await act(driver, id, { type: "viewport", ...viewport });
        // Laid out in whole display pixels, so it can come out a pixel larger.
        expect(Math.abs((await size(driver, id)).width! - viewport.width)).toBeLessThanOrEqual(1);
        await act(driver, id, { type: "viewport_reset" });
        expect(await size(driver, id)).toEqual(own);
        await pause(500);
        expect(await size(driver, id)).toEqual(own);
      }
      // The tab stayed in the background throughout, and the front tab kept
      // its own size.
      expect((await driver.observe(id)).target.title).toBe("Background");
      expect(await size(driver, front.target.id)).toEqual(frontOwn);
    });
  },
  90_000,
);
