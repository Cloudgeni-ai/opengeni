import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { connect } from "node:net";
import {
  SANDBOX_BRIDGE_HEALTH_PATH,
  canListenOn,
  createSandboxBridgeServer,
  dockerBridgeRouteCandidates,
  ipv4InSubnet,
  normalizePeerAddress,
  resolveDockerBridgeRoute,
  sandboxBridgeRouteAllowed,
} from "./dev-sandbox-bridge";

const brokerRoute = `/v1/git/personal/${"a".repeat(43)}`;

describe("Docker sandbox route selection", () => {
  test("relays only the routes a sandbox calls", () => {
    for (const path of [
      "/v1/workspaces/ws-1/codemode",
      "/v1/workspaces/ws-1/codemode/calls",
      "/v1/workspaces/ws-1/codemode/calls/op-1",
      "/v1/workspaces/ws-1/codemode/sdk/v1/sessions",
      "/v1/workspaces/ws-1/mcp",
      "/v1/workspaces/ws-1/mcp/docs",
      "/v1/workspaces/ws-1/mcp/files",
      `${brokerRoute}/info/refs`,
      `${brokerRoute}/git-upload-pack`,
      `${brokerRoute}/git-receive-pack`,
    ]) {
      expect(sandboxBridgeRouteAllowed(path)).toBe(true);
    }
    for (const path of [
      "/",
      "/healthz",
      "/v1/workspaces",
      "/v1/workspaces/ws-1/sessions",
      "/v1/workspaces/ws-1/codemodes",
      "/v1/workspaces/ws-1/mcpx",
      "/v1/workspaces//codemode",
      "/v1/git/personal/short/info/refs",
      `${brokerRoute}/objects/info/packs`,
      "/v1/auth/session",
    ]) {
      expect(sandboxBridgeRouteAllowed(path)).toBe(false);
    }
  });

  test("matches IPv4 subnets and unwraps mapped peers", () => {
    expect(ipv4InSubnet("172.18.0.5", "172.18.0.0/16")).toBe(true);
    expect(ipv4InSubnet("172.18.255.254", "172.18.0.0/16")).toBe(true);
    expect(ipv4InSubnet("172.19.0.5", "172.18.0.0/16")).toBe(false);
    expect(ipv4InSubnet("192.168.1.20", "172.18.0.0/16")).toBe(false);
    expect(ipv4InSubnet("10.0.0.1", "0.0.0.0/0")).toBe(true);
    expect(ipv4InSubnet("172.18.0.5", "172.18.0.5/32")).toBe(true);
    expect(ipv4InSubnet("172.18.0.5", "172.18.0.0/33")).toBe(false);
    expect(ipv4InSubnet("::1", "172.18.0.0/16")).toBe(false);
    expect(normalizePeerAddress("::ffff:172.18.0.5")).toBe("172.18.0.5");
    expect(normalizePeerAddress("172.18.0.5")).toBe("172.18.0.5");
    expect(normalizePeerAddress("::1")).toBeNull();
    expect(normalizePeerAddress(undefined)).toBeNull();
  });

  test("reads IPv4 gateway routes from docker network inspect", () => {
    expect(
      dockerBridgeRouteCandidates([
        { Subnet: "fd00:dead:beef::/48", Gateway: "fd00:dead:beef::1" },
        { Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" },
      ]),
    ).toEqual([{ gateway: "172.18.0.1", subnet: "172.18.0.0/16" }]);
    // A gateway outside its own subnet is not a bridge route.
    expect(dockerBridgeRouteCandidates([{ Subnet: "172.18.0.0/16", Gateway: "10.0.0.1" }])).toEqual(
      [],
    );
    expect(dockerBridgeRouteCandidates(null)).toEqual([]);
    expect(dockerBridgeRouteCandidates([{}])).toEqual([]);
  });

  test("publishes only a gateway this host can listen on", async () => {
    const inspected: string[] = [];
    const inspect = (network: string) => {
      inspected.push(network);
      return '[{"Subnet":"172.20.0.0/16","Gateway":"172.20.0.1"}]\n';
    };
    // Linux Docker Engine: the gateway is the host's br-<id> interface address.
    expect(
      await resolveDockerBridgeRoute("opengeni-main_default", {
        inspect,
        isHostAddress: async (address) => address === "172.20.0.1",
      }),
    ).toEqual({ route: { gateway: "172.20.0.1", subnet: "172.20.0.0/16" } });
    expect(inspected).toEqual(["opengeni-main_default"]);
    // Docker Desktop and rootless Docker keep the gateway in a VM or namespace.
    const desktop = await resolveDockerBridgeRoute("opengeni-main_default", {
      inspect,
      isHostAddress: async () => false,
    });
    expect("reason" in desktop && desktop.reason).toContain("Docker Desktop or rootless Docker");
    expect(
      await resolveDockerBridgeRoute("missing", {
        inspect: () => {
          throw new Error("No such network");
        },
        isHostAddress: async () => true,
      }),
    ).toEqual({ reason: "could not inspect Docker network missing" });
  });

  test("probes host addresses by listening on them", async () => {
    expect(await canListenOn("127.0.0.1")).toBe(true);
    // TEST-NET-1 is never assigned to a host interface.
    expect(await canListenOn("192.0.2.1")).toBe(false);
  });
});

describe("Docker sandbox route forwarder", () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  async function startBridge(subnet: string, handler?: (request: Request) => Promise<Response>) {
    const seen: Array<{ host: string | null; path: string; body: string }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      async fetch(request) {
        if (handler) return await handler(request);
        const url = new URL(request.url);
        const body = await request.text();
        seen.push({
          host: request.headers.get("host"),
          path: `${url.pathname}${url.search}`,
          body,
        });
        return Response.json({ ok: true }, { headers: { "x-upstream": "api" } });
      },
    });
    const bridge: Server = createSandboxBridgeServer({
      subnet,
      apiOrigin: `http://127.0.0.1:${upstream.port}`,
    });
    await new Promise<void>((resolve) => bridge.listen({ host: "127.0.0.1", port: 0 }, resolve));
    servers.push({
      stop: () => {
        bridge.close();
        upstream.stop(true);
      },
    });
    const port = (bridge.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, port, seen };
  }

  async function rawRequest(port: number, target: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: 172.18.0.1:${port}\r\nConnection: close\r\n\r\n`,
        );
      });
      let response = "";
      socket.on("data", (chunk) => (response += chunk.toString()));
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
  }

  test("relays sandbox routes with their Host and body, and refuses the rest", async () => {
    const { base, port, seen } = await startBridge("127.0.0.0/8");
    const call = await fetch(`${base}/v1/workspaces/ws-1/codemode/calls?wait=1`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `172.18.0.1:${port}` },
      body: '{"path":["slack","search"]}',
    });
    expect(call.status).toBe(200);
    expect(call.headers.get("x-upstream")).toBe("api");
    expect(seen).toEqual([
      {
        host: `172.18.0.1:${port}`,
        path: "/v1/workspaces/ws-1/codemode/calls?wait=1",
        body: '{"path":["slack","search"]}',
      },
    ]);

    const denied = await fetch(`${base}/v1/workspaces/ws-1/sessions`, { method: "POST" });
    expect(denied.status).toBe(404);
    // Dot segments are resolved before the allowlist sees the path.
    const traversal = await rawRequest(port, "/v1/workspaces/ws-1/codemode/../../../v1/sessions");
    expect(traversal).toStartWith("HTTP/1.1 404");
    expect(seen).toHaveLength(1);

    const health = await fetch(`${base}${SANDBOX_BRIDGE_HEALTH_PATH}`);
    expect(await health.json()).toEqual({ ok: true });
  });

  test("refuses peers outside the sandbox network", async () => {
    const { base, seen } = await startBridge("172.18.0.0/16");
    const response = await fetch(`${base}/v1/workspaces/ws-1/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  // Bun 1.3's node:http could stall or drop bytes relaying bodies this large;
  // the pinned runtime (.bun-version) relays them intact.
  test("streams multi-megabyte Git broker uploads through intact", async () => {
    const received: Array<{ bytes: number; digest: string; expect: string | null }> = [];
    const { base } = await startBridge("127.0.0.0/8", async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      received.push({
        bytes: body.byteLength,
        digest: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        expect: request.headers.get("expect"),
      });
      return new Response("ok");
    });
    const packfile = new Uint8Array(12 * 1024 * 1024);
    for (let index = 0; index < packfile.length; index += 4096) packfile[index] = index % 251;
    const digest = new Bun.CryptoHasher("sha256").update(packfile).digest("hex");
    const target = `${base}${brokerRoute}/git-receive-pack`;

    // A sized body, as `git push` sends for a small pack.
    const sized = await fetch(target, { method: "POST", body: packfile });
    expect(sized.status).toBe(200);
    expect(await sized.text()).toBe("ok");

    // A chunked body without a length, as `git push` streams a large pack.
    const chunks = 12;
    const chunkSize = packfile.length / chunks;
    let sent = 0;
    const streamed = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === chunks) {
            controller.close();
            return;
          }
          controller.enqueue(packfile.slice(sent * chunkSize, (sent + 1) * chunkSize));
          sent += 1;
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(200);
    expect(await streamed.text()).toBe("ok");

    expect(received).toEqual([
      { bytes: packfile.length, digest, expect: null },
      { bytes: packfile.length, digest, expect: null },
    ]);
  }, 60_000);

  test("streams responses without buffering them", async () => {
    let releaseSecondEvent: () => void = () => {};
    const secondEventReleased = new Promise<void>((resolve) => {
      releaseSecondEvent = resolve;
    });
    const { base } = await startBridge("127.0.0.0/8", async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("event: first\ndata: 1\n\n"));
            // The second event waits for the client to have read the first,
            // so a forwarder that buffered the response would never finish.
            await secondEventReleased;
            controller.enqueue(encoder.encode("event: second\ndata: 2\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const response = await fetch(`${base}/v1/workspaces/ws-1/mcp`, {
      headers: { accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("data: 1\n\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the first event");
      text += decoder.decode(value, { stream: true });
    }
    expect(text).not.toContain("data: 2");
    releaseSecondEvent();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe("event: first\ndata: 1\n\nevent: second\ndata: 2\n\n");
  }, 30_000);
});
