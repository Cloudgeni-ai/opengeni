import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
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
      organizationGovernanceEnabled: true,
    }),
    db: {},
    governanceDb: {},
  } as unknown as ApiRouteDeps;
}

describe("organization governance recovery routes", () => {
  test("rejects local/configured policy and lock requests before parsing or mutating", async () => {
    const accountId = "00000000-0000-4000-8000-000000000001";
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const settings = testSettings({
      productAccessMode: "configured",
      delegationSecret: "organization-route-configured-secret",
      organizationGovernanceEnabled: true,
    });
    const status = spyOn(opengeniDb, "getOrganizationGovernanceStatus").mockResolvedValue({
      accountId,
      kind: "team",
      state: "active",
      governanceRevision: 0,
      authoritySubjectId: "user:owner",
      authorizationInvalidatedAt: null,
    });
    const governance = spyOn(opengeniDb, "getOrganizationGovernance");
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      accountId,
      workspaceId,
      subjectId: "configured:admin",
      permissions: ["account:admin"],
      principalKind: "service",
      exp: Math.floor(Date.now() / 1_000) + 60,
    });
    const app = new Hono();
    registerOrganizationRoutes(app, {
      settings,
      db: {},
      governanceDb: {},
    } as unknown as ApiRouteDeps);
    try {
      for (const [method, path, body] of [
        ["PUT", `/v1/accounts/${accountId}/governance/recovery-policy`, "not-json"],
        ["POST", `/v1/accounts/${accountId}/governance/lock`, "not-json"],
      ] as const) {
        const response = await app.request(`http://example.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
        });
        expect(response.status).toBe(403);
      }
      expect(governance).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalled();
    } finally {
      status.mockRestore();
      governance.mockRestore();
    }
  });

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

  test("exposes exactly one body-minimal custodian self-accept route", () => {
    expect((routesSource.match(/recovery-policy\/self-accept/g) ?? []).length).toBe(1);
    const start = routesSource.indexOf(
      '"/v1/accounts/:accountId/governance/recovery-policy/self-accept"',
    );
    const end = routesSource.indexOf('app.post("/v1/accounts/:accountId/governance/lock"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = routesSource.slice(start, end);
    expect(handler).not.toContain("c.req.json()");
    expect(handler).toContain("acceptOrganizationRecoveryCustodianForRequest");
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
