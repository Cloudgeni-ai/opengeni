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

  async function startBridge(subnet: string) {
    const seen: Array<{ host: string | null; path: string; body: string }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
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
});
