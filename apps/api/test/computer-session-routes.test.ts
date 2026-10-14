import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";

import { registeredApiRoutes } from "../../../scripts/public-api/action-catalog";
import surface from "../../../scripts/public-api/surface.gen.json";
import { registerComputerSessionRoutes } from "../src/routes/computer-sessions";

const routeUrl = new URL("../src/routes/computer-sessions.ts", import.meta.url);
const computerSessionRoot = "/v1/workspaces/:workspaceId/computer-sessions";
type Route = { method: string; path: string };

function isComputerSessionRoute(route: Route): boolean {
  return route.path === computerSessionRoot || route.path.startsWith(`${computerSessionRoot}/`);
}

function routeKey(route: Route): string {
  return `${route.method} ${route.path}`;
}

function assertComputerRouteSurface(actual: readonly Route[], expected: readonly Route[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const route of actual) {
    const key = routeKey(route);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  expect(duplicates).toEqual(new Set());
  expect(seen).toEqual(new Set(expected.map(routeKey)));
}

describe("ComputerSession route discipline", () => {
  test("registers the entire public ComputerSession contract in the module and composed API", () => {
    const app = new Hono();
    // Registration must not perform resource access or start a controller.
    registerComputerSessionRoutes(app, {} as ApiRouteDeps);
    const expected = surface.routes.filter(isComputerSessionRoute);
    expect(expected).not.toEqual([]);
    assertComputerRouteSurface(app.routes, expected);
    assertComputerRouteSurface(registeredApiRoutes().filter(isComputerSessionRoute), expected);
  });

  test("route coverage rejects missing, wrong-method, uncontracted and duplicate handlers", () => {
    const expected = surface.routes.filter(isComputerSessionRoute);
    expect(expected).not.toEqual([]);
    // Every published operation, including input posture, must be registered;
    // a path with the wrong verb or a shadowed handler is not equivalent.
    for (const removed of expected) {
      expect(() =>
        assertComputerRouteSurface(
          expected.filter((route) => routeKey(route) !== routeKey(removed)),
          expected,
        ),
      ).toThrow();
    }
    const operation = expected[0]!;
    for (const invalid of [
      expected.map((route) => (route === operation ? { ...route, method: "UNSUPPORTED" } : route)),
      [...expected, { method: "POST", path: `${computerSessionRoot}/uncontracted` }],
      [...expected, operation],
    ]) {
      expect(() => assertComputerRouteSurface(invalid, expected)).toThrow();
    }
    // Route registration order is not a public lifecycle or control invariant.
    assertComputerRouteSurface([...expected].reverse(), expected);
  });

  test("unsupported suspend and resume do not become public lifecycle operations", async () => {
    const app = new Hono();
    registerComputerSessionRoutes(app, {} as ApiRouteDeps);
    const resource = computerSessionRoot.replace(":workspaceId", "workspace") + "/computer";
    for (const operation of ["suspend", "resume"]) {
      for (const method of ["GET", "POST"]) {
        expect((await app.request(`${resource}/${operation}`, { method })).status).toBe(404);
      }
    }
  });

  test("authenticates before parsing and derives physical facts only from controller output", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"');
    const end = source.indexOf("app.get(", start);
    const create = source.slice(start, end);
    expect(create.indexOf("requireAccessGrant")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("requireAccessGrant")).toBeLessThan(
      create.indexOf("parseJsonBody(context, CreateComputerSessionRequest)"),
    );
    expect(create.indexOf("createComputerSession")).toBeLessThan(
      create.indexOf("activateComputerSession"),
    );
    for (const field of [
      "physical.platform",
      "physical.adapter",
      "physical.seatId",
      "physical.displayId",
      "physical.capabilities",
    ]) {
      expect(create).toContain(field);
    }
  });

  test("admits every active operation through the exact durable controller and lease fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    const active = source.slice(source.indexOf("async function withActiveComputerController"));
    expect(active.indexOf("touchComputerSessionController(deps.db")).toBeLessThan(
      active.indexOf("return await withComputerPlacement("),
    );
    expect(source).toContain("holderId: interactionHolderId(computerSessionId)");
    expect(source).toContain("return `computer-session:${computerSessionId}`");
    expect(source).toContain("expectedPlacementInstanceId");
    const holder = source.slice(
      source.indexOf("async function ensureInteractionHolder"),
      source.indexOf("async function releaseInteractionHolder"),
    );
    expect(holder).toContain('imagePolicy: "new_creates_only"');
    expect(holder).toContain("expectedEpoch: placement.lease.leaseEpoch");
    expect(holder).toContain("rigVersionId: sourceSession.rigVersionId");
  });

  test("routes attached-device ComputerSessions through the exact connected agent fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(
      source.indexOf("async function withComputerPlacement"),
      source.indexOf("async function withActiveComputerController"),
    );
    expect(placement).toContain('expectedPlacement?.kind === "attached_device"');
    expect(placement).toContain("getAttachedBrowserDevice(deps.db");
    expect(placement).toContain("getLiveEnrollmentConnection(");
    expect(placement).toContain("enrollment.connectionInstanceId");
    expect(placement).toContain("buildSelfhostedBackendSession({");
    expect(placement).toContain("new NatsControlRpc(");
    expect(placement).toContain("attachedEndPlacementInstanceId(");
    expect(placement).toContain("device.connectionGeneration");
    expect(source).toContain('operation === "computer.end" && expectedPlacementInstanceId');
  });

  test("retires a stale Connected Machine placement instead of advertising a retryable 409", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(
      source.indexOf("async function withComputerPlacement"),
      source.indexOf("async function withActiveComputerController"),
    );
    const active = source.slice(
      source.indexOf("async function withActiveComputerController"),
      source.indexOf("async function ensureInteractionHolder"),
    );
    expect(placement).toContain("throwComputerSourcePlacementChanged");
    expect(active).toContain("terminalizeStaleConnectedInteractionPlacement");
    expect(active.indexOf("terminalizeStaleConnectedInteractionPlacement")).toBeLessThan(
      active.indexOf('sourcePlacementChangedApiError("computer_session")'),
    );
    expect(source).toContain('interactionFailureCode: "source_placement_changed"');
    expect(source).toContain('interactionLifecycle: "lost"');
    expect(source).toContain("retryable: false");
  });

  test("dispatches lifecycle authority before physical mutation and preserves unknown outcomes", async () => {
    const source = await readFile(routeUrl, "utf8");
    const create = source.slice(
      source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"'),
      source.indexOf(
        "app.get(",
        source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"'),
      ),
    );
    expect(create.indexOf("ensureDispatchedGeneration")).toBeLessThan(
      create.indexOf("client.createComputerSession"),
    );
    expect(create).toContain('state: "outcome_unknown" as const');
    expect(create).toContain("const rethrowAfterFailure =");
    expect(create).toContain("error instanceof BrowserControlTransportError");
    expect(create).toContain("isAbort(error)");
    expect(create.indexOf("failComputerSessionOperation")).toBeLessThan(
      create.indexOf("if (rethrowAfterFailure) throw error"),
    );

    const end = source.slice(
      source.indexOf('"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/end"'),
      source.indexOf("async function withComputerPlacement"),
    );
    const dispatched = end.slice(end.indexOf("dispatchComputerSessionOperation"));
    expect(dispatched.indexOf("dispatchComputerSessionOperation")).toBeLessThan(
      dispatched.indexOf("client.endComputerSession"),
    );
    expect(dispatched.indexOf("client.endComputerSession")).toBeLessThan(
      dispatched.indexOf("completeComputerSessionEnd"),
    );
  });
});
