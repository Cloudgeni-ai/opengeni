import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as contracts from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { currentSessionRlsActorIdentityKey, withSessionRlsActorContext } from "@opengeni/db";
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
    const validationAt = routesSrc.indexOf(
      'normalizeWorkspaceInsightsQueryFilter(providerRaw, "provider")',
      grantAt,
    );
    const runAt = routesSrc.indexOf("const response = await coalesce.run(", grantAt);
    const getAt = routesSrc.indexOf("getWorkspaceInsights(", runAt);
    const actorAt = routesSrc.indexOf("rlsActor: currentSessionRlsActorIdentityKey()", runAt);
    expect(validationAt).toBeGreaterThan(grantAt);
    expect(runAt).toBeGreaterThan(validationAt);
    expect(actorAt).toBeGreaterThan(runAt);
    expect(getAt).toBeGreaterThan(actorAt);
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

  test("normalizes session scope to a lowercase UUID and rejects anything else", () => {
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(normalizeWorkspaceInsightsQueryFilter(` ${upper} `, "rootSessionId")).toBe(
      upper.toLowerCase(),
    );
    expect(normalizeWorkspaceInsightsQueryFilter(upper, "sessionId")).toBe(upper.toLowerCase());
    expect(normalizeWorkspaceInsightsQueryFilter(" all ", "sessionId")).toBeNull();
    expect(normalizeWorkspaceInsightsQueryFilter("", "rootSessionId")).toBeNull();
    expect(normalizeWorkspaceInsightsQueryFilter(undefined, "rootSessionId")).toBeNull();

    for (const field of ["rootSessionId", "sessionId"] as const) {
      for (const value of ["not-a-uuid", `${upper}0`, "a".repeat(36)]) {
        let caught: unknown;
        try {
          normalizeWorkspaceInsightsQueryFilter(value, field);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(HTTPException);
        expect((caught as HTTPException).status).toBe(400);
        expect((caught as HTTPException).message).toBe(`${field} must be a UUID`);
      }
    }
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
      ["rootSessionId", "not-a-uuid", "rootSessionId must be a UUID"],
      ["sessionId", "not-a-uuid", "sessionId must be a UUID"],
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
      rlsActor: null,
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

  test("distinct workspace, range, filter, or RLS actor keys never share work and failures clear the slot", async () => {
    const coalescer = createInFlightCoalescer<string>();
    const keys = [
      { workspaceId: "a", range: "week", provider: null, model: null, rlsActor: null },
      { workspaceId: "b", range: "week", provider: null, model: null, rlsActor: null },
      { workspaceId: "a", range: "today", provider: null, model: null, rlsActor: null },
      { workspaceId: "a", range: "week", provider: "openai", model: null, rlsActor: null },
      { workspaceId: "a", range: "week", provider: null, model: "openai", rlsActor: null },
      { workspaceId: "a", range: "week", provider: "", model: null, rlsActor: null },
      { workspaceId: "a", range: "week", provider: null, model: null, rlsActor: "admin-a" },
      { workspaceId: "a", range: "week", provider: null, model: null, rlsActor: "admin-b" },
      {
        workspaceId: "a",
        range: "week",
        provider: null,
        model: null,
        rootSessionId: "11111111-1111-4111-8111-111111111111",
        rlsActor: null,
      },
      {
        workspaceId: "a",
        range: "week",
        provider: null,
        model: null,
        sessionId: "11111111-1111-4111-8111-111111111111",
        rlsActor: null,
      },
    ].map(workspaceInsightsCoalesceKey);
    expect(new Set(keys).size).toBe(keys.length);

    const failing = coalescer.run(keys[0]!, () => Promise.reject(new Error("rollup failed")));
    await expect(failing).rejects.toThrow("rollup failed");
    expect(coalescer.size).toBe(0);
    expect(await coalescer.run(keys[0]!, () => Promise.resolve("fresh"))).toBe("fresh");
  });

  describe("coalescing never crosses RLS actors", () => {
    const restores: Array<() => void> = [];
    afterEach(() => {
      for (const restore of restores.splice(0)) restore();
    });

    async function harness() {
      const workspaceId = "22222222-2222-4222-8222-222222222222";
      const accountId = "11111111-1111-4111-8111-111111111111";
      const delegationSecret = "insights-coalescing-actor-secret";
      const authorization = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId,
        workspaceId,
        subjectId: "user:insights-coalescing",
        permissions: ["workspace:admin"],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      })}`;
      // Each rollup sees only its caller's private session, like the real
      // RLS-filtered fact authorities do.
      const observedActors: Array<string | null> = [];
      let releaseAll!: () => void;
      const gate = new Promise<void>((settle) => {
        releaseAll = settle;
      });
      const insights = spyOn(core, "getWorkspaceInsights").mockImplementation(async () => {
        const actor = currentSessionRlsActorIdentityKey();
        observedActors.push(actor);
        await gate;
        return { snapshot: { privateSessionsVisibleTo: actor } } as never;
      });
      const parse = spyOn(contracts.WorkspaceInsightsResponse, "parse").mockImplementation(
        (value: unknown) => value as never,
      );
      restores.push(
        () => insights.mockRestore(),
        () => parse.mockRestore(),
      );
      const app = new Hono();
      registerInsightsRoutes(app, {
        settings: testSettings({ productAccessMode: "managed", delegationSecret }),
        observability: undefined,
        db: {},
      } as unknown as ApiRouteDeps);
      const request = (subjectId: string) =>
        withSessionRlsActorContext({ subjectId }, async () => {
          const response = await app.request(
            `http://x/v1/workspaces/${workspaceId}/insights?range=week`,
            { headers: { authorization } },
          );
          expect(response.status).toBe(200);
          return (await response.json()) as { snapshot: { privateSessionsVisibleTo: string } };
        });
      return { request, releaseAll, observedActors, insights };
    }

    test("two admins requesting concurrently each receive their own visibility", async () => {
      const { request, releaseAll, observedActors, insights } = await harness();
      const adminA = request("user:admin-a");
      const adminB = request("user:admin-b");
      await Promise.resolve();
      await new Promise((settle) => setTimeout(settle, 10));
      releaseAll();
      const [a, b] = await Promise.all([adminA, adminB]);
      expect(insights).toHaveBeenCalledTimes(2);
      expect(new Set(observedActors).size).toBe(2);
      expect(a.snapshot.privateSessionsVisibleTo).toContain("user:admin-a");
      expect(a.snapshot.privateSessionsVisibleTo).not.toContain("user:admin-b");
      expect(b.snapshot.privateSessionsVisibleTo).toContain("user:admin-b");
      expect(b.snapshot.privateSessionsVisibleTo).not.toContain("user:admin-a");
    });

    test("the same admin reloading concurrently joins the running rollup", async () => {
      const { request, releaseAll, insights } = await harness();
      const first = request("user:admin-a");
      const second = request("user:admin-a");
      await new Promise((settle) => setTimeout(settle, 10));
      releaseAll();
      const [one, two] = await Promise.all([first, second]);
      expect(insights).toHaveBeenCalledTimes(1);
      expect(one).toEqual(two);
      expect(one.snapshot.privateSessionsVisibleTo).toContain("user:admin-a");
    });
  });
});
