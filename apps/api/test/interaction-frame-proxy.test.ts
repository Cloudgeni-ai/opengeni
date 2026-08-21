import { afterEach, describe, expect, test } from "bun:test";
import type {
  ApiWebSocketConnection,
  ApiWebSocketLike,
  ApiWebSocketUpgradeServer,
} from "../src/api-websocket";
import {
  createInteractionFrameProxyAttachment,
  InteractionFrameProxyTransport,
  placementUsesInteractionFrameProxy,
} from "../src/interaction-frame-proxy";

const rootSecret = "test-root-secret-with-enough-entropy-for-proxy-tests";
const publicOrigin = "https://opengeni.example";
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("interaction frame proxy", () => {
  test("proxies Docker and unsigned OpenSandbox, not native or signed tunnels", () => {
    expect(placementUsesInteractionFrameProxy("docker")).toBe(true);
    expect(placementUsesInteractionFrameProxy("opensandbox")).toBe(true);
    expect(
      placementUsesInteractionFrameProxy("opensandbox", { openSandboxSignedEndpoints: true }),
    ).toBe(false);
    expect(
      placementUsesInteractionFrameProxy("opensandbox", {
        openSandboxSignedEndpoints: true,
        openSandboxInteractionFrameProxy: true,
      }),
    ).toBe(true);
    expect(placementUsesInteractionFrameProxy("modal")).toBe(false);
    expect(placementUsesInteractionFrameProxy("blaxel")).toBe(false);
    expect(placementUsesInteractionFrameProxy(null)).toBe(false);
  });

  test("collapses computer RFB grants to the two viewer protocols the proxy exposes", () => {
    const attachment = createInteractionFrameProxyAttachment({
      requestUrl: `${publicOrigin}/v1/workspaces/workspace/computer-sessions/session/attachments`,
      rootSecret,
      upstreamUrl: "ws://127.0.0.1:18090/v1/sandboxes/box/proxy/7682/v1/computer-sessions/cs/targets/screen%3A0/rfb",
      upstreamProtocols: [
        "binary",
        "opengeni.computer.rfb.v1",
        "opengeni.auth.super-secret-view-grant",
      ],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(attachment.protocols).toHaveLength(2);
    expect(attachment.protocols[0]).toBe("binary");
    expect(attachment.protocols[1]?.startsWith("opengeni-frame-proxy.")).toBe(true);
    expect(JSON.stringify(attachment)).not.toContain("opengeni.computer.rfb.v1");
    expect(JSON.stringify(attachment)).not.toContain("opengeni.auth.super-secret-view-grant");
  });

  test("hides and relays a Docker-only controller URL through the public API", async () => {
    let upstreamOrigin: string | null = null;
    const upstream = Bun.serve<{ kind: "upstream" }>({
      port: 0,
      fetch(request, server) {
        upstreamOrigin = request.headers.get("origin");
        const upgraded = server.upgrade(request, {
          data: { kind: "upstream" },
          headers: { "sec-websocket-protocol": "binary" },
        });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    servers.push(upstream);
    const internalUrl = `ws://127.0.0.1:${upstream.port}/frames`;
    const attachment = createInteractionFrameProxyAttachment({
      requestUrl: `${publicOrigin}/v1/workspaces/workspace/attachments`,
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(attachment.url).toBe("wss://opengeni.example/v1/interaction/frame-proxy");
    expect(JSON.stringify(attachment)).not.toContain(internalUrl);
    expect(JSON.stringify(attachment)).not.toContain("secret-view-grant");

    const behindTlsTerminator = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      publicBaseUrl: publicOrigin,
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: publicOrigin,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(behindTlsTerminator.url).toBe("wss://opengeni.example/v1/interaction/frame-proxy");

    const webBaseHttps = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      webBaseUrl: "https://console.example",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "https://console.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(webBaseHttps.url).toBe("wss://console.example/v1/interaction/frame-proxy");

    const forwardedHttps = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      forwardedProto: "https, http",
      forwardedHost: "console.example",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "https://console.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(forwardedHttps.url).toBe("wss://console.example/v1/interaction/frame-proxy");

    const localHttp = createInteractionFrameProxyAttachment({
      requestUrl: "http://127.0.0.1:8000/v1/workspaces/workspace/attachments",
      rootSecret,
      upstreamUrl: internalUrl,
      upstreamProtocols: ["binary", "secret-view-grant"],
      origin: "http://127.0.0.1:3000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(localHttp.url).toBe("ws://127.0.0.1:8000/v1/interaction/frame-proxy");

    let connection: ApiWebSocketConnection | null = null;
    const upgradeServer: ApiWebSocketUpgradeServer = {
      upgrade(_request, options) {
        connection = options.data;
        expect(new Headers(options.headers).get("sec-websocket-protocol")).toBe("binary");
        return true;
      },
    };
    const request = proxyRequest(attachment, publicOrigin);
    expect(new InteractionFrameProxyTransport(rootSecret).upgrade(request, upgradeServer)).toBe(
      undefined,
    );
    expect(connection).not.toBeNull();

    const socket = new TestSocket(connection!);
    connection!.attach(socket);
    connection!.receive(Uint8Array.of(1, 3, 3, 7));
    await eventually(() => socket.messages.length === 1);
    expect([...socket.messages[0]!]).toEqual([1, 3, 3, 7]);
    expect(upstreamOrigin).toBe(publicOrigin);
    connection!.transportClosed();
  });

  test("rejects another browser origin", () => {
    const attachment = attachmentExpiringIn(60_000);
    const response = new InteractionFrameProxyTransport(rootSecret).upgrade(
      proxyRequest(attachment, "https://evil.example"),
      rejectingUpgradeServer(),
    );
    expect(response?.status).toBe(403);
  });

  test("rejects expired and tampered grants", () => {
    const expired = attachmentExpiringIn(-1_000);
    expect(
      new InteractionFrameProxyTransport(rootSecret).upgrade(
        proxyRequest(expired, publicOrigin),
        rejectingUpgradeServer(),
      )?.status,
    ).toBe(401);

    const current = attachmentExpiringIn(60_000);
    const tampered = {
      ...current,
      protocols: [current.protocols[0]!, `${current.protocols[1]!}x`],
    };
    expect(
      new InteractionFrameProxyTransport(rootSecret).upgrade(
        proxyRequest(tampered, publicOrigin),
        rejectingUpgradeServer(),
      )?.status,
    ).toBe(401);
  });
});

class TestSocket implements ApiWebSocketLike {
  readonly messages: Uint8Array[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(readonly data: ApiWebSocketConnection) {}

  send(data: Uint8Array): number {
    this.messages.push(Uint8Array.from(data));
    return data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
}

function attachmentExpiringIn(milliseconds: number) {
  return createInteractionFrameProxyAttachment({
    requestUrl: `${publicOrigin}/v1/workspaces/workspace/attachments`,
    rootSecret,
    upstreamUrl: "ws://browser-sandbox:7682/frames",
    upstreamProtocols: ["opengeni-browser-v1", "secret-view-grant"],
    origin: publicOrigin,
    expiresAt: new Date(Date.now() + milliseconds).toISOString(),
  });
}

function proxyRequest(
  attachment: ReturnType<typeof createInteractionFrameProxyAttachment>,
  origin: string,
): Request {
  return new Request(attachment.url, {
    headers: {
      origin,
      "sec-websocket-protocol": attachment.protocols.join(", "),
    },
  });
}

function rejectingUpgradeServer(): ApiWebSocketUpgradeServer {
  return {
    upgrade() {
      throw new Error("unexpected upgrade");
    },
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met");
    await Bun.sleep(10);
  }
}
