import { describe, expect, test } from "bun:test";
import { InteractionControllerError, InteractionDefiniteDriverError } from "@opengeni/interaction";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";
import {
  CdpCommandTimeoutError,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
} from "../src/cdp";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";

class FakeBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  closed = false;
  pollCount = 0;
  eventSent = false;

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: [
            {
              id: "7",
              title: "Opengeni",
              url: "https://opengeni.ai/",
              active: true,
              controllable: true,
            },
          ],
        } as T;
      case "debugger.attach":
        return { attached: true } as T;
      case "debugger.detach":
        return { detached: true } as T;
      case "debugger.command":
        return { result: { frameTree: { frame: { id: "main" } } } } as T;
      case "debugger.poll": {
        this.pollCount += 1;
        if (this.pollCount === 1) return { events: [], cursor: 5, truncated: false } as T;
        if (!this.commands.some((command) => command.type === "debugger.attach"))
          return { events: [], cursor: 5, truncated: false } as T;
        if (!this.eventSent) {
          this.eventSent = true;
          return {
            events: [
              {
                sequence: 6,
                tabId: "7",
                sessionId: null,
                method: "Page.frameNavigated",
                params: { frame: { id: "main" } },
              },
            ],
            cursor: 6,
            truncated: false,
          } as T;
        }
        return { events: [], cursor: 6, truncated: false } as T;
      }
      default:
        return {} as T;
    }
  }

  close(): void {
    this.closed = true;
  }
}

