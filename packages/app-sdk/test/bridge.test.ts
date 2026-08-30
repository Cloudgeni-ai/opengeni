import { describe, expect, test } from "bun:test";

import {
  OG_APP_BRIDGE_PROTOCOL,
  OgAppBridgeError,
  connectOgApp,
  createOgAppHostBridge,
  isOgJsonValue,
  type OgMessageChannel,
  type OgMessagePort,
} from "../src";

class TestPort implements OgMessagePort {
  peer: TestPort | null = null;
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(message: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) {
        listener({ data: message } as MessageEvent<unknown>);
      }
    });
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }
}

function channel(): OgMessageChannel {
  const port1 = new TestPort();
  const port2 = new TestPort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

describe("OpenGeni App bridge", () => {
  test("accepts only finite acyclic JSON values", () => {
    expect(isOgJsonValue({ safe: [1, true, null, "yes"] })).toBe(true);
    expect(isOgJsonValue({ bad: Number.NaN })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isOgJsonValue(cyclic)).toBe(false);
    let deeplyNested: unknown = null;
    for (let depth = 0; depth < 66; depth += 1) deeplyNested = [deeplyNested];
    expect(isOgJsonValue(deeplyNested)).toBe(false);
  });

  test("rejects unconfirmed capabilities before invoking the host transport", async () => {
    const testChannel = channel();
    const invoked: string[] = [];
    const responses: unknown[] = [];
    testChannel.port2.addEventListener("message", (event) => responses.push(event.data));
    const bridge = createOgAppHostBridge({
      targetWindow: {
        postMessage(message: unknown, origin: string, transfer: Transferable[]) {
          expect(message).toEqual({
            protocol: OG_APP_BRIDGE_PROTOCOL,
            kind: "connect",
            token: "0123456789abcdef",
          });
          expect(origin).toBe("https://11111111-1111-4111-8111-111111111111.apps.example.test");
          expect(transfer).toHaveLength(1);
        },
      },
      token: "0123456789abcdef",
      delivery: {
        kind: "exact_origin",
        origin: "https://11111111-1111-4111-8111-111111111111.apps.example.test",
      },
      context: {
        workspaceId: "workspace-1",
        appId: "app-1",
        launchId: "22222222-2222-4222-8222-222222222222",
        releaseId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: "a".repeat(64),
        authorityGeneration: "actor:7",
        appVersion: "1.0.0",
        grantedCapabilities: ["files.read"],
      },
      grantedCapabilities: ["files.read"],
      invoke: async (request) => {
        invoked.push(request.capability);
        return { ok: true };
      },
      channelFactory: () => testChannel,
    });

    testChannel.port2.postMessage({
      protocol: OG_APP_BRIDGE_PROTOCOL,
      kind: "request",
      id: "1",
      method: "og.capability.invoke",
      params: { capability: "files.write", operation: "writeText" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoked).toEqual([]);
    expect(responses).toContainEqual({
      protocol: OG_APP_BRIDGE_PROTOCOL,
      kind: "response",
      id: "1",
      ok: false,
      error: {
        code: "capability_not_granted",
        message: "Capability files.write was not confirmed for this run.",
      },
    });
    bridge.close();
    await expect(bridge.ready).rejects.toBeInstanceOf(OgAppBridgeError);
  });

  test("uses wildcard delivery only for an explicitly opaque sandbox", async () => {
    const testChannel = channel();
    const deliveredOrigins: string[] = [];
    const bridge = createOgAppHostBridge({
      targetWindow: {
        postMessage(_message: unknown, origin: string) {
          deliveredOrigins.push(origin);
        },
      },
      token: "0123456789abcdef",
      delivery: { kind: "opaque_sandbox" },
      context: {
        workspaceId: "workspace-1",
        appId: "app-1",
        launchId: "22222222-2222-4222-8222-222222222222",
        releaseId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: "a".repeat(64),
        authorityGeneration: "actor:7",
        appVersion: "1.0.0",
        grantedCapabilities: [],
      },
      grantedCapabilities: [],
      invoke: async () => null,
      channelFactory: () => testChannel,
    });
    expect(deliveredOrigins).toEqual(["*"]);
    bridge.close();
    await expect(bridge.ready).rejects.toBeInstanceOf(OgAppBridgeError);
  });

  test("rejects malformed exact delivery origins", () => {
    const testChannel = channel();
    expect(() =>
      createOgAppHostBridge({
        targetWindow: { postMessage() {} },
        token: "0123456789abcdef",
        delivery: { kind: "exact_origin", origin: "*" },
        context: {
          workspaceId: "workspace-1",
          appId: "app-1",
          launchId: "22222222-2222-4222-8222-222222222222",
          releaseId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: "a".repeat(64),
          authorityGeneration: "actor:7",
          appVersion: "1.0.0",
          grantedCapabilities: [],
        },
        grantedCapabilities: [],
        invoke: async () => null,
        channelFactory: () => testChannel,
      }),
    ).toThrow("exact delivery origin");
  });

  test("accepts a transferred app port only from the exact parent window", async () => {
    const parent = {} as Window;
    const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
    const appWindow = {
      parent,
      addEventListener(_type: string, next: EventListener) {
        listeners.push(next as (event: MessageEvent<unknown>) => void);
      },
      removeEventListener(_type: string, current: EventListener) {
        const index = listeners.indexOf(current as (event: MessageEvent<unknown>) => void);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    const testChannel = channel();
    const readyMessages: unknown[] = [];
    testChannel.port1.addEventListener("message", (event) => readyMessages.push(event.data));
    const connected = connectOgApp({ window: appWindow, timeoutMs: 1_000 });
    const connectMessage = {
      protocol: OG_APP_BRIDGE_PROTOCOL,
      kind: "connect",
      token: "0123456789abcdef",
    } as const;

    listeners[0]?.({
      source: {} as Window,
      data: connectMessage,
      ports: [testChannel.port2 as unknown as MessagePort],
    } as unknown as MessageEvent<unknown>);
    expect(listeners).toHaveLength(1);

    listeners[0]?.({
      source: parent,
      data: connectMessage,
      ports: [testChannel.port2 as unknown as MessagePort],
    } as unknown as MessageEvent<unknown>);
    const client = await connected;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readyMessages).toContainEqual({
      protocol: OG_APP_BRIDGE_PROTOCOL,
      kind: "ready",
      token: "0123456789abcdef",
    });
    client.close();
  });
});
