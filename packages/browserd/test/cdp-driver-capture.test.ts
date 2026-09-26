import { expect, jest, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InteractionControllerError } from "@opengeni/interaction";
import { AgentBrowserDriver, CdpConnection, type BrowserCommandRunner } from "../src";

const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 3, 1, 1, 0x11, 0, 0xff, 0xd9,
]).toString("base64");

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

async function captureFixture() {
  const calls: Array<{ id: number; method: string; sessionId?: string }> = [];
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
  const reply = (command: { id: number; method: string; sessionId?: string }) => {
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
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 3, clientHeight: 2 },
        cssContentSize: { x: 0, y: 0, width: 3, height: 2 },
      };
    }
    if (command.method === "Page.captureScreenshot") result = { data: jpeg };
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
    browserSessionId: randomUUID(),
    controllerGeneration: "controller-capture",
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
