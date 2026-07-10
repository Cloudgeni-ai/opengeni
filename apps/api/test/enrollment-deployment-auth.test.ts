import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import { requireAccessKey } from "../src/http/auth";

function appForDeploymentGate() {
  const app = new Hono();
  app.use(
    "*",
    requireAccessKey(testSettings({ authRequired: true, accessKey: "deployment-key" })),
  );
  app.all("*", (c) => c.body(null, 204));
  return app;
}

const BOOTSTRAP_POSTS = [
  "/v1/enrollments/device/start",
  "/v1/enrollments/device/poll",
  "/v1/enrollments/token/exchange",
  "/v1/enrollments/self/revoke",
];

const PROTECTED_ENROLLMENT_ROUTES = [
  { method: "POST", path: "/v1/enrollments/device/lookup" },
  { method: "POST", path: "/v1/workspaces/00000000-0000-0000-0000-000000000000/enrollments/device/approve" },
  { method: "POST", path: "/v1/workspaces/00000000-0000-0000-0000-000000000000/enrollments/device/deny" },
  { method: "POST", path: "/v1/workspaces/00000000-0000-0000-0000-000000000000/enrollments/token" },
  { method: "GET", path: "/v1/workspaces/00000000-0000-0000-0000-000000000000/enrollments" },
  { method: "POST", path: "/v1/workspaces/00000000-0000-0000-0000-000000000000/enrollments/00000000-0000-0000-0000-000000000000/revoke" },
];

describe("deployment-key enrollment bootstrap matrix", () => {
  test("permits exactly the unauthenticated bootstrap POST routes", async () => {
    const app = appForDeploymentGate();
    for (const path of BOOTSTRAP_POSTS) {
      expect((await app.request(path, { method: "POST" })).status, path).toBe(204);
      expect((await app.request(path, { method: "GET" })).status, `GET ${path}`).toBe(401);
    }
  });

  test("keeps lookup, consent, mint, list, and admin revoke behind the deployment key", async () => {
    const app = appForDeploymentGate();
    for (const route of PROTECTED_ENROLLMENT_ROUTES) {
      expect((await app.request(route.path, { method: route.method })).status, route.path).toBe(401);
      expect(
        (
          await app.request(route.path, {
            method: route.method,
            headers: { "x-opengeni-access-key": "deployment-key" },
          })
        ).status,
        `deployment key ${route.path}`,
      ).toBe(204);
    }
  });
});