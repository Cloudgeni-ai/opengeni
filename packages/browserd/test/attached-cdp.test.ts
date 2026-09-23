import { describe, expect, test } from "bun:test";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";

class FakeBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Record<string, unknown>> = [];
  closed = false;
  pollCount = 0;

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push({ ...payload });
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: [
            {
              id: "7",
              title: "OpenGeni",
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
        if (this.pollCount === 2) {
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
          title: "OpenGeni",
          url: "https://opengeni.ai/",
        }),
      ],
    });
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
      flatten: true,
    });
    expect(attached.sessionId).toBe("attached:7");

    const navigated = new Promise<void>((resolveEvent) => {
      connection.on(
        "Page.frameNavigated",
        (event) => {
          expect(event.sessionId).toBe("attached:7");
          expect(event.params).toEqual({ frame: { id: "main" } });
          resolveEvent();
        },
        "attached:7",
      );
    });
    await expect(
      connection.send("Page.getFrameTree", {}, { sessionId: "attached:7" }),
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
      ? "rejects a real retained-history gap"
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
        if (lost) {
          await expect(connection.send("Browser.getVersion")).rejects.toThrow(
            "history was truncated",
          );
          expect(received).toBe(0);
        } else {
          await expect(connection.send("Browser.getVersion")).resolves.toMatchObject({
            product: "Chrome/151",
          });
          expect(received).toBe(1001);
        }
      } finally {
        await connection.close();
      }
    },
  );
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