describe("AttachedChromeCdpConnection", () => {
  test("reports a tab's download browser-wide with the file Chrome saved", async () => {
    const commands: Array<Record<string, unknown>> = [];
    let polls = 0;
    let finds = 0;
    const bridge: AttachedBrowserBridgeTransport = {
      async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        commands.push({ ...payload });
        if (payload.type === "downloads.find") {
          finds += 1;
          // Chrome lists the download as complete a moment after reporting it,
          // beside an earlier file of the same address and another size.
          return {
            downloads:
              finds === 1
                ? []
                : [
                    { id: 3, filePath: "/Users/user/Downloads/report.pdf", sizeBytes: 9 },
                    { id: 4, filePath: "/Users/user/Downloads/report (1).pdf", sizeBytes: 5 },
                  ],
          } as T;
        }
        if (payload.type !== "debugger.poll") return {} as T;
        polls += 1;
        if (polls === 1) return { events: [], cursor: 0, truncated: false } as T;
        if (polls === 2) {
          const event = (sequence: number, method: string, params: Record<string, unknown>) => ({
            sequence,
            tabId: "7",
            sessionId: null,
            method,
            params,
          });
          return {
            events: [
              event(1, "Page.downloadWillBegin", {
                frameId: "main",
                guid: "guid-1",
                url: "https://example.test/report",
                suggestedFilename: "report.pdf",
              }),
              event(2, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "inProgress",
              }),
              event(3, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "completed",
              }),
              // A repeated completion cannot settle it twice.
              event(4, "Page.downloadProgress", {
                guid: "guid-1",
                totalBytes: 5,
                receivedBytes: 5,
                state: "completed",
              }),
            ],
            cursor: 4,
            truncated: false,
          } as T;
        }
        return { events: [], cursor: 4, truncated: false } as T;
      },
      close() {},
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    const began: Array<Record<string, unknown>> = [];
    const progress: Array<Record<string, unknown>> = [];
    connection.on("Browser.downloadWillBegin", (event) => began.push(event.params));
    connection.on("Browser.downloadProgress", (event) => progress.push(event.params));
    const deadline = Date.now() + 5_000;
    while (!progress.some((event) => event.state === "completed") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 300));
    connection.close();

    expect(began).toEqual([
      expect.objectContaining({ guid: "guid-1", suggestedFilename: "report.pdf" }),
    ]);
    expect(progress.map((event) => event.state)).toEqual(["inProgress", "completed"]);
    expect(progress[1]).toMatchObject({
      guid: "guid-1",
      receivedBytes: 5,
      filePath: "/Users/user/Downloads/report (1).pdf",
    });
    const find = commands.find((command) => command.type === "downloads.find")!;
    expect(find.url).toBe("https://example.test/report");
    expect(Date.parse(String(find.startedAfter))).toBeLessThanOrEqual(Date.now());
    expect(finds).toBe(2);
  });

  test("reports a download without a path when the extension cannot find files", async () => {
    let polls = 0;
    const bridge: AttachedBrowserBridgeTransport = {
      async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
        if (payload.type === "downloads.find") {
          throw new AttachedBrowserBridgeError(
            "bridge_failed",
            "bridge command type is unsupported",
            false,
          );
        }
        if (payload.type !== "debugger.poll") return {} as T;
        polls += 1;
        if (polls !== 2) return { events: [], cursor: polls > 2 ? 2 : 0, truncated: false } as T;
        return {
          events: [
            {
              sequence: 1,
              tabId: "7",
              sessionId: null,
              method: "Page.downloadWillBegin",
              params: { frameId: "main", guid: "guid-2", url: "https://example.test/a" },
            },
            {
              sequence: 2,
              tabId: "7",
              sessionId: null,
              method: "Page.downloadProgress",
              params: { guid: "guid-2", totalBytes: 1, receivedBytes: 1, state: "completed" },
            },
          ],
          cursor: 2,
          truncated: false,
        } as T;
      },
      close() {},
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    const completed = await connection.waitForEvent("Browser.downloadProgress", {
      timeoutMs: 5_000,
    });
    connection.close();
    expect(completed.params).toEqual({
      guid: "guid-2",
      totalBytes: 1,
      receivedBytes: 1,
      state: "completed",
    });
  });

  test("reports Chrome's protocol refusals as definite CDP errors that keep the tab", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      const request = bridge.request.bind(bridge);
      let message = '{"code":-32000,"message":"Not allowed"}';
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError("driver_rejected", message, false);
        return request(payload);
      };
      const refused = await connection
        .send("DOM.setFileInputFiles", { files: ["/tmp/a"], backendNodeId: 1 }, { sessionId })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CdpProtocolError);
      expect(refused).toMatchObject({ code: -32_000, message: "Not allowed" });
      bridge.request = request;
      // A refused command left nothing in flight, so the tab can be attached again.
      const again = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError("driver_rejected", message, false);
        return request(payload);
      };
      message = "Chrome command failed";
      const opaque = await connection
        .send("Input.dispatchMouseEvent", {}, { sessionId: again.sessionId })
        .catch((error: unknown) => error);
      expect(opaque).toMatchObject({ code: -32_000, message: "Chrome command failed" });
      bridge.request = request;
      // An unexplained failure of input may still arrive later.
      await expect(
        connection.send("Target.attachToTarget", { targetId: "7", flatten: true }),
      ).rejects.toThrow("disconnected during input");
    } finally {
      connection.close();
    }
  });

  test("flushes events Chrome sent before a command reply to listeners", async () => {
    // Chrome sends the navigation a click starts before it answers the next
    // command, but here events reach browserd only when it polls for them.
    const events: Array<Record<string, unknown>> = [];
    const bridge = new FakeBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = async <T>(payload: Readonly<Record<string, unknown>>): Promise<T> => {
      if (payload.type === "debugger.command") {
        events.push({
          sequence: events.length + 1,
          tabId: "7",
          sessionId: null,
          method: "Page.frameRequestedNavigation",
          params: { frameId: "main", disposition: "currentTab" },
        });
        return { result: {} } as T;
      }
      if (payload.type === "debugger.poll") {
        const after = payload.afterSequence as number;
        const available = events.filter((event) => (event.sequence as number) > after);
        // Polls are slow, so a reply alone never shows the events before it.
        if (available.length > 0) await new Promise((resolve) => setTimeout(resolve, 30));
        return { events: available, cursor: events.length, truncated: false } as T;
      }
      return request(payload);
    };
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      let seen = 0;
      connection.on("Page.frameRequestedNavigation", () => (seen += 1), sessionId);
      for (let round = 1; round <= 3; round += 1) {
        await connection.send("Input.dispatchMouseEvent", {}, { sessionId });
        expect(seen).toBe(round - 1);
        await connection.flushEvents();
        expect(seen).toBe(round);
      }
    } finally {
      connection.close();
    }
  });

  test("keeps target command timeouts distinct from lost bridge transport", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
        flatten: true,
      });
      const request = bridge.request.bind(bridge);
      let code: "timeout" | "transport_failed" = "timeout";
      bridge.request = async (payload) => {
        if (payload.type === "debugger.command")
          throw new AttachedBrowserBridgeError(code, "synthetic bridge failure", true);
        return request(payload);
      };
      await expect(connection.send("Runtime.evaluate", {}, { sessionId })).rejects.toBeInstanceOf(
        CdpCommandTimeoutError,
      );
      await expect(connection.send("Page.getFrameTree", {}, { sessionId })).rejects.toMatchObject({
        method: "Page.getFrameTree",
        sessionId,
      });
      code = "transport_failed";
      const lost = await connection
        .send("Page.getFrameTree", {}, { sessionId })
        .catch((error: unknown) => error);
      expect(lost).toBeInstanceOf(CdpTransportError);
      expect(lost).not.toBeInstanceOf(CdpCommandTimeoutError);
    } finally {
      connection.close();
    }
  });

  test.each([
    ["darwin", "Macintosh"],
    ["win32", "Windows NT"],
    ["linux", "Linux"],
  ] as const)("retains %s keyboard platform in browser metadata", async (platform, marker) => {
    const connection = new AttachedChromeCdpConnection(new FakeBridge(), {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
      platform,
    });
    try {
      const version = await connection.send<{ userAgent: string }>("Browser.getVersion");
      expect(version.userAgent).toContain(marker);
      expect(/Macintosh|Mac OS/u.test(version.userAgent)).toBe(platform === "darwin");
    } finally {
      connection.close();
    }
  });

  test("virtualizes browser targets and tunnels target-scoped CDP with events", async () => {
    const bridge = new FakeBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });

    await expect(connection.send("Browser.getVersion")).resolves.toMatchObject({
      product: "Chrome/151.0.0.0",
    });
    await expect(connection.send("Target.getTargets")).resolves.toEqual({
      targetInfos: [
        expect.objectContaining({
          targetId: "7",
          type: "page",
          title: "Opengeni",
          url: "https://opengeni.ai/",
        }),
      ],
    });
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
      flatten: true,
    });
    expect(attached.sessionId).toStartWith("attached:7:");

    const navigated = new Promise<void>((resolveEvent) => {
      connection.on(
        "Page.frameNavigated",
        (event) => {
          expect(event.sessionId).toBe(attached.sessionId);
          expect(event.params).toEqual({ frame: { id: "main" } });
          resolveEvent();
        },
        attached.sessionId,
      );
    });
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: attached.sessionId }),
    ).resolves.toEqual({ frameTree: { frame: { id: "main" } } });
    await navigated;
    expect(bridge.commands).toContainEqual(
      expect.objectContaining({
        type: "debugger.command",
        tabId: "7",
        method: "Page.getFrameTree",
      }),
    );

    await connection.shutdown();
    expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    expect(bridge.closed).toBe(true);
  });
});

