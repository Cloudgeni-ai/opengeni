import { expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { InteractionControllerError } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  BrowserSupervisor,
  CdpConnection,
  type BrowserCommandRunner,
} from "../src";

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9,
]).toString("base64");

const validViewport = {
  width: 1440,
  height: 900,
  visualWidth: 719.5,
  visualHeight: 449.5,
  deviceScaleFactor: 2,
  maxTouchPoints: 0,
};

test.each([
  { width: 0, height: 0, visualWidth: 0, visualHeight: 0 },
  { width: -1 },
  { width: 1440.5 },
  { height: 0 },
  { visualWidth: 0 },
  { visualHeight: -1 },
  { deviceScaleFactor: 0 },
  { maxTouchPoints: -1 },
  { maxTouchPoints: 0.5 },
])(
  "unavailable viewport sample %j preserves semantic observation and later valid geometry",
  async (invalid) => {
    const fixture = await captureFixture();
    try {
      fixture.setViewport({ ...validViewport, ...invalid });
      await fixture.driver.start();
      const observation = await fixture.driver.observe("target-1");
      expect(observation.viewport).toBeNull();
      expect(observation.semantic?.kind).toBe("snapshot");
      fixture.setViewport(validViewport);
      expect((await fixture.driver.observe("target-1")).viewport).toEqual(validViewport);
    } finally {
      await fixture.driver.close();
    }
  },
);

test("viewport protocol failures remain errors rather than unavailable metrics", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.failViewport();
    await expect(fixture.driver.observe("target-1")).rejects.toMatchObject({
      method: "Runtime.evaluate",
      code: -32000,
      message: "synthetic viewport failure",
    });
  } finally {
    await fixture.driver.close();
  }
});

test("a page with no JavaScript context yet is observed without viewport metrics", async () => {
  // A tab a relaunched browser restored can still be between documents.
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.failViewport("Cannot find default execution context");
    const observation = await fixture.driver.observe("target-1");
    expect(observation.viewport).toBeNull();
    expect(observation.semantic?.kind).toBe("snapshot");
  } finally {
    await fixture.driver.close();
  }
});

test("bounded mobile frames keep one scale across rounded raster captures and viewport changes", async () => {
  const fixture = await captureFixture();
  let frames: Awaited<ReturnType<typeof fixture.driver.subscribeFrames>> | undefined;
  try {
    await fixture.driver.start();
    fixture.setRaster({ width: 487.7600402832031, height: 1055.562744140625, density: 1 });
    frames = await fixture.driver.subscribeFrames("target-1", {
      format: "jpeg",
      maxWidth: 1280,
      maxHeight: 900,
    });
    const iterator = frames[Symbol.asyncIterator]();
    const dimensions = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const frame = (await iterator.next()).value!;
      dimensions.add(frame.width + "x" + frame.height);
      expect(frame.width).toBeLessThanOrEqual(1280);
      expect(frame.height).toBeLessThanOrEqual(900);
      // A pixel-space point maps back to the same CSS location on every frame.
      expect(frame.deviceScaleFactor).toBeCloseTo(415 / 487.7600402832031, 12);
    }
    expect(dimensions.size).toBe(1);
    const scales = fixture.calls
      .filter((call) => call.method === "Page.captureScreenshot")
      .map((call) => call.params?.clip.scale);
    expect(new Set(scales).size).toBe(1);

    fixture.setRaster({ width: 800, height: 600, density: 2 });
    let resized = (await iterator.next()).value!;
    for (let index = 0; index < 3 && resized.width !== 1200; index += 1) {
      resized = (await iterator.next()).value!;
    }
    expect(resized.width).toBe(1200);
    expect(resized.height).toBe(900);
    expect(resized.deviceScaleFactor).toBe(1.5);
    for (let index = 0; index < 3; index += 1) {
      const frame = (await iterator.next()).value!;
      expect([frame.width, frame.height]).toEqual([1200, 900]);
    }

    // A new emulation density with identical CSS dimensions recalibrates rather
    // than retaining the previous high-DPI downscale.
    const observation = await fixture.driver.observe("target-1");
    fixture.setRaster({ width: 800, height: 600, density: 1 });
    await fixture.driver.dispatch({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId: observation.browserSessionId,
      controllerGeneration: observation.target.controllerGeneration,
      targetId: "target-1",
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId!,
      actor: { kind: "agent", subjectId: "frame-scale-test" },
      action: { type: "viewport", width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
    });
    let reset = (await iterator.next()).value!;
    for (let index = 0; index < 3 && reset.width !== 800; index += 1)
      reset = (await iterator.next()).value!;
    expect([reset.width, reset.height, reset.deviceScaleFactor]).toEqual([800, 600, 1]);
  } finally {
    await frames?.close();
    await fixture.driver.close();
  }
}, 10_000);

