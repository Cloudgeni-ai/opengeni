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
