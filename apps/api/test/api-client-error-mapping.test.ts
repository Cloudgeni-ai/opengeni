import { describe, expect, test } from "bun:test";
import { ErrorEnvelope } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { z } from "zod";
import { createApp, type AppDependencies } from "../src/app";
import { parseRequestJson } from "../src/http/request-body";
import { validatedAllowedToolIds } from "../src/routes/api-integrations";
import { workspaceUpdateRequestsSettings } from "../src/routes/workspaces";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";

// Routes exercised here are rejected before any dependency is touched, so the
// persistence and orchestration dependencies are inert stubs.
function appFor(settings: Settings = testSettings()) {
  return createApp({
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } satisfies AppDependencies);
}

async function envelope(response: Response) {
  return ErrorEnvelope.parse(await response.json()).error;
}

describe("unknown routes and methods", () => {
  test("a method a session route does not register is 405, never a retryable 503", async () => {
    const response = await appFor().request(
      `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/tool-policy`,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("PUT");
    const error = await envelope(response);
    expect(error).toMatchObject({ status: 405, code: "not_found", retryable: false });
    expect(error.message).toContain("Allowed: PUT");
  });

  test("an unregistered path is a 404 envelope under every product prefix", async () => {
    for (const path of [
      "/v1/definitely-not-a-route",
      `/v1/workspaces/${WORKSPACE}/not-a-route`,
      `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/not-a-route`,
    ]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await appFor().request(path, { method });
        expect(response.status).toBe(404);
        expect(await envelope(response)).toMatchObject({
          status: 404,
          code: "not_found",
          retryable: false,
        });
      }
    }
  });

  test("an unknown mutation is 404 before the production contract fence", async () => {
    const response = await appFor(testSettings({ environment: "production" })).request(
      `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/not-a-route`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(404);
  });

  test("CORS preflight keeps its middleware answer", async () => {
    const response = await appFor().request(
      `/v1/workspaces/${WORKSPACE}/sessions/${SESSION}/tool-policy`,
      { method: "OPTIONS" },
    );
    expect(response.status).not.toBe(405);
  });
});

describe("request body validation", () => {
  const Body = z.object({ accountId: z.string().uuid(), name: z.string() }).strict();
  const Projection = z.object({ id: z.string().uuid() });

  function appWithProbeRoutes() {
    const app = appFor();
    app.post("/v1/test-probe/body", async (c) => c.json(await parseRequestJson(c, Body)));
    app.get("/v1/test-probe/projection", (c) => c.json(Projection.parse({ id: "not-a-uuid" })));
    // A route that reads the body itself, without the parsing helpers.
    app.post("/v1/test-probe/raw", async (c) => c.json(await c.req.json()));
    // A request-body failure surfacing through a wrapping error (e.g. a
    // transaction boundary) keeps its client classification.
    app.post("/v1/test-probe/wrapped", async (c) => {
      try {
        return c.json(await parseRequestJson(c, Body));
      } catch (error) {
        throw new Error("transaction failed", { cause: error });
      }
    });
    app.get("/v1/test-probe/stored-json", (c) => c.json(JSON.parse("{stored")));
    return app;
  }

  test("a missing field is a 400 that names it", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", settings: {} }),
    });
    expect(response.status).toBe(400);
    const error = await envelope(response);
    expect(error).toMatchObject({ code: "validation_failed", retryable: false });
    expect(error.message).toContain("accountId");
    expect(error.message).toContain("settings");
    expect(error.details).toMatchObject({ code: "invalid_request_body" });
  });

  test("malformed JSON is a 400", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await envelope(response)).toMatchObject({
      code: "validation_failed",
      details: { code: "invalid_json" },
    });
  });

  test("malformed JSON read directly by a route is a 400", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/raw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    expect(await envelope(response)).toMatchObject({ details: { code: "invalid_json" } });
  });

  test("a wrapped request-body failure stays a 400", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/wrapped", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(response.status).toBe(400);
    expect((await envelope(response)).message).toContain("accountId");
  });

  test("malformed stored JSON stays a 500", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/stored-json");
    expect(response.status).toBe(500);
  });

  test("a server-side projection failure stays a 500", async () => {
    const response = await appWithProbeRoutes().request("/v1/test-probe/projection");
    expect(response.status).toBe(500);
    expect(await envelope(response)).toMatchObject({ code: "internal_error" });
  });

  test("workspace settings sent to the workspace PATCH are detected", () => {
    expect(workspaceUpdateRequestsSettings({ settings: {} })).toBe(true);
    expect(workspaceUpdateRequestsSettings({ name: "x" })).toBe(false);
    expect(workspaceUpdateRequestsSettings(null)).toBe(false);
  });
});

describe("Integration allowedTools", () => {
  const tools = [
    { id: "inventory_listitems", operationKey: "GET /items" },
    { id: "inventory_createitem", operationKey: "POST /items" },
  ];

  test("accepts preview tool ids unchanged", () => {
    expect(validatedAllowedToolIds(["inventory_listitems"], tools)).toEqual([
      "inventory_listitems",
    ]);
  });

  test("rejects an operationKey with a 422 that maps it to the tool id", () => {
    let thrown: unknown;
    try {
      validatedAllowedToolIds(["GET /items"], tools);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: 422,
      code: "validation_failed",
      details: {
        code: "unknown_integration_tools",
        unknownTools: ["GET /items"],
        operationKeyMatches: [{ operationKey: "GET /items", id: "inventory_listitems" }],
        validToolIds: ["inventory_listitems", "inventory_createitem"],
      },
    });
    expect((thrown as Error).message).toContain("GET /items -> inventory_listitems");
  });
});
