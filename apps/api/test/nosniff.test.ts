import { describe, expect, test } from "bun:test";

import {
  lastResortErrorResponse,
  serveWithLastResortError,
  withNoSniff,
  withNoSniffEventually,
} from "../src/http/nosniff";
import { dispatchApiWebSocketUpgrade } from "../src/http/websocket-upgrade-dispatch";

describe("nosniff outside the Hono app", () => {
  test("adds nosniff to mutable and immutable responses and keeps a route's own value", async () => {
    expect(withNoSniff(new Response("x")).headers.get("x-content-type-options")).toBe("nosniff");
    const immutable = withNoSniff(Response.redirect("https://example.test/next", 302));
    expect(immutable.status).toBe(302);
    expect(immutable.headers.get("location")).toBe("https://example.test/next");
    expect(immutable.headers.get("x-content-type-options")).toBe("nosniff");
    const own = withNoSniff(new Response("x", { headers: { "x-content-type-options": "kept" } }));
    expect(own.headers.get("x-content-type-options")).toBe("kept");
  });

  test("WebSocket upgrade refusals carry nosniff; a completed upgrade stays undefined", async () => {
    const refusing = {
      handles: (request: Request) => new URL(request.url).pathname === "/v1/refuse",
      upgrade: () => new Response("Upgrade required", { status: 426 }),
    };
    const refusingLater = {
      handles: (request: Request) => new URL(request.url).pathname === "/v1/refuse-later",
      upgrade: async () => new Response("Unauthorized", { status: 401 }),
    };
    const upgrading = {
      handles: (request: Request) => new URL(request.url).pathname === "/v1/upgrade",
      upgrade: () => undefined,
    };
    const routes = [refusing, refusingLater, upgrading];
    const now = dispatchApiWebSocketUpgrade(
      new Request("http://api.example.test/v1/refuse"),
      {},
      routes,
      null,
    );
    expect(now.handled && (now.response as Response).status).toBe(426);
    expect(now.handled && (now.response as Response).headers.get("x-content-type-options")).toBe(
      "nosniff",
    );
    const later = dispatchApiWebSocketUpgrade(
      new Request("http://api.example.test/v1/refuse-later"),
      {},
      routes,
      null,
    );
    const laterResponse = later.handled ? await later.response : undefined;
    expect(laterResponse?.status).toBe(401);
    expect(laterResponse?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      dispatchApiWebSocketUpgrade(
        new Request("http://api.example.test/v1/upgrade"),
        {},
        routes,
        null,
      ),
    ).toEqual({ handled: true, response: undefined });
  });

  test("a failure that escapes the app answers a generic 500 with nosniff", async () => {
    const seen: unknown[] = [];
    const response = await serveWithLastResortError(
      () => {
        // Hono re-throws values that are not Error instances.
        throw "boom";
      },
      (error) => seen.push(error),
    );
    expect(seen).toEqual(["boom"]);
    expect(response.status).toBe(500);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).not.toContain("boom");
    const rejected = await serveWithLastResortError(() => Promise.reject(new Error("secret")));
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).not.toContain("secret");
    expect(lastResortErrorResponse().headers.get("content-type")).toContain("application/json");
    const passed = await serveWithLastResortError(() => new Response("ok"));
    expect(await passed.text()).toBe("ok");
  });

  test("a rejected asynchronous upgrade answers the generic 500 with nosniff", async () => {
    const rejected = await withNoSniffEventually(Promise.reject(new Error("secret")));
    expect(rejected?.status).toBe(500);
    expect(rejected?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await rejected?.text()).not.toContain("secret");
    expect(await withNoSniffEventually(Promise.resolve(undefined))).toBeUndefined();
  });
});
