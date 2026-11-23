import { describe, expect, test } from "bun:test";
import type { BrowserFrameHealthValue } from "@opengeni/runtime/sandbox";
import { logStalledBrowserFrames, stalledBrowserFrames } from "../src/browser-frame-health";

type Stream = BrowserFrameHealthValue["streams"][number];
type Socket = BrowserFrameHealthValue["sockets"][number];

function stream(overrides: Partial<Stream> = {}): Stream {
  return {
    targetId: "target-1",
    subscribers: 1,
    sequence: 40,
    ageMs: 60_000,
    sinceLastFrameMs: 120,
    seeded: true,
    pollerRunning: true,
    pollerEnded: null,
    capturing: false,
    capturesRunning: 0,
    framesPaused: false,
    frontTab: true,
    unresponsiveForMs: null,
    unresponsiveMethod: null,
    consecutiveFailures: 0,
    lastFailure: null,
    sinceLastFailureMs: null,
    emptyCaptures: 0,
    ...overrides,
  };
}

function socket(overrides: Partial<Socket> = {}): Socket {
  return {
    targetId: "target-1",
    ageMs: 60_000,
    subscribed: true,
    framesSent: 40,
    sinceLastSentMs: 120,
    bufferedBytes: 0,
    ...overrides,
  };
}

function health(streams: Stream[], sockets: Socket[]): BrowserFrameHealthValue {
  return {
    browserSessionId: "browser-1",
    controllerGeneration: "generation-1",
    windowParking: {
      holders: 0,
      parkedWindows: 0,
      mayHaveParkedWindows: false,
      renderingSuspended: false,
    },
    streams,
    sockets,
  };
}

describe("browser frame stall diagnostics", () => {
  test("streams and views that are sending frames are not stalled", () => {
    expect(stalledBrowserFrames(health([stream()], [socket()]))).toBeNull();
    // A stream nobody reads is idle, not stalled.
    expect(
      stalledBrowserFrames(health([stream({ subscribers: 0, sinceLastFrameMs: 90_000 })], [])),
    ).toBeNull();
    // A view that opened moments ago has not had time for a frame yet.
    expect(
      stalledBrowserFrames(health([], [socket({ ageMs: 2_000, sinceLastSentMs: null })])),
    ).toBeNull();
  });

  test("a stream or view without a frame for ten seconds is stalled", () => {
    const stuckStream = stream({
      sinceLastFrameMs: 45_000,
      unresponsiveForMs: 44_000,
      unresponsiveMethod: "Page.captureScreenshot",
    });
    const neverSent = socket({ targetId: "target-2", sinceLastSentMs: null, framesSent: 0 });
    expect(stalledBrowserFrames(health([stuckStream, stream()], [socket(), neverSent]))).toEqual({
      streams: [stuckStream],
      sockets: [neverSent],
    });
  });

  test("logs the reason for a stall without page content", async () => {
    const logged: Array<[string, Record<string, unknown>]> = [];
    const stuck = stream({ sinceLastFrameMs: 30_000, pollerRunning: false, pollerEnded: "failed" });
    await logStalledBrowserFrames(
      { frameHealth: async () => health([stuck], [socket({ sinceLastSentMs: 30_000 })]) },
      "browser-1",
      (event, fields) => logged.push([event, fields]),
    );
    expect(logged).toHaveLength(1);
    const [event, fields] = logged[0]!;
    expect(event).toBe("browser.frame_stream.stalled");
    expect(fields).toMatchObject({
      browserSessionId: "browser-1",
      controllerGeneration: "generation-1",
      streams: [{ pollerEnded: "failed", sinceLastFrameMs: 30_000 }],
      sockets: [{ sinceLastSentMs: 30_000 }],
    });
  });

  test("logs nothing for healthy streams or a controller that does not report health", async () => {
    const logged: string[] = [];
    const log = (event: string) => logged.push(event);
    await logStalledBrowserFrames(
      { frameHealth: async () => health([stream()], [socket()]) },
      "browser-1",
      log,
    );
    await logStalledBrowserFrames(
      {
        frameHealth: async () => {
          throw new Error("not found");
        },
      },
      "browser-1",
      log,
    );
    expect(logged).toEqual([]);
  });
});
