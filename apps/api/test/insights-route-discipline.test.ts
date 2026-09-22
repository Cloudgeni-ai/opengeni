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
  createInFlightCoalescer,
  normalizeWorkspaceInsightsQueryFilter,
  registerInsightsRoutes,
  workspaceInsightsCoalesceKey,
} from "../src/routes/insights";

const here = dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(resolve(here, "..", "src", "routes", "insights.ts"), "utf8");
const appSrc = readFileSync(resolve(here, "..", "src", "app.ts"), "utf8");

describe("insights route discipline", () => {
  test("requires workspace:admin before aggregating", () => {
    const grantCall = 'requireAccessGrant(c, deps, workspaceId, "workspace:admin")';
    const grantAt = routesSrc.indexOf(grantCall);
    expect(grantAt).toBeGreaterThanOrEqual(0);
    const getAt = routesSrc.indexOf("getWorkspaceInsights(", grantAt);
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
    const phaseMetrics: Array<{ labels?: Record<string, string | number>; value: number }> = [];
    registerInsightsRoutes(app, {
      settings: testSettings({ productAccessMode: "managed", delegationSecret }),
      observability: {
        observeHistogram: (metric: {
          name: string;
          labels?: Record<string, string | number>;
          value: number;
        }) => {
          if (metric.name === "opengeni_workspace_insights_phase_duration_seconds") {
            phaseMetrics.push(metric);
          }
          throw new Error("observer failure must not replace HTTP 400");
        },
      },
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
    expect(phaseMetrics).toHaveLength(cases.length);
    for (const metric of phaseMetrics) {
      expect(metric.labels).toEqual({ phase: "auth", stage: "helper", outcome: "completed" });
      expect(metric.value).toBeGreaterThanOrEqual(0);
    }
  });

  test("failed auth is timed without database reads or analytical helpers", async () => {
    const metrics: Array<{ name: string; labels?: Record<string, string | number> }> = [];
    const app = new Hono();
    registerInsightsRoutes(app, {
      settings: testSettings({ productAccessMode: "managed" }),
      observability: {
        observeHistogram: (metric: { name: string; labels?: Record<string, string | number> }) => {
          metrics.push(metric);
        },
        info: () => undefined,
      },
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("unauthenticated request touched DB");
          },
        },
      ),
    } as unknown as ApiRouteDeps);
    const response = await app.request(
      "http://x/v1/workspaces/22222222-2222-4222-8222-222222222222/insights",
    );
    expect(response.status).toBe(401);
    expect(
      metrics
        .filter((metric) => metric.name === "opengeni_workspace_insights_phase_duration_seconds")
        .map((metric) => metric.labels),
    ).toEqual([{ phase: "auth", stage: "helper", outcome: "failed" }]);
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
  test("identical concurrent reads share one in-flight rollup and settle independently", async () => {
    const coalescer = createInFlightCoalescer<number>();
    let started = 0;
    let release!: (value: number) => void;
    const work = () => {
      started += 1;
      return new Promise<number>((settle) => {
        release = settle;
      });
    };
    const key = workspaceInsightsCoalesceKey({
      workspaceId: "ws",
      range: "week",
      provider: null,
      model: null,
    });
    const first = coalescer.run(key, work);
    const second = coalescer.run(key, work);
    expect(started).toBe(1);
    expect(coalescer.size).toBe(1);
    release(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(coalescer.size).toBe(0);

    const third = coalescer.run(key, work);
    expect(started).toBe(2);
    release(9);
    expect(await third).toBe(9);
  });

  test("distinct workspace, range, or filter keys never share work and failures clear the slot", async () => {
    const coalescer = createInFlightCoalescer<string>();
    const keys = [
      { workspaceId: "a", range: "week", provider: null, model: null },
      { workspaceId: "b", range: "week", provider: null, model: null },
      { workspaceId: "a", range: "today", provider: null, model: null },
      { workspaceId: "a", range: "week", provider: "openai", model: null },
      { workspaceId: "a", range: "week", provider: null, model: "openai" },
    ].map(workspaceInsightsCoalesceKey);
    expect(new Set(keys).size).toBe(keys.length);

    const failing = coalescer.run(keys[0]!, () => Promise.reject(new Error("rollup failed")));
    await expect(failing).rejects.toThrow("rollup failed");
    expect(coalescer.size).toBe(0);
    expect(await coalescer.run(keys[0]!, () => Promise.resolve("fresh"))).toBe("fresh");
  });
});
