import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { AgentBrowserDriver, AgentBrowserJsonRunner, BrowserSupervisor } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e("drives a Kernel-provisioned Chromium through the native CDP surface", async () => {
  const root = await mkdtemp("/tmp/ogb-kernel-e2e-");
  const backingSocket = await mkdtemp("/tmp/ogkb-");
  const providerSocket = await mkdtemp("/tmp/ogkp-");
  const managedSocket = await mkdtemp("/tmp/ogkm-");
  const backingRunner = await AgentBrowserJsonRunner.create({
    namespace: `backing_${randomUUID().slice(0, 8)}`,
    sessionName: "browser",
    socketDirectory: backingSocket,
    profileDirectory: join(root, "backing-profile"),
    downloadDirectory: join(root, "backing-downloads"),
    screenshotDirectory: join(root, "backing-screenshots"),
    headed: false,
  });
  const backingDriver = new AgentBrowserDriver({
    browserSessionId: randomUUID(),
    controllerGeneration: `backing-${randomUUID()}`,
    runner: backingRunner,
  });
  let providerDriver: AgentBrowserDriver | null = null;
  let managedSupervisor: BrowserSupervisor | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let cdpProxy: Server | null = null;
  const cdpProxySockets = new Set<Socket>();

  try {
    await backingDriver.start("about:blank");
    const backing = await backingRunner.run<{ cdpUrl?: unknown }>(["get", "cdp-url"]);
    if (typeof backing.cdpUrl !== "string") throw new Error("backing CDP endpoint missing");
    const backingUrl = new URL(backing.cdpUrl);
    const remoteAddress = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === "IPv4" && !address.internal)?.address;
    if (!remoteAddress) throw new Error("remote CDP test requires a non-loopback IPv4 address");
    cdpProxy = createServer((downstream) => {
      const upstream = createConnection({
        host: backingUrl.hostname,
        port: Number(backingUrl.port),
      });
      cdpProxySockets.add(downstream);
      cdpProxySockets.add(upstream);
      downstream.once("close", () => cdpProxySockets.delete(downstream));
      upstream.once("close", () => cdpProxySockets.delete(upstream));
      downstream.once("error", () => upstream.destroy());
      upstream.once("error", () => downstream.destroy());
      upstream.pipe(downstream);
      let handshake = Buffer.alloc(0);
      const forwardHandshake = (chunk: Buffer) => {
        handshake = Buffer.concat([handshake, chunk]);
        if (handshake.byteLength > 64 * 1024) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        const end = handshake.indexOf("\r\n\r\n");
        if (end < 0) return;
        downstream.off("data", forwardHandshake);
        const header = handshake
          .subarray(0, end + 4)
          .toString("utf8")
          .replace(/^Host:.*$/imu, `Host: ${backingUrl.host}`);
        upstream.write(header);
        const remainder = handshake.subarray(end + 4);
        if (remainder.byteLength > 0) upstream.write(remainder);
        downstream.pipe(upstream);
      };
      downstream.on("data", forwardHandshake);
    });
    await new Promise<void>((resolve, reject) => {
      cdpProxy!.once("error", reject);
      cdpProxy!.listen(0, "0.0.0.0", resolve);
    });
    const proxyAddress = cdpProxy.address();
    if (!proxyAddress || typeof proxyAddress === "string") {
      throw new Error("remote CDP proxy did not bind TCP");
    }
    const remoteCdpUrl = new URL(backing.cdpUrl);
    remoteCdpUrl.hostname = remoteAddress;
    remoteCdpUrl.port = String(proxyAddress.port);

    const requests: Array<{
      method: string;
      path: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : null;
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          body,
        });
        if (request.method === "POST" && url.pathname === "/browsers") {
          const routed = typeof body === "object" && body !== null && "proxy_id" in body;
          return Response.json({
            session_id: routed ? "opengeni-kernel-routed-fixture" : "opengeni-kernel-fixture",
            cdp_ws_url: routed ? remoteCdpUrl.toString() : backing.cdpUrl,
          });
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/browsers/opengeni-kernel-")) {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    const providerRunner = await AgentBrowserJsonRunner.create({
      namespace: `provider_${randomUUID().slice(0, 8)}`,
      sessionName: "browser",
      socketDirectory: providerSocket,
      profileDirectory: join(root, "provider-profile"),
      downloadDirectory: join(root, "provider-downloads"),
      screenshotDirectory: join(root, "provider-screenshots"),
      headed: false,
      provider: {
        id: "kernel",
        apiKey: "kernel-private-e2e-key",
        endpoint: `http://127.0.0.1:${server.port}`,
        timeoutSeconds: 417,
        stealth: true,
      },
    });
    providerDriver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `provider-${randomUUID()}`,
      runner: providerRunner,
    });

    const observation = await providerDriver.start(
      "data:text/html,<title>Kernel Canary</title><button>Proceed</button>",
    );
    expect(observation.target.title).toBe("Kernel Canary");
    if (observation.semantic?.kind !== "snapshot") {
      throw new Error("Kernel canary did not produce an initial semantic snapshot");
    }
    expect(observation.semantic.nodeCount).toBeGreaterThanOrEqual(2);
    expect(await providerDriver.runtimeSnapshot()).toMatchObject({
      engine: "chromium",
      tabs: [
        {
          url: "data:text/html,<title>Kernel Canary</title><button>Proceed</button>",
          selected: true,
        },
      ],
    });
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/browsers",
      authorization: "Bearer kernel-private-e2e-key",
      body: {
        headless: true,
        stealth: true,
        timeout_seconds: 417,
      },
    });

    managedSupervisor = await BrowserSupervisor.open({
      rootDirectory: join(root, "managed-supervisor"),
      socketRootDirectory: managedSocket,
    });
    const managedReference = {
      browserSessionId: randomUUID(),
      controllerGeneration: `managed-${randomUUID()}`,
    };
    const managed = await managedSupervisor.createSession({
      ...managedReference,
      headed: false,
      initialUrl: "data:text/html,<title>Routed Kernel Canary</title><button>Proceed</button>",
      transport: {
        kind: "external_provider",
        providerId: "kernel",
        placementId: "default",
        authority: {
          apiKey: "kernel-private-e2e-key",
          endpoint: `http://127.0.0.1:${server.port}`,
        },
        timeoutSeconds: 417,
        stealth: true,
      },
      networkRoute: {
        routeId: randomUUID(),
        routeVersion: 1,
        authorityDigest: `ogr.${"r".repeat(43)}`,
        kind: "managed",
        consistency: {
          dns: "provider",
          expectedPublicIp: null,
          expectedRegion: "NO",
          locale: null,
          timezone: null,
          geolocation: null,
          webRtc: "disable_non_proxied_udp",
          stability: "session",
        },
        providerRoute: {
          providerId: "kernel",
          routeId: "kernel-proxy-e2e",
          egressClass: "isp",
          region: "NO",
        },
      },
    });
    expect(managed.observation.target.title).toBe("Routed Kernel Canary");
    expect(managed.observation.semantic?.kind).toBe("snapshot");
    await managedSupervisor.endSession(managedReference, { removeState: true });
    managedSupervisor = null;
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          typeof request.body === "object" &&
          request.body !== null &&
          "proxy_id" in request.body &&
          request.body.proxy_id === "kernel-proxy-e2e",
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === "/browsers/opengeni-kernel-routed-fixture",
      ),
    ).toBe(true);
  } finally {
    try {
      await managedSupervisor?.close();
    } finally {
      try {
        await providerDriver?.close();
      } finally {
        server?.stop(true);
        for (const socket of cdpProxySockets) socket.destroy();
        cdpProxy?.close();
        try {
          await backingDriver.close();
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(backingSocket, { recursive: true, force: true });
          await rm(providerSocket, { recursive: true, force: true });
          await rm(managedSocket, { recursive: true, force: true });
        }
      }
    }
  }
});
