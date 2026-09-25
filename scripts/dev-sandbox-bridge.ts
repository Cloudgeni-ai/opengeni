#!/usr/bin/env bun
// Local development only: the Docker sandbox route to a loopback-only API on
// Linux.
//
// `bun run dev` binds the unauthenticated API to 127.0.0.1. Docker Desktop
// (macOS, Windows) forwards `host.docker.internal` to that loopback API, but a
// Linux Docker Engine container reaches the host only through a bridge gateway
// address, where nothing listens. This forwarder listens on exactly one
// address, the gateway of this worktree's Compose network (which every local
// Docker sandbox joins), and relays only the routes a sandbox calls:
// Codemode, first-party MCP, and the personal HTTPS Git broker. It refuses
// peers outside that network's subnet, so neither other devices nor unrelated
// containers on the default bridge can reach the API through it.
//
//   bun scripts/dev-sandbox-bridge.ts resolve <docker-network>
//     prints "<gateway>\t<subnet>" or exits 3 with the reason on stderr
//   bun scripts/dev-sandbox-bridge.ts serve
//     reads OPENGENI_SANDBOX_BRIDGE_{HOST,PORT,SUBNET,API_ORIGIN}

import { execFileSync } from "node:child_process";
import { createServer, request as upstreamRequest, type Server } from "node:http";
import { createServer as createNetServer, isIPv4 } from "node:net";
import { localSandboxApiRouteAllowed } from "@opengeni/config";

export const SANDBOX_BRIDGE_HEALTH_PATH = "/__opengeni_sandbox_bridge_health";

/**
 * Whether a normalized request path is one a Docker sandbox needs. The API
 * applies the same allowlist to requests addressed to its sandbox-only names.
 */
export function sandboxBridgeRouteAllowed(pathname: string): boolean {
  return localSandboxApiRouteAllowed(pathname);
}

export type DockerBridgeRoute = { gateway: string; subnet: string };