async function dispatchViewport(
  fixture: Awaited<ReturnType<typeof captureFixture>>,
  viewport: { width: number; height: number; mobile: boolean },
) {
  const observation = await fixture.driver.observe("target-1");
  await fixture.driver.dispatch({
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: "target-1",
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "viewport-capture-test" },
    action: { type: "viewport", deviceScaleFactor: 1, ...viewport },
    observationMode: "none",
  });
}

async function dispatchAction(
  fixture: Awaited<ReturnType<typeof captureFixture>>,
  action: Parameters<AgentBrowserDriver["dispatch"]>[0]["action"],
) {
  const observation = await fixture.driver.observe("target-1");
  return await fixture.driver.dispatch({
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: "target-1",
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "viewport-capture-test" },
    action,
    observationMode: "none",
  });
}

// What the page reports, in CSS pixels, at the window's own size and scale and
// under a 390x844 emulation at scale 2.
const ownMetrics = {
  width: 1280,
  height: 720,
  visualWidth: 1280,
  visualHeight: 720,
  deviceScaleFactor: 1,
  maxTouchPoints: 0,
  screenWidth: 1920,
  screenHeight: 1080,
  outerWidth: 1280,
  outerHeight: 800,
};
const emulatedMetrics = {
  ...ownMetrics,
  width: 390,
  height: 844,
  visualWidth: 390,
  visualHeight: 844,
  deviceScaleFactor: 2,
  screenWidth: 390,
  screenHeight: 844,
};

