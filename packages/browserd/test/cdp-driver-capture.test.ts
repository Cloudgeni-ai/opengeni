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

test("the supervisor preserves target authority when a failed capture has a slow liveness probe", async () => {
  const reference = { browserSessionId: randomUUID(), controllerGeneration: randomUUID() };
  const fixture = await captureFixture(reference);
  const directory = await mkdtemp("/tmp/ogb-capture-probe-");
  let driverLifecycles = 0;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: join(directory, "s"),
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

test("a stalled screenshot releases target and foreground queues for healthy reads", async () => {
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
      1,
    );
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
    expect(await otherTarget).toMatchObject({ targetId: "target-2", width: 3, height: 2 });
    expect(fixture.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(
      3,
    );
    expect(fixture.calls.filter((call) => call.method === "Target.activateTarget")).toHaveLength(3);
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
    if (command.method === "Runtime.evaluate") result = { result: { value: "complete" } };
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
      if (raster) {
        const scale = Number(command.params?.clip.scale ?? 1) * raster.density;
        data.writeUInt16BE(Math.floor(raster.height * scale), 7);
        data.writeUInt16BE(Math.floor(raster.width * scale), 9);
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
    foregroundManagedTabs: true,
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