function ipv4Number(address: string): number | null {
  if (!isIPv4(address)) return null;
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

/** Whether an IPv4 address lies inside an IPv4 CIDR range. */
export function ipv4InSubnet(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const value = ipv4Number(address);
  const base = network === undefined ? null : ipv4Number(network);
  if (value === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(base / size);
}

/** A socket peer address as plain IPv4, unwrapping IPv4-mapped IPv6. */
export function normalizePeerAddress(address: string | undefined | null): string | null {
  if (!address) return null;
  const unwrapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  return isIPv4(unwrapped) ? unwrapped : null;
}

/**
 * The IPv4 gateway routes in `docker network inspect --format '{{json .IPAM.Config}}'`.
 * A gateway must lie inside its own subnet.
 */
export function dockerBridgeRouteCandidates(ipamConfig: unknown): DockerBridgeRoute[] {
  if (!Array.isArray(ipamConfig)) return [];
  const routes: DockerBridgeRoute[] = [];
  for (const entry of ipamConfig) {
    if (!entry || typeof entry !== "object") continue;
    const gateway = (entry as { Gateway?: unknown }).Gateway;
    const subnet = (entry as { Subnet?: unknown }).Subnet;
    if (
      typeof gateway === "string" &&
      typeof subnet === "string" &&
      isIPv4(gateway) &&
      ipv4InSubnet(gateway, subnet)
    ) {
      routes.push({ gateway, subnet });
    }
  }
  return routes;
}

/**
 * Whether this process can listen on an address, which holds exactly when the
 * address belongs to this host. Linux Docker Engine assigns the gateway to the
 * host's bridge interface (even before a container brings it up); Docker
 * Desktop and rootless Docker keep it in a VM or network namespace.
 */
export async function canListenOn(address: string): Promise<boolean> {
  const server = createNetServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address, port: 0, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function resolveDockerBridgeRoute(
  network: string,
  options: {
    inspect?: (network: string) => string;
    isHostAddress?: (address: string) => Promise<boolean>;
  } = {},
): Promise<{ route: DockerBridgeRoute } | { reason: string }> {
  const inspect =
    options.inspect ??
    ((name: string) =>
      execFileSync("docker", ["network", "inspect", name, "--format", "{{json .IPAM.Config}}"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  let config: unknown;
  try {
    config = JSON.parse(inspect(network));
  } catch {
    return { reason: `could not inspect Docker network ${network}` };
  }
  const isHostAddress = options.isHostAddress ?? canListenOn;
  for (const route of dockerBridgeRouteCandidates(config)) {
    if (await isHostAddress(route.gateway)) return { route };
  }
  return {
    reason: `the gateway of Docker network ${network} is not an address on this host (Docker Desktop or rootless Docker)`,
  };
}

function writeJson(
  outgoing: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}

/** The forwarder. Streams both directions and preserves the sandbox's Host. */
export function createSandboxBridgeServer(options: { subnet: string; apiOrigin: string }): Server {
  const api = new URL(options.apiOrigin);
  const server = createServer((incoming, outgoing) => {
    const peer = normalizePeerAddress(incoming.socket.remoteAddress);
    if (!peer || !ipv4InSubnet(peer, options.subnet)) {
      writeJson(outgoing, 403, { error: "peer is outside this stack's Docker network" });
      return;
    }
    let url: URL;
    try {
      // URL parsing resolves dot segments, so the allowlist sees, and the API
      // receives, the same normalized path.
      url = new URL(incoming.url ?? "/", "http://sandbox-bridge.invalid");
    } catch {
      writeJson(outgoing, 400, { error: "invalid request target" });
      return;
    }
    if (url.pathname === SANDBOX_BRIDGE_HEALTH_PATH) {
      writeJson(outgoing, 200, { ok: true });
      return;
    }
    if (!sandboxBridgeRouteAllowed(url.pathname)) {
      writeJson(outgoing, 404, {
        error: "the Docker sandbox route serves only Codemode, first-party MCP, and the Git broker",
      });
      return;
    }
    const upstream = upstreamRequest(
      {
        protocol: api.protocol,
        hostname: api.hostname,
        port: api.port,
        method: incoming.method,
        path: `${url.pathname}${url.search}`,
        // Keep the sandbox-visible Host: the API admits it as its configured
        // sandbox route and derives sandbox-facing URLs from it.
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) {
        writeJson(outgoing, 502, { error: "local API unavailable", detail: error.message });
      } else {
        outgoing.destroy(error);
      }
    });
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  // Git packfile uploads and MCP/Codemode streams may legitimately run long.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

function requiredEnvironment(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function serve(): Promise<void> {
  const host = requiredEnvironment("OPENGENI_SANDBOX_BRIDGE_HOST");
  const port = Number.parseInt(requiredEnvironment("OPENGENI_SANDBOX_BRIDGE_PORT"), 10);
  const subnet = requiredEnvironment("OPENGENI_SANDBOX_BRIDGE_SUBNET");
  const apiOrigin = requiredEnvironment("OPENGENI_SANDBOX_BRIDGE_API_ORIGIN");
  if (!isIPv4(host) || !ipv4InSubnet(host, subnet)) {
    throw new Error("OPENGENI_SANDBOX_BRIDGE_HOST must be an IPv4 address inside the subnet");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("OPENGENI_SANDBOX_BRIDGE_PORT must be a TCP port");
  }
  const server = createSandboxBridgeServer({ subnet, apiOrigin });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  console.log(
    `OpenGeni Docker sandbox route listening on ${host}:${port} for ${subnet} (Codemode, MCP, Git broker)`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (import.meta.main) {
  const [command, network] = process.argv.slice(2);
  if (command === "resolve" && network) {
    const result = await resolveDockerBridgeRoute(network);
    if ("route" in result) {
      process.stdout.write(`${result.route.gateway}\t${result.route.subnet}\n`);
    } else {
      console.error(result.reason);
      process.exit(3);
    }
  } else if (command === "serve") {
    try {
      await serve();
    } catch (error) {
      console.error(
        `Could not start the Docker sandbox route: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    }
  } else {
    console.error("usage: bun scripts/dev-sandbox-bridge.ts resolve <docker-network> | serve");
    process.exit(2);
  }
}
