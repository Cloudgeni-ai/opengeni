import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  DEPRECATED_ROUTES,
  assertValidRouteDeprecation,
  deprecationHeaders,
  deprecationHeadersMiddleware,
  type RouteDeprecation,
} from "../src/http/deprecation";

const PACKS: RouteDeprecation = {
  method: "GET",
  path: "/v1/workspaces/:workspaceId/packs",
  deprecatedAt: "2026-09-01T00:00:00Z",
  sunset: "2027-01-01T00:00:00Z",
  link: "https://docs.opengeni.ai/changelog#packs",
  successor: "https://docs.opengeni.ai/plugins",
};

function appWith(registry: readonly RouteDeprecation[]): Hono {
  const app = new Hono();
  app.use("/v1/*", deprecationHeadersMiddleware(registry));
  app.get("/v1/workspaces/:workspaceId/packs", (c) => {
    if (c.req.query("fail")) throw new HTTPException(404, { message: "missing" });
    return c.json({ packs: [] });
  });
  app.get("/v1/workspaces/:workspaceId/plugins", (c) => c.json({ plugins: [] }));
  app.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ message: error.message }, error.status)
      : c.json({}, 500),
  );
  return app;
}

describe("route deprecation headers", () => {
  test("formats RFC 9745 Deprecation, RFC 8594 Sunset, and deprecation/successor links", () => {
    expect(deprecationHeaders(PACKS)).toEqual({
      Deprecation: "@1788220800",
      Sunset: "Fri, 01 Jan 2027 00:00:00 GMT",
      Link: '<https://docs.opengeni.ai/changelog#packs>; rel="deprecation"; type="text/html", <https://docs.opengeni.ai/plugins>; rel="successor-version"',
    });
  });

  test("stamps only the deprecated route, on success and error responses alike", async () => {
    const app = appWith([PACKS]);
    for (const url of ["/v1/workspaces/w1/packs", "/v1/workspaces/w1/packs?fail=1"]) {
      const response = await app.request(url);
      expect(response.headers.get("deprecation")).toBe("@1788220800");
      expect(response.headers.get("sunset")).toBe("Fri, 01 Jan 2027 00:00:00 GMT");
      expect(response.headers.get("link")).toContain('rel="deprecation"');
    }
    const other = await app.request("/v1/workspaces/w1/plugins");
    expect(other.headers.get("deprecation")).toBeNull();
    expect(other.headers.get("sunset")).toBeNull();
    const wrongMethod = await app.request("/v1/workspaces/w1/packs", { method: "POST" });
    expect(wrongMethod.headers.get("deprecation")).toBeNull();
  });

  test("rejects a sunset under the 90-day minimum and malformed entries at startup", () => {
    expect(() => assertValidRouteDeprecation({ ...PACKS, sunset: "2026-10-01T00:00:00Z" })).toThrow(
      /at least 90 days/,
    );
    expect(() => assertValidRouteDeprecation({ ...PACKS, method: "get" })).toThrow(/HTTP verb/);
    expect(() => assertValidRouteDeprecation({ ...PACKS, path: "/internal/x" })).toThrow(/\/v1/);
    expect(() => assertValidRouteDeprecation({ ...PACKS, link: "http://x" })).toThrow(/https/);
    expect(() => deprecationHeadersMiddleware([{ ...PACKS, sunset: "soon" }])).toThrow(/ISO date/);
  });

  test("every registered deprecation names a route the API actually serves", () => {
    const settings = testSettings({ authRequired: true, accessKey: "deprecation-test" });
    const observability = createObservability(settings, { component: "api" });
    const app = createApp({
      settings,
      observability,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const routes = new Set(
      app.routes
        .filter((route) => route.handler.length < 2)
        .map(
          (route) => `${route.method} ${route.path.replace(/(:[A-Za-z0-9_]+)\{[^/]*\}/g, "$1")}`,
        ),
    );
    for (const deprecation of DEPRECATED_ROUTES) {
      assertValidRouteDeprecation(deprecation);
      expect(routes.has(`${deprecation.method} ${deprecation.path}`)).toBe(true);
    }
  });

  test("browser clients can read the deprecation headers through CORS", async () => {
    const settings = testSettings({ authRequired: false });
    const observability = createObservability(settings, { component: "api" });
    observability.info = () => undefined;
    const app = createApp({
      settings,
      observability,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const response = await app.request("/healthz", {
      headers: { origin: settings.publicBaseUrl },
    });
    const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const header of ["deprecation", "sunset", "link"]) expect(exposed).toContain(header);
  });
});
