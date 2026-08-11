import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, AgentBrowserJsonRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e("drives a Kernel-provisioned Chromium through the native CDP surface", async () => {
  const root = await mkdtemp("/tmp/ogb-kernel-e2e-");
  const backingSocket = await mkdtemp("/tmp/ogkb-");
  const providerSocket = await mkdtemp("/tmp/ogkp-");
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
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    await backingDriver.start("about:blank");
    const backing = await backingRunner.run<{ cdpUrl?: unknown }>(["get", "cdp-url"]);
    if (typeof backing.cdpUrl !== "string") throw new Error("backing CDP endpoint missing");

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
          return Response.json({
            session_id: "opengeni-kernel-fixture",
            cdp_ws_url: backing.cdpUrl,
          });
        }
        if (request.method === "DELETE" && url.pathname === "/browsers/opengeni-kernel-fixture") {
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
  } finally {
    try {
      await providerDriver?.close();
    } finally {
      server?.stop(true);
      try {
        await backingDriver.close();
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(backingSocket, { recursive: true, force: true });
        await rm(providerSocket, { recursive: true, force: true });
      }
    }
  }
});