test("a viewport change waits for a frame capture already running and starts none while it applies", async () => {
  const fixture = await captureFixture();
  let frames: Awaited<ReturnType<typeof fixture.driver.subscribeFrames>> | undefined;
  try {
    fixture.setViewport(ownMetrics);
    fixture.setViewportOn("Emulation.setDeviceMetricsOverride", emulatedMetrics);
    fixture.setViewportOn("Emulation.clearDeviceMetricsOverride", ownMetrics);
    await fixture.driver.start();
    frames = await fixture.driver.subscribeFrames("target-1", { format: "jpeg" });
    for (const action of [
      { type: "viewport", width: 390, height: 844, mobile: true, deviceScaleFactor: 2 },
      { type: "viewport_reset" },
    ] as const) {
      // A clipped capture puts back the emulation it saw when it began.
      fixture.stallNext("Page.captureScreenshot");
      await fixture.waitUntilStalled();
      const capture = fixture.calls.length - 1;
      const dispatched = dispatchAction(fixture, action);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const change =
        action.type === "viewport"
          ? "Emulation.setDeviceMetricsOverride"
          : "Emulation.clearDeviceMetricsOverride";
      expect(fixture.calls.slice(capture).some((call) => call.method === change)).toBe(false);
      fixture.replyToStalled();
      await dispatched;
      const applied = fixture.calls.slice(capture);
      const sent = applied.findIndex((call) => call.method === change);
      const measured = applied
        .map((call) => call.method === "Runtime.evaluate" && call.params?.expression)
        .lastIndexOf(
          "({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,deviceScaleFactor:devicePixelRatio})",
        );
      expect(sent).toBeGreaterThan(0);
      expect(measured).toBeGreaterThan(sent);
      const captures = applied
        .slice(sent, measured)
        .filter((call) => call.method === "Page.captureScreenshot");
      // Only the reset's own one-pixel redraw, never a frame of the stream.
      expect(captures.map((call) => [call.params?.clip?.width, call.params?.clip?.height])).toEqual(
        action.type === "viewport_reset" ? [[1, 1]] : [],
      );
    }
    // Frames resume once the change is applied.
    const iterator = frames[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
  } finally {
    await frames?.close();
    await fixture.driver.close();
  }
}, 10_000);

test("a capture still running after its frame stream closed holds off a viewport change", async () => {
  const fixture = await captureFixture();
  try {
    fixture.setViewport(ownMetrics);
    fixture.setViewportOn("Emulation.setDeviceMetricsOverride", emulatedMetrics);
    await fixture.driver.start();
    const frames = await fixture.driver.subscribeFrames("target-1", { format: "jpeg" });
    fixture.stallNext("Page.captureScreenshot");
    await fixture.waitUntilStalled();
    await frames.close();
    const capture = fixture.calls.length - 1;
    const dispatched = dispatchAction(fixture, {
      type: "viewport",
      width: 390,
      height: 844,
      mobile: true,
      deviceScaleFactor: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      fixture.calls
        .slice(capture)
        .some((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toBe(false);
    fixture.replyToStalled();
    await dispatched;
    expect(
      fixture.calls
        .slice(capture)
        .some((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toBe(true);
  } finally {
    await fixture.driver.close();
  }
});

test("a viewport change or reset the page did not take is an unknown outcome, never a success", async () => {
  const fixture = await captureFixture();
  try {
    fixture.setViewport(ownMetrics);
    await fixture.driver.start();
    // The page keeps its own size: the override did not take.
    await expect(
      dispatchAction(fixture, {
        type: "viewport",
        width: 390,
        height: 844,
        mobile: true,
        deviceScaleFactor: 2,
      }),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
      message:
        "The viewport change was sent, but the tab did not take that size. Observe the tab to see its size now.",
    });
    // It was sent once more before giving up.
    expect(
      fixture.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(2);

    fixture.setViewportOn("Emulation.setDeviceMetricsOverride", emulatedMetrics);
    await dispatchAction(fixture, {
      type: "viewport",
      width: 390,
      height: 844,
      mobile: true,
      deviceScaleFactor: 2,
    });
    // A cleared emulation that leaves the page at the emulated layout size, as
    // Chromium does after a capture put an earlier emulation back.
    fixture.setViewportOn("Emulation.clearDeviceMetricsOverride", {
      ...emulatedMetrics,
      deviceScaleFactor: 1,
      screenWidth: 1920,
      screenHeight: 1080,
    });
    await expect(dispatchAction(fixture, { type: "viewport_reset" })).rejects.toMatchObject({
      code: "outcome_unknown",
      message:
        "The viewport reset was sent, but the tab did not return to its own size and scale. Observe the tab to see its size now.",
    });
    expect(
      fixture.calls.filter((call) => call.method === "Emulation.clearDeviceMetricsOverride"),
    ).toHaveLength(2);

    fixture.setViewportOn("Emulation.clearDeviceMetricsOverride", ownMetrics);
    await dispatchAction(fixture, { type: "viewport_reset" });

    // A page that cannot be read does not confirm a change either.
    fixture.setViewportOn("Emulation.setDeviceMetricsOverride", { screenWidth: 0 });
    const overrides = fixture.calls.filter(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    ).length;
    await expect(
      dispatchAction(fixture, { type: "viewport", width: 800, height: 600, mobile: false }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(
      fixture.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(overrides + 2);
    // The page is read in a world of the driver's own, where page scripts
    // cannot redefine what it reports.
    const readings = fixture.calls.filter(
      (call) =>
        call.method === "Runtime.evaluate" &&
        String(call.params?.expression).includes("screenWidth:screen.width"),
    );
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.every((call) => call.params?.contextId === 7)).toBe(true);
  } finally {
    await fixture.driver.close();
  }
});

test("a capture right after a viewport change waits for the new surface instead of the old one", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    await dispatchViewport(fixture, { width: 390, height: 844, mobile: true });
    fixture.setRaster({ width: 390, height: 844, density: 1 });
    // Chromium still presents the previous 1280px surface twice.
    fixture.presentStale({ width: 1280, height: 633, density: 1 }, 2);
    fixture.calls.length = 0;
    const shot = await fixture.driver.captureScreenshot("target-1", { format: "jpeg" });
    expect([shot.width, shot.height, shot.deviceScaleFactor]).toEqual([390, 844, 1]);
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      3,
    );
  } finally {
    await fixture.driver.close();
  }
});

test("a capture publishes what it has when the emulated surface never arrives", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    await dispatchViewport(fixture, { width: 390, height: 844, mobile: true });
    fixture.setRaster({ width: 1280, height: 633, density: 1 });
    const started = Date.now();
    const shot = await fixture.driver.captureScreenshot("target-1", { format: "jpeg" });
    expect([shot.width, shot.height]).toEqual([1280, 633]);
    expect(Date.now() - started).toBeLessThan(2_500);
  } finally {
    await fixture.driver.close();
  }
});

test("a capture without viewport emulation never waits for a particular size", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.setRaster({ width: 1280, height: 633, density: 1 });
    fixture.calls.length = 0;
    const shot = await fixture.driver.captureScreenshot("target-1", { format: "jpeg" });
    expect([shot.width, shot.height]).toEqual([1280, 633]);
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      1,
    );
  } finally {
    await fixture.driver.close();
  }
});

test("Lightpanda rejects screenshots before CDP can return placeholder pixels", async () => {
  const fixture = await captureFixture(undefined, "lightpanda");
  try {
    await fixture.driver.start();
    fixture.calls.length = 0;
    await expect(fixture.driver.captureScreenshot("target-1")).rejects.toMatchObject({
      code: "unsupported",
      message: "Lightpanda does not render page screenshots; use semantic observation",
    });
    await expect(fixture.driver.subscribeFrames("target-1")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(fixture.calls).toHaveLength(0);
    expect((await fixture.driver.observe("target-1")).semantic?.kind).toBe("snapshot");
  } finally {
    await fixture.driver.close();
  }
});

test.each(["Page.enable", "Emulation.setFocusEmulationEnabled", "Page.getFrameTree"])(
  "failed target initialization at %s detaches its session and permits a fresh attachment",
  async (method) => {
    const fixture = await captureFixture();
    try {
      await fixture.driver.start();
      fixture.calls.length = 0;
      fixture.stallNext(method);
      jest.useFakeTimers();
      const failed = fixture.driver.observe("target-2").catch((error: unknown) => error);
      await fixture.waitUntilStalled();
      jest.advanceTimersByTime(30_000);
      await settle();
      expect(await failed).toMatchObject({ code: "tab_not_responding", cause: { method } });
      const initialization = fixture.calls.find((call) => call.method === method)!;
      expect(fixture.calls.filter((call) => call.method === "Target.detachFromTarget")).toEqual([
        expect.objectContaining({ params: { sessionId: initialization.sessionId } }),
      ]);
      expect(
        fixture.calls.some((call) => ["Target.closeTarget", "Browser.close"].includes(call.method)),
      ).toBe(false);
      fixture.replyToStalled();
      jest.useRealTimers();
      expect((await fixture.driver.observe("target-2")).target.id).toBe("target-2");
      expect(fixture.calls.filter((call) => call.method === "Target.attachToTarget")).toHaveLength(
        2,
      );
    } finally {
      jest.useRealTimers();
      await fixture.driver.close();
    }
  },
);

test("a stalled detach preserves the initialization failure and bounds cleanup", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.stallNext("Page.enable");
    jest.useFakeTimers();
    const failed = fixture.driver.observe("target-2").catch((error: unknown) => error);
    await fixture.waitUntilStalled();
    fixture.stallNext("Target.detachFromTarget");
    jest.advanceTimersByTime(30_000);
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(500);
    await settle();
    expect(await failed).toMatchObject({
      code: "tab_not_responding",
      cause: { method: "Page.enable" },
    });
    expect(await fixture.driver.isAvailable()).toBe(true);
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

test("browser liveness does not depend on a renderer answering page commands", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.calls.length = 0;
    fixture.stallNext("Page.getFrameTree");
    jest.useFakeTimers();
    const available = fixture.driver.isAvailable();
    await settle();
    jest.advanceTimersByTime(2_000);
    await settle();
    expect(await available).toBe(true);
    expect(fixture.calls.map((call) => call.method)).toEqual(["Browser.getVersion"]);
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

test("a browser command deadline does not authorize destructive runtime recovery", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.stallNext("Browser.getVersion");
    jest.useFakeTimers();
    const available = fixture.driver.isAvailable();
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(2_000);
    await settle();
    expect(await available).toBe(true);
    fixture.replyToStalled();
    await settle();
    expect(await fixture.driver.isAvailable()).toBe(true);
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

test("a closed browser connection still authorizes runtime recovery", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.disconnect();
    expect(await fixture.driver.isAvailable()).toBe(false);
  } finally {
    await fixture.driver.close();
  }
});

test("the connection state tells an answering browser from a silent or lost one", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    expect(await fixture.driver.connectionState()).toBe("connected");
    // A browser that does not answer in time is not shown to be connected.
    fixture.stallNext("Browser.getVersion");
    jest.useFakeTimers();
    const silent = fixture.driver.connectionState();
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(2_000);
    await settle();
    expect(await silent).toBe("unresponsive");
    fixture.replyToStalled();
    await settle();
    jest.useRealTimers();
    fixture.disconnect();
    expect(await fixture.driver.connectionState()).toBe("lost");
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

test("the supervisor preserves target authority when a failed capture has a slow liveness probe", async () => {
  const reference = { browserSessionId: randomUUID(), controllerGeneration: randomUUID() };
  const fixture = await captureFixture(reference);
  const directory = await mkdtemp("/tmp/ogb-capture-probe-");
  let driverLifecycles = 0;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    createDriver: async () => {
      driverLifecycles += 1;
      return fixture.driver;
    },
  });
  try {
    const created = await supervisor.createSession({ ...reference, headed: false });
    fixture.stallNext("Page.captureScreenshot");
    jest.useFakeTimers();
    const failed = supervisor
      .screenshot(reference, created.observation.target.id)
      .catch((error: unknown) => error);
    await fixture.waitUntilStalled();
    fixture.stallNext("Browser.getVersion");
    jest.advanceTimersByTime(10_000);
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(2_000);
    await settle();
    expect(await failed).toMatchObject({ code: "timeout", retryable: true });
    expect(driverLifecycles).toBe(1);
    expect(await supervisor.listTargets(reference)).toContainEqual(created.observation.target);
    expect(fixture.calls.some((call) => call.method === "Browser.close")).toBe(false);
  } finally {
    jest.useRealTimers();
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stalled screenshot leaves other targets available and releases its own queue", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    await fixture.driver.captureScreenshot("target-2", { format: "jpeg" });
    fixture.calls.length = 0;
    fixture.stallNext("Page.captureScreenshot");
    jest.useFakeTimers();
    const failed = fixture.driver
      .captureScreenshot("target-1", { format: "jpeg" })
      .catch((error: unknown) => error);
    await fixture.waitUntilStalled();
    const sameTarget = fixture.driver.captureScreenshot("target-1", { format: "jpeg" });
    const otherTarget = fixture.driver.captureScreenshot("target-2", { format: "jpeg" });
    await settle();
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      2,
    );
    expect(await otherTarget).toMatchObject({ targetId: "target-2", width: 3, height: 2 });
    jest.advanceTimersByTime(10_000);
    await settle();
    const error = await failed;
    expect(error).toBeInstanceOf(InteractionControllerError);
    expect(error).toMatchObject({
      code: "timeout",
      retryable: true,
      message: "browser screenshot timed out during Page.captureScreenshot",
      cause: { message: "CDP Page.captureScreenshot timed out" },
    });
    expect(await sameTarget).toMatchObject({ targetId: "target-1", width: 3, height: 2 });
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      3,
    );
    expect(fixture.calls.filter((call) => call.method === "Target.activateTarget")).toHaveLength(0);
    // A delayed reply to the expired command must not contaminate the next capture.
    fixture.replyToStalled();
    await settle();
    expect(await fixture.driver.captureScreenshot("target-1", { format: "jpeg" })).toMatchObject({
      targetId: "target-1",
      width: 3,
    });
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

test.each(["Page.getFrameTree", "Page.getLayoutMetrics"])(
  "a stalled %s read identifies the screenshot stage and leaves the queue usable",
  async (stage) => {
    const fixture = await captureFixture();
    try {
      await fixture.driver.start();
      fixture.stallNext(stage);
      jest.useFakeTimers();
      const failed = fixture.driver.captureScreenshot("target-1").catch((error: unknown) => error);
      await fixture.waitUntilStalled();
      jest.advanceTimersByTime(10_000);
      await settle();
      expect(await failed).toMatchObject({
        code: "timeout",
        retryable: true,
        message: `browser screenshot timed out during ${stage}`,
      });
      expect(await fixture.driver.captureScreenshot("target-1", { format: "jpeg" })).toMatchObject({
        targetId: "target-1",
        width: 3,
      });
    } finally {
      jest.useRealTimers();
      await fixture.driver.close();
    }
  },
);

test("a fully fenced action preserves a frame timeout before dispatch", async () => {
  const reference = { browserSessionId: randomUUID(), controllerGeneration: randomUUID() };
  const fixture = await captureFixture(reference);
  const directory = await mkdtemp("/tmp/ogb-frame-timeout-");
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    createDriver: async () => fixture.driver,
  });
  try {
    const { observation } = await supervisor.createSession({ ...reference, headed: false });
    fixture.calls.length = 0;
    fixture.stallNext("Page.getFrameTree");
    jest.useFakeTimers();
    const receipt = supervisor.action({
      protocolVersion: 1,
      ...reference,
      operationId: randomUUID(),
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId!,
      actor: { kind: "human", subjectId: "fixture" },
      action: { type: "click", locator: { kind: "ref", ref: "e1" } },
    });
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(30_000);
    await settle();
    expect(await receipt).toMatchObject({
      state: "failed",
      dispatchedAt: null,
      error: {
        code: "tab_not_responding",
        retryable: false,
        message: expect.stringMatching(/not responding.*close.*new tab/i),
      },
    });
    expect(fixture.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
    expect(await fixture.driver.isAvailable()).toBe(true);
  } finally {
    jest.useRealTimers();
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("screenshot frame, layout, and pixel reads share one deadline", async () => {
  const fixture = await captureFixture();
  try {
    await fixture.driver.start();
    fixture.delayNext("Page.getFrameTree", 6_000);
    fixture.delayNext("Page.getLayoutMetrics", 3_000);
    fixture.stallNext("Page.captureScreenshot");
    jest.useFakeTimers();
    let finished = false;
    const failed = fixture.driver.captureScreenshot("target-1").catch((error: unknown) => {
      finished = true;
      return error;
    });
    await settle();
    jest.advanceTimersByTime(6_000);
    await settle();
    jest.advanceTimersByTime(3_000);
    await fixture.waitUntilStalled();
    jest.advanceTimersByTime(999);
    await settle();
    expect(finished).toBe(false);
    jest.advanceTimersByTime(1);
    await settle();
    expect(await failed).toMatchObject({
      code: "timeout",
      message: "browser screenshot timed out during Page.captureScreenshot",
    });
  } finally {
    jest.useRealTimers();
    await fixture.driver.close();
  }
});

async function settle() {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

async function captureFixture(
  reference = { browserSessionId: randomUUID(), controllerGeneration: "controller-capture" },
  engine: "chromium" | "lightpanda" = "chromium",
) {
  const calls: Array<{
    id: number;
    method: string;
    sessionId?: string;
    params?: Record<string, any>;
  }> = [];
  let raster: { width: number; height: number; density: number } | null = null;
  // Surfaces Chromium still presents from before a viewport change.
  const staleRasters: Array<{ width: number; height: number; density: number }> = [];
  let viewport: unknown = "complete";
  // The device metrics the driver last emulated, which a page's own reading
  // follows unless a test sets what the page reports.
  let emulation: { width: number; height: number; deviceScaleFactor: number } | null = null;
  // What the page reports from the moment a command is sent.
  const viewportOn = new Map<string, unknown>();
  let viewportFailure: string | null = null;
  let stalledMethod: string | null = null;
  let stalled: { id: number; method: string; sessionId?: string } | null = null;
  let reachedStall = () => {};
  let waitingForStall = Promise.resolve();
  const delays = new Map<string, number>();
  const socket = new EventTarget() as EventTarget & {
    readyState: number;
    binaryType: string;
    send(raw: string): void;
    close(): void;
  };
  const reply = (command: (typeof calls)[number]) => {
    let result: unknown = {};
    if (command.method === "Browser.getVersion") result = { product: "Chrome/151.0.0.0" };
    if (command.method === "Target.getTargets") {
      result = {
        targetInfos: [1, 2].map((index) => ({
          targetId: `target-${index}`,
          type: "page",
          title: "Fixture",
          url: "about:blank",
          attached: true,
        })),
      };
    }
    if (command.method === "Target.attachToTarget") {
      result = {
        sessionId: `session-${calls.filter((call) => call.method === command.method).length}`,
      };
    }
    if (command.method === "Page.getFrameTree") {
      result = {
        frameTree: { frame: { id: "frame-1", loaderId: "loader-1", url: "about:blank" } },
      };
    }
    if (command.method === "Emulation.setDeviceMetricsOverride") {
      emulation = {
        width: Number(command.params?.width),
        height: Number(command.params?.height),
        deviceScaleFactor: Number(command.params?.deviceScaleFactor),
      };
    }
    if (command.method === "Emulation.clearDeviceMetricsOverride") emulation = null;
    if (command.method === "Page.createIsolatedWorld") result = { executionContextId: 7 };
    if (command.method === "Runtime.evaluate") {
      if (
        String(command.params?.expression).includes("screenWidth:screen.width") &&
        !(viewport && typeof viewport === "object" && "screenWidth" in viewport)
      ) {
        result = {
          result: {
            value: emulation
              ? { ...emulation, screenWidth: emulation.width, screenHeight: emulation.height }
              : {
                  width: 1280,
                  height: 720,
                  screenWidth: 1920,
                  screenHeight: 1080,
                  deviceScaleFactor: 1,
                },
          },
        };
      } else if (String(command.params?.expression).startsWith("({width:innerWidth")) {
        if (viewportFailure) {
          queueMicrotask(() =>
            socket.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  id: command.id,
                  error: { code: -32000, message: viewportFailure },
                }),
              }),
            ),
          );
          return;
        }
        result = { result: { value: viewport } };
      } else result = { result: { value: "complete" } };
    }
    if (command.method === "Accessibility.getFullAXTree") result = { nodes: [] };
    if (command.method === "Page.getLayoutMetrics") {
      result = {
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: raster?.width ?? 3,
          clientHeight: raster?.height ?? 2,
        },
        cssContentSize: { x: 0, y: 0, width: 3, height: 2 },
      };
    }
    if (command.method === "Page.captureScreenshot") {
      const data = Buffer.from(jpeg, "base64");
      const presented = staleRasters.shift() ?? raster;
      if (presented) {
        const scale = Number(command.params?.clip?.scale ?? 1) * presented.density;
        data.writeUInt16BE(Math.floor(presented.height * scale), 7);
        data.writeUInt16BE(Math.floor(presented.width * scale), 9);
      }
      result = { data: data.toString("base64") };
    }
    queueMicrotask(() =>
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id: command.id, result }),
        }),
      ),
    );
  };
  socket.readyState = WebSocket.CONNECTING;
  socket.send = (raw) => {
    const command = JSON.parse(raw) as (typeof calls)[number];
    calls.push(command);
    if (viewportOn.has(command.method)) viewport = viewportOn.get(command.method);
    if (command.method === stalledMethod) {
      stalledMethod = null;
      stalled = command;
      reachedStall();
    } else {
      const delay = delays.get(command.method);
      delays.delete(command.method);
      if (delay) setTimeout(() => reply(command), delay);
      else reply(command);
    }
  };
  socket.close = () => {
    socket.readyState = WebSocket.CLOSED;
    socket.dispatchEvent(new Event("close"));
  };
  const runner: BrowserCommandRunner = {
    async run<T>(args: readonly string[]): Promise<T> {
      if (args[0] === "get") return { cdpUrl: "ws://127.0.0.1:9222/devtools/fixture" } as T;
      if (args[0] === "close") return {} as T;
      throw new Error(`unexpected command: ${args[0]}`);
    },
  };
  const driver = new AgentBrowserDriver({
    ...reference,
    engine,
    runner,
    focusEmulation: engine !== "lightpanda",
    connect: async (endpoint) =>
      await CdpConnection.connect(endpoint, {
        createWebSocket: () => {
          queueMicrotask(() => {
            socket.readyState = WebSocket.OPEN;
            socket.dispatchEvent(new Event("open"));
          });
          return socket as unknown as WebSocket;
        },
      }),
  });
  return {
    driver,
    calls,
    setRaster(value: NonNullable<typeof raster>) {
      raster = value;
    },
    presentStale(value: NonNullable<typeof raster>, captures: number) {
      for (let index = 0; index < captures; index += 1) staleRasters.push(value);
    },
    setViewport(value: unknown) {
      viewport = value;
    },
    setViewportOn(method: string, value: unknown) {
      viewportOn.set(method, value);
    },
    failViewport(message = "synthetic viewport failure") {
      viewportFailure = message;
    },
    disconnect: () => socket.close(),
    delayNext(method: string, delayMs: number) {
      delays.set(method, delayMs);
    },
    stallNext(method: string) {
      stalledMethod = method;
      waitingForStall = new Promise<void>((resolve) => {
        reachedStall = resolve;
      });
    },
    waitUntilStalled: () => waitingForStall,
    replyToStalled: () => {
      if (stalled) reply(stalled);
    },
  };
}
