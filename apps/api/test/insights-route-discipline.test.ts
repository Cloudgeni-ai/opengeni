import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  normalizeWorkspaceInsightsQueryFilter,
  registerInsightsRoutes,
} from "../src/routes/insights";

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(resolve(here, "..", "src", "routes", "insights.ts"), "utf8");
const appSrc = readFileSync(resolve(here, "..", "src", "app.ts"), "utf8");

describe("insights route discipline", () => {
  test("requires workspace:admin before aggregating", () => {
    const grantCall = 'requireAccessGrant(c, deps, workspaceId, "workspace:admin")';
    const grantAt = routesSrc.indexOf(grantCall);
    expect(grantAt).toBeGreaterThanOrEqual(0);
    const getAt = routesSrc.indexOf("await getWorkspaceInsights(", grantAt);
    const validationAt = routesSrc.indexOf(
      'normalizeWorkspaceInsightsQueryFilter(providerRaw, "provider")',
      grantAt,
    );
    expect(getAt).toBeGreaterThan(grantAt);
    expect(validationAt).toBeGreaterThan(grantAt);
    expect(validationAt).toBeLessThan(getAt);
  });

  test("normalizes empty filters and accepts exact ASCII and multibyte byte boundaries", () => {
    const providerMultibyteAtLimit = `${"é".repeat(127)}aa`;
    const modelMultibyteAtLimit = `${"é".repeat(255)}aa`;

    expect(normalizeWorkspaceInsightsQueryFilter(" \t\n ", "provider")).toBeNull();
    expect(normalizeWorkspaceInsightsQueryFilter(" all ", "model")).toBeNull();
    expect(normalizeWorkspaceInsightsQueryFilter(` ${"p".repeat(256)} `, "provider")).toBe(
      "p".repeat(256),
    );
    expect(normalizeWorkspaceInsightsQueryFilter(` ${"m".repeat(512)} `, "model")).toBe(
      "m".repeat(512),
    );
    expect(normalizeWorkspaceInsightsQueryFilter(providerMultibyteAtLimit, "provider")).toBe(
      providerMultibyteAtLimit,
    );
    expect(normalizeWorkspaceInsightsQueryFilter(modelMultibyteAtLimit, "model")).toBe(
      modelMultibyteAtLimit,
    );
  });

  test("maps exact ASCII and multibyte filter overflow to deterministic HTTP 400", () => {
    const cases = [
      ["provider", "p".repeat(257), "provider must be at most 256 UTF-8 bytes"],
      ["model", "m".repeat(513), "model must be at most 512 UTF-8 bytes"],
      ["provider", `${"é".repeat(127)}aaa`, "provider must be at most 256 UTF-8 bytes"],
      ["model", `${"é".repeat(255)}aaa`, "model must be at most 512 UTF-8 bytes"],
    ] as const;

    for (const [field, value, message] of cases) {
      let caught: unknown;
      try {
        normalizeWorkspaceInsightsQueryFilter(value, field);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HTTPException);
      expect((caught as HTTPException).status).toBe(400);
      expect((caught as HTTPException).message).toBe(message);
    }
  });

  test("returns HTTP 400 for authenticated overflow requests before database work", async () => {
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const accountId = "11111111-1111-4111-8111-111111111111";
    const delegationSecret = "insights-filter-validation-secret";
    const authorization = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: "user:insights-filter-validation",
      permissions: ["workspace:admin"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}`;
    const app = new Hono();
    registerInsightsRoutes(app, {
      settings: testSettings({ productAccessMode: "managed", delegationSecret }),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("invalid Insights filter touched the database");
          },
        },
      ),
    } as unknown as ApiRouteDeps);

    const cases = [
      ["provider", "p".repeat(257), "provider must be at most 256 UTF-8 bytes"],
      ["model", "m".repeat(513), "model must be at most 512 UTF-8 bytes"],
      ["provider", `${"é".repeat(127)}aaa`, "provider must be at most 256 UTF-8 bytes"],
      ["model", `${"é".repeat(255)}aaa`, "model must be at most 512 UTF-8 bytes"],
    ] as const;
    for (const [field, value, message] of cases) {
      const response = await app.request(
        `http://x/v1/workspaces/${workspaceId}/insights?${field}=${encodeURIComponent(value)}`,
        { headers: { authorization } },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(message);
    }
  });

  test("is registered on the API app and access-key catalog", () => {
    expect(appSrc).toContain("registerInsightsRoutes(app, routeDeps)");
    expect(appSrc).toContain('label: "/v1/workspaces/:workspaceId/insights"');
  });

  test("does not accept sessions:read as sufficient", () => {
    expect(routesSrc.includes('"sessions:read"')).toBe(false);
    expect(routesSrc.includes('"workspace:read"')).toBe(false);
  });

  test("records bounded route timing across success and failure without changing the response", () => {
    const timerAt = routesSrc.indexOf("const startedAtMs = performance.now()");
    const grantAt = routesSrc.indexOf(
      'requireAccessGrant(c, deps, workspaceId, "workspace:admin")',
    );
    const responseAt = routesSrc.indexOf("WorkspaceInsightsResponse.parse(response)", grantAt);
    const finallyAt = routesSrc.indexOf("} finally {", responseAt);
    const observeAt = routesSrc.indexOf("observeRequest({", finallyAt);

    expect(routesSrc).toContain("workspaceInsightsMetricObserver(deps.observability)");
    expect(timerAt).toBeGreaterThanOrEqual(0);
    expect(timerAt).toBeLessThan(grantAt);
    expect(finallyAt).toBeGreaterThan(responseAt);
    expect(observeAt).toBeGreaterThan(finallyAt);
    expect(routesSrc).toContain("providerFiltered: provider !== null");
    expect(routesSrc).toContain("modelFiltered: model !== null");
  });
});
