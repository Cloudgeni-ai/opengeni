import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import {
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
} from "@opengeni/db";
import {
  interactionResourceRouteError,
  registerInteractionResourceRoutes,
} from "../src/routes/interaction-resources";

const routeUrl = new URL("../src/routes/interaction-resources.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

describe("interaction resource routes", () => {
  test("registers canonical network, auth, run, and intervention resources", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/interaction-events/stream"',
      '"/v1/workspaces/:workspaceId/network-routes"',
      '"/v1/workspaces/:workspaceId/network-routes/:networkRouteId"',
      '"/v1/workspaces/:workspaceId/site-auth-connections"',
      '"/v1/workspaces/:workspaceId/site-auth-connections/:siteAuthConnectionId"',
      '"/v1/workspaces/:workspaceId/auth-runs"',
      '"/v1/workspaces/:workspaceId/auth-runs/:authRunId"',
      '"/v1/workspaces/:workspaceId/interaction-interventions"',
      '"/v1/workspaces/:workspaceId/interaction-interventions/:interventionId"',
      '"/v1/workspaces/:workspaceId/interaction-interventions/:interventionId/resolve"',
    ]) {
      expect(source).toContain(route);
    }
    expect(await readFile(appUrl, "utf8")).toContain(
      "registerInteractionResourceRoutes(app, routeDeps)",
    );
  });

  test.each([
    ["POST", "network-routes"],
    ["PATCH", "network-routes/resource"],
    ["POST", "site-auth-connections"],
    ["PATCH", "site-auth-connections/resource"],
    ["POST", "interaction-interventions"],
    ["POST", "interaction-interventions/resource/resolve"],
  ])("%s %s authenticates before parsing malformed mutation bodies", async (method, resource) => {
    let databaseReads = 0;
    const db = new Proxy({} as ApiRouteDeps["db"], {
      get() {
        databaseReads += 1;
        throw new Error("unauthenticated request reached the database");
      },
    });
    const app = new Hono();
    registerInteractionResourceRoutes(app, {
      db,
      settings: testSettings({ productAccessMode: "managed" }),
    } as ApiRouteDeps);
    const response = await app.request(`/v1/workspaces/workspace/${resource}`, {
      method,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("authentication required");
    expect(databaseReads).toBe(0);
  });

  test("retains the intervention provenance wiring", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf(
      'app.post("/v1/workspaces/:workspaceId/interaction-interventions"',
    );
    const createEnd = source.indexOf("app.get(", createStart);
    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createEnd).toBeGreaterThan(createStart);
    const create = source.slice(createStart, createEnd);
    expect(create).toContain("resourceSourceSessionId");
    expect(create).toContain("originatingToolOperationId");
  });

  test("resolves an agent-owned intervention through its exact approval boundary", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/interaction-interventions/:interventionId/resolve"',
    );
    const route = source.slice(start, source.indexOf("\n  );", start));
    expect(route).toContain("getInteractionInterventionApprovalTarget");
    expect(route).toContain(
      'authorizeSession(deps, grant, approvalTarget.sessionId, "session.approval.write")',
    );
    expect(route).toContain("acceptSessionApprovalDecision");
    expect(route).toContain("interactionIntervention:");
    expect(route).toContain("signalApprovalDecision");
  });

  test("maps absence separately from conflict/state and hides unknown failures", () => {
    expect(
      interactionResourceRouteError(new InteractionResourceNotFoundError("missing")).status,
    ).toBe(404);
    expect(
      interactionResourceRouteError(new InteractionResourceConflictError("conflict")).status,
    ).toBe(409);
    expect(interactionResourceRouteError(new InteractionResourceStateError("state")).status).toBe(
      409,
    );
    expect(interactionResourceRouteError(new Error("private database detail")).message).toBe(
      "Interaction resource request failed",
    );
  });
});
