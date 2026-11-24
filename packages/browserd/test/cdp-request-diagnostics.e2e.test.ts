import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

e2e(
  "lists a tab's finished requests, successful ones included, only when asked",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-request-diagnostics-");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") {
          return new Response(
            `<!doctype html><title>Requests</title><img src="/logo.png" alt="Logo">
            <p id="state">Saving</p>
            <script>
              (async () => {
                await (await fetch("/api/form")).text();
                await (await fetch("/api/form/step", { method: "POST", body: "{}" })).text();
                // The page stops reading a response after its status arrived.
                const reading = new AbortController();
                await fetch("/api/stream", { signal: reading.signal });
                reading.abort();
                await (await fetch("/api/missing")).text();
                state.textContent = "Saved";
              })();
            </script>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (path === "/logo.png") {
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        }
        if (path === "/api/form") return Response.json({ ok: true });
        if (path === "/api/form/step") return new Response(null, { status: 204 });
        if (path === "/api/stream") {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
                await Bun.sleep(5_000);
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const observation = await driver.start(`${origin}/`);
      const tabId = observation.target.id;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const read = await driver.debug(tabId, { kinds: ["request"] });
        if (read.entries.some((entry) => entry.url === `${origin}/api/missing`)) break;
        await Bun.sleep(100);
      }

      const listed = await driver.debug(tabId, { kinds: ["request"] });
      expect(
        listed.entries.map((entry) => ({
          kind: entry.kind,
          method: entry.method,
          path: new URL(entry.url!).pathname,
          status: entry.status,
          level: entry.level,
          message: entry.message,
        })),
      ).toEqual([
        {
          kind: "request",
          method: "GET",
          path: "/",
          status: 200,
          level: "info",
          message: "HTTP 200 (Document)",
        },
        {
          kind: "request",
          method: "GET",
          path: "/api/form",
          status: 200,
          level: "info",
          message: "HTTP 200 (Fetch)",
        },
        {
          kind: "request",
          method: "POST",
          path: "/api/form/step",
          status: 204,
          level: "info",
          message: "HTTP 204 (Fetch)",
        },
        {
          kind: "request",
          method: "GET",
          path: "/api/stream",
          status: 200,
          level: "info",
          message: "HTTP 200, then net::ERR_ABORTED (Fetch)",
        },
        {
          kind: "request",
          method: "GET",
          path: "/api/missing",
          status: 404,
          level: "error",
          message: "HTTP 404 (Fetch)",
        },
      ]);
      expect(listed.truncated).toBe(false);

      // Without asking for them, the tab's diagnostics stay as before: only
      // the failure, and nothing reported as cut off.
      const unasked = await driver.debug(tabId);
      expect(unasked.entries.map((entry) => entry.kind)).toEqual(["failed_request"]);
      expect(unasked.truncated).toBe(false);

      // Asked together, both kinds come back in the order they happened.
      const both = await driver.debug(tabId, { kinds: ["failed_request", "request"] });
      expect(both.entries.map((entry) => entry.kind)).toEqual([
        "request",
        "request",
        "request",
        "request",
        "failed_request",
        "request",
      ]);
      const sequences = both.entries.map((entry) => entry.sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