for (const lost of [false, true]) {
  test(
    lost
      ? "discards a real retained-history gap and keeps the connection usable"
      : "drains legacy paginated event bursts without declaring history loss",
    async () => {
      const start = lost ? 2 : 1;
      const events = Array.from({ length: 1001 }, (_, index) => ({
        sequence: start + index,
        tabId: "7",
        sessionId: null,
        method: "Network.loadingFinished",
        params: {},
      }));
      let polls = 0;
      let received = 0;
      const bridge: AttachedBrowserBridgeTransport = {
        close() {},
        async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
          if (polls++ === 0) return { events: [], cursor: 0, truncated: false } as T;
          const available = events.filter(
            (event) => event.sequence > (payload.afterSequence as number),
          );
          const page = available.slice(0, payload.limit as number);
          return {
            events: page,
            cursor: page.at(-1)?.sequence ?? events.at(-1)!.sequence,
            truncated:
              (payload.afterSequence as number) < start - 1 || available.length > page.length,
          } as T;
        },
      };
      const connection = new AttachedChromeCdpConnection(bridge, {
        browserName: "Chrome",
        browserVersion: "151",
      });
      connection.on("Network.loadingFinished", () => {
        received += 1;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await expect(connection.send("Browser.getVersion")).resolves.toMatchObject({
          product: "Chrome/151",
        });
        expect(received).toBe(lost ? 0 : 1001);
      } finally {
        await connection.close();
      }
    },
  );
}

type StreamEvent = {
  sequence: number;
  tabId: string;
  sessionId: null;
  method: string;
  params: Record<string, unknown>;
};

