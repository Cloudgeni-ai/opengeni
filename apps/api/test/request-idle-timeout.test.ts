import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { Hono } from "hono";
import {
  API_SERVER_IDLE_TIMEOUT_SECONDS,
  apiRequestBindingsForIdleTimeout,
  withoutRequestIdleTimeout,
} from "../src/http/request-idle-timeout";

/** A server wired exactly as the API server wires it, with a one-second idle
 * timeout standing in for the production 255 seconds. */
function serve(app: Hono) {
  return Bun.serve({
    port: 0,
    idleTimeout: 1,
    fetch: (request, bunServer) =>
      app.fetch(
        request,
        apiRequestBindingsForIdleTimeout((seconds) => bunServer.timeout(request, seconds), 1),
      ),
  });
}

describe("request idle timeout", () => {
  test("work run without the idle timeout outlives the server's idle timeout", async () => {
    const app = new Hono();
    app.post("/lifted", async (c) =>
      c.text(await withoutRequestIdleTimeout(c, async () => (await Bun.sleep(6_000), "receipt"))),
    );
    app.post("/plain", async (c) => {
      await Bun.sleep(6_000);
      return c.text("receipt");
    });
    const server = serve(app);
    try {
      // The requests carry no body: that is the case in which Bun 1.4.4
      // visibly resets a pending request.
      const send = async (path: string) => {
        try {
          const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
            method: "POST",
            timeout: false,
          } as RequestInit);
          return await response.text();
        } catch (error) {
          return error instanceof Error ? error.name : "error";
        }
      };
      const [lifted, plain] = await Promise.all([send("/lifted"), send("/plain")]);
      expect(lifted).toBe("receipt");
      // Without it the server resets the still-pending request.
      expect(plain).not.toBe("receipt");
    } finally {
      await server.stop(true);
    }
  }, 20_000);

  test("a kept-alive connection gets the server's idle timeout back after the work", async () => {
    const app = new Hono();
    app.get("/lifted", async (c) =>
      c.text(await withoutRequestIdleTimeout(c, async () => (await Bun.sleep(2_000), "receipt"))),
    );
    const server = serve(app);
    try {
      const socket = connect(server.port!, "127.0.0.1");
      let received = "";
      let respondedAt = 0;
      const closedAt = new Promise<number>((resolve) => {
        socket.on("data", (chunk) => {
          received += chunk.toString();
          if (!respondedAt && received.includes("receipt")) respondedAt = Date.now();
        });
        socket.on("close", () => resolve(Date.now()));
        socket.on("error", () => undefined);
      });
      socket.write("GET /lifted HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n");
      const closed = await Promise.race([closedAt, Bun.sleep(12_000).then(() => null)]);
      socket.destroy();
      expect(received).toContain("receipt");
      // The idle connection is closed by the restored one-second idle timer,
      // not held open indefinitely.
      expect(closed).not.toBeNull();
      expect(closed! - respondedAt).toBeLessThan(8_000);
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("lifts the timer during the work and restores the server's value after it", async () => {
    const set: number[] = [];
    const app = new Hono();
    app.get("/", async (c) => {
      await withoutRequestIdleTimeout(c, async () => set.push(-1));
      return c.text("ok");
    });
    app.get("/fails", async (c) => {
      await withoutRequestIdleTimeout(c, async () => {
        throw new Error("controller failed");
      }).catch(() => undefined);
      return c.text("ok");
    });
    const bindings = apiRequestBindingsForIdleTimeout((seconds) => set.push(seconds));
    await app.request("/", {}, bindings);
    expect(set).toEqual([0, -1, API_SERVER_IDLE_TIMEOUT_SECONDS]);
    set.length = 0;
    await app.request("/fails", {}, bindings);
    expect(set).toEqual([0, API_SERVER_IDLE_TIMEOUT_SECONDS]);
    // An in-process request without a server binding is left alone.
    expect((await app.request("/")).status).toBe(200);
  });

  test("browser and computer action routes run the controller call without it", async () => {
    for (const [file, route, controller] of [
      [
        "browser-sessions.ts",
        '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
        "withActiveBrowserController(",
      ],
      [
        "computer-sessions.ts",
        '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/actions"',
        "withActiveComputerController(",
      ],
    ] as const) {
      const source = await readFile(new URL(`../src/routes/${file}`, import.meta.url), "utf8");
      const start = source.indexOf(route);
      const lift = source.indexOf("withoutRequestIdleTimeout(", start);
      expect(start).toBeGreaterThan(0);
      expect(lift).toBeGreaterThan(start);
      expect(lift).toBeLessThan(source.indexOf(controller, start));
    }
    const server = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(server).toContain("idleTimeout: API_SERVER_IDLE_TIMEOUT_SECONDS");
    expect(server).toContain(
      "apiRequestBindingsForIdleTimeout((seconds) => bunServer.timeout(request, seconds))",
    );
  });
});
