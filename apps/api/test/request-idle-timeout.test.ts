import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  API_SERVER_IDLE_TIMEOUT_SECONDS,
  apiRequestBindingsForIdleTimeout,
  liftRequestIdleTimeout,
} from "../src/http/request-idle-timeout";

describe("request idle timeout", () => {
  test("a route that lifts its idle timeout outlives the server's idle timeout", async () => {
    const app = new Hono();
    app.post("/lifted", async (c) => {
      liftRequestIdleTimeout(c);
      await Bun.sleep(6_000);
      return c.text("receipt");
    });
    app.post("/plain", async (c) => {
      await Bun.sleep(6_000);
      return c.text("receipt");
    });
    // Wired exactly as the API server wires it, with a one-second idle timeout
    // standing in for the production 255 seconds. The requests carry no body:
    // that is the case in which Bun 1.4.4 visibly resets a pending request.
    const server = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch: (request, bunServer) =>
        app.fetch(
          request,
          apiRequestBindingsForIdleTimeout((seconds) => bunServer.timeout(request, seconds)),
        ),
    });
    try {
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

  test("turns the timer off, since Bun clamps a longer one to the server maximum", async () => {
    const set: number[] = [];
    const app = new Hono();
    app.get("/", (c) => {
      liftRequestIdleTimeout(c);
      return c.text("ok");
    });
    await app.request(
      "/",
      {},
      apiRequestBindingsForIdleTimeout((seconds) => set.push(seconds)),
    );
    expect(set).toEqual([0]);
    expect(API_SERVER_IDLE_TIMEOUT_SECONDS).toBe(255);
    // An in-process request without a server binding is left alone.
    expect((await app.request("/")).status).toBe(200);
  });

  test("browser and computer action routes lift it before waiting for the controller", async () => {
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
      const lift = source.indexOf("liftRequestIdleTimeout(context)", start);
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