/** An extension event buffer whose history can be lost and whose polls can fail. */
class StreamBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  events: StreamEvent[] = [];
  sequence = 0;
  failingPolls = 0;
  pollFailure: Error = new AttachedBrowserBridgeError("timeout", "poll timed out", true);
  heldInput: Promise<void> | null = null;
  heldNavigation: Promise<void> | null = null;
  heldAttach: Promise<void> | null = null;

  push(method: string, params: Record<string, unknown> = {}): void {
    this.sequence += 1;
    this.events.push({ sequence: this.sequence, tabId: "7", sessionId: null, method, params });
  }

  /** Chrome emitted more events than the extension retains. */
  overflow(): void {
    this.push("Network.requestWillBeSent");
    this.push("OpenGeni.debuggerDetached", { reason: "target_closed" });
    this.push("Page.frameNavigated", { frame: { id: "lost" } });
    this.events = this.events.slice(-1);
  }

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: [
            {
              id: "7",
              title: "Tab",
              url: "https://example.com/",
              active: true,
              controllable: true,
            },
          ],
        } as T;
      case "debugger.attach":
        if (this.heldAttach) await this.heldAttach;
        return { attached: true } as T;
      case "debugger.detach":
        return { detached: true } as T;
      case "debugger.command":
        if (payload.method === "Input.dispatchMouseEvent" && this.heldInput) await this.heldInput;
        if (payload.method === "Page.navigate" && this.heldNavigation) {
          await this.heldNavigation;
          throw new AttachedBrowserBridgeError("bridge_failed", "navigation reply lost", true);
        }
        return { result: {} } as T;
      case "debugger.poll": {
        if (this.failingPolls > 0) {
          this.failingPolls -= 1;
          throw this.pollFailure;
        }
        const after = payload.afterSequence as number;
        const first = this.events[0]?.sequence ?? this.sequence + 1;
        const page = this.events
          .filter((event) => event.sequence > after)
          .slice(0, payload.limit as number);
        return {
          events: page,
          cursor: page.at(-1)?.sequence ?? this.sequence,
          truncated: this.events.length > 0 && after < first - 1,
        } as T;
      }
      default:
        return {} as T;
    }
  }

  close(): void {}
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("attached Chrome event stream recovery", () => {
  test("treats tabs as detached after lost history, then re-attaches and delivers events", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      const first = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const detached: Array<Record<string, unknown>> = [];
      connection.on("Target.detachedFromTarget", (event) => detached.push(event.params));
      bridge.overflow();
      await eventually(() => detached.length > 0, "the resynchronized detach");
      expect(detached).toEqual([
        { sessionId: first.sessionId, targetId: "7", reason: "event_stream_resynchronized" },
      ]);
      // The lost detach and navigation are not replayed as if they were seen.
      expect(detached).toHaveLength(1);
      await expect(
        connection.send("Page.getFrameTree", {}, { sessionId: first.sessionId }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: true });

      await eventually(
        () => bridge.commands.filter((command) => command.type === "debugger.poll").length > 4,
        "polling to resume",
      );
      const second = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      expect(second.sessionId).not.toBe(first.sessionId);
      const navigated = new Promise<Record<string, unknown>>((resolveEvent) => {
        connection.on(
          "Page.frameNavigated",
          (event) => resolveEvent(event.params),
          second.sessionId,
        );
      });
      bridge.push("Page.frameNavigated", { frame: { id: "fresh" } });
      await expect(navigated).resolves.toEqual({ frame: { id: "fresh" } });
      await expect(connection.send("Target.getTargets")).resolves.toMatchObject({
        targetInfos: [expect.objectContaining({ targetId: "7", attached: true })],
      });
      // Chrome's attachment was never dropped, so only shutdown detaches it.
      expect(bridge.commands.some((command) => command.type === "debugger.detach")).toBe(false);
      await connection.shutdown();
      expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    } finally {
      connection.close();
    }
  });

  test("recovers from failed polls instead of failing every later call", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.failingPolls = 3;
      await detached;
      await expect(connection.send("Target.getTargets")).resolves.toMatchObject({
        targetInfos: [expect.objectContaining({ targetId: "7" })],
      });
      await eventually(() => bridge.failingPolls === 0, "the failed polls");
      const attached = await eventuallyAttach(connection);
      expect(attached).not.toBe(sessionId);
      const seen = new Promise<void>((resolveEvent) => {
        connection.on("Page.loadEventFired", () => resolveEvent(), attached);
      });
      bridge.push("Page.loadEventFired");
      await seen;
    } finally {
      connection.close();
    }
  });

  test("tells the agent to open a new session when the profile reconnected", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    try {
      await connection.send("Target.attachToTarget", { targetId: "7" });
      bridge.pollFailure = new AttachedBrowserBridgeError(
        "fenced",
        "attached browser connection changed",
        true,
      );
      bridge.failingPolls = Number.POSITIVE_INFINITY;
      await eventually(
        () => bridge.commands.filter((command) => command.type === "debugger.poll").length > 2,
        "the fenced poll",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failure = await connection.send("Target.getTargets").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InteractionControllerError);
      expect(failure).toMatchObject({ code: "resource_unavailable", retryable: false });
      expect((failure as Error).message).toContain("open a new browser session");
    } finally {
      connection.close();
    }
  });

  test("keeps a tab with input in flight uncertain across a resynchronization", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseInput = () => {};
    bridge.heldInput = new Promise<void>((resolveInput) => {
      releaseInput = resolveInput;
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const click = connection
        .send("Input.dispatchMouseEvent", { type: "mousePressed" }, { sessionId })
        .catch((error: unknown) => error);
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.overflow();
      await detached;
      releaseInput();
      await click;
      await eventually(
        () => bridge.commands.filter((command) => command.type === "debugger.poll").length > 4,
        "polling to resume",
      );
      await expect(
        connection.send("Target.attachToTarget", { targetId: "7" }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: false });
    } finally {
      releaseInput();
      connection.close();
    }
  });

  test("refuses an attach that spans a stream break but still detaches it at shutdown", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseAttach = () => {};
    try {
      await connection.send("Target.getTargets");
      connection.on("Page.loadEventFired", () => undefined);
      await eventually(
        () => bridge.commands.some((command) => command.type === "debugger.poll"),
        "polling to start",
      );
      bridge.heldAttach = new Promise<void>((resolveAttach) => {
        releaseAttach = resolveAttach;
      });
      const attach = connection
        .send("Target.attachToTarget", { targetId: "7" })
        .catch((error: unknown) => error);
      await eventually(
        () => bridge.commands.some((command) => command.type === "debugger.attach"),
        "the attach request",
      );
      bridge.failingPolls = 1;
      await eventually(() => bridge.failingPolls === 0, "the stream break");
      releaseAttach();
      expect(await attach).toMatchObject({ code: "resource_unavailable", retryable: true });
      await connection.shutdown();
      expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
    } finally {
      releaseAttach();
      connection.close();
    }
  });

  test("does not mistake a resynchronization for Chrome refusing a navigation", async () => {
    const bridge = new StreamBridge();
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151",
    });
    let releaseNavigation = () => {};
    bridge.heldNavigation = new Promise<void>((resolveNavigation) => {
      releaseNavigation = resolveNavigation;
    });
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      const navigation = connection
        .send("Page.navigate", { url: "https://example.com/next" }, { sessionId })
        .catch((error: unknown) => error);
      const detached = new Promise<void>((resolveEvent) => {
        connection.on("Target.detachedFromTarget", () => resolveEvent());
      });
      bridge.overflow();
      await detached;
      releaseNavigation();
      const failure = await navigation;
      // The navigation may have run: its outcome is unknown, not a refusal.
      expect(failure).not.toBeInstanceOf(InteractionDefiniteDriverError);
      expect(failure).toBeInstanceOf(CdpSessionDetachedError);
    } finally {
      releaseNavigation();
      connection.close();
    }
  });
});

/** Attaching is refused (retryably) while the stream is still recovering. */
async function eventuallyAttach(connection: AttachedChromeCdpConnection): Promise<string> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: "7",
      });
      return sessionId;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("CDP target lifecycle still detaches Chrome debugging when the driver closes", async () => {
  const { AttachedChromeRunner } = await import("../src/attached-cdp");
  const { AgentBrowserDriver } = await import("../src/cdp-driver");
  const bridge = new FakeBridge();
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151",
  });
  await connection.send("Target.attachToTarget", { targetId: "7" });
  const driver = new AgentBrowserDriver({
    browserSessionId: crypto.randomUUID(),
    controllerGeneration: "test",
    targetLifecycle: "cdp",
    runner: new AttachedChromeRunner(bridge, connection),
    connect: async () => connection,
  });
  await driver.close();
  expect(bridge.commands).toContainEqual({ type: "debugger.detach", tabId: "7" });
  expect(bridge.closed).toBe(true);
});
