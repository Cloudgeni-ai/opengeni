import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import {
  registerOrganizationRoutes,
  requireSecureRecoveryTransport,
} from "../src/routes/organizations";

const here = dirname(fileURLToPath(import.meta.url));
const routesSource = readFileSync(resolve(here, "..", "src", "routes", "organizations.ts"), "utf8");

function deps(
  environment: "test" | "production" = "test",
  publicBaseUrl = "http://127.0.0.1:3000",
): ApiRouteDeps {
  return {
    settings: testSettings({
      environment,
      productAccessMode: "managed",
      publicBaseUrl,
    }),
    db: {},
  } as unknown as ApiRouteDeps;
}

describe("organization governance recovery routes", () => {
  test("rejects an unauthenticated approval before parsing sensitive evidence", async () => {
    const app = new Hono();
    registerOrganizationRoutes(app, deps());

    const response = await app.request(
      "http://example.test/v1/accounts/00000000-0000-4000-8000-000000000001/" +
        "recovery-operations/00000000-0000-4000-8000-000000000002/approvals",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is deliberately not json",
      },
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("evidence");
  });

  test("keeps authorization and TLS checks ahead of approval body parsing", () => {
    const start = routesSource.indexOf(
      '"/v1/accounts/:accountId/recovery-operations/:operationId/approvals"',
    );
    const end = routesSource.indexOf(
      '"/v1/accounts/:accountId/recovery-operations/:operationId/approval/revoke"',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = routesSource.slice(start, end);
    const authenticateAt = handler.indexOf("requireAccessContext(");
    const authorizeAt = handler.indexOf("requireOrganizationRecoveryCustodianOrReplay(");
    const tlsAt = handler.indexOf("requireSecureRecoveryTransport(");
    const parseAt = handler.indexOf("c.req.json()");
    expect(authenticateAt).toBeGreaterThanOrEqual(0);
    expect(authorizeAt).toBeGreaterThan(authenticateAt);
    expect(tlsAt).toBeGreaterThan(authorizeAt);
    expect(parseAt).toBeGreaterThan(tlsAt);
  });

  test("requires HTTPS in production while allowing local test transport", () => {
    expect(() =>
      requireSecureRecoveryTransport(
        "http://api.example.test/v1/accounts/a/recovery-operations/o/approvals",
        deps("production"),
      ),
    ).toThrow("organization recovery evidence requires HTTPS");
    expect(() =>
      requireSecureRecoveryTransport(
        "https://api.example.test/v1/accounts/a/recovery-operations/o/approvals",
        deps("production"),
      ),
    ).not.toThrow();
    expect(() =>
      requireSecureRecoveryTransport(
        "http://internal.test/v1/accounts/a/recovery-operations/o/approvals",
        deps("production", "https://api.example.test"),
      ),
    ).not.toThrow();
    expect(() =>
      requireSecureRecoveryTransport(
        "http://localhost/v1/accounts/a/recovery-operations/o/approvals",
        deps(),
      ),
    ).not.toThrow();
  });
});
