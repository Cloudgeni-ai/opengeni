import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessContext, type Permission } from "@opengeni/contracts";
import type {
  InsightsUsageMeasures,
  InsightsUsageResponse,
} from "@opengeni/contracts/insights-usage";
import * as core from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { currentSessionRlsActorIdentityKey, withSessionRlsActorContext } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import {
  insightsQueryParameters,
  insightsUsageCoalesceKey,
  organizationInsightsScope,
  registerInsightsUsageRoutes,
} from "../src/routes/insights-usage";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const secret = "unified-insights-route-tests";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function token(permissions: Permission[], subjectId = "user:insights-reader") {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

function appFor() {
  const app = new Hono();
  // The production API provides this actor middleware before workspace routes.
  app.use("/v1/workspaces/:workspaceId/*", async (_c, next) =>
    withSessionRlsActorContext({ subjectId: "user:workspace-reader" }, next),
  );
  registerInsightsUsageRoutes(app, {
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("route test touched database");
        },
      },
    ),
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
  } as unknown as ApiRouteDeps);
  return app;
}

function emptyMeasures(): InsightsUsageMeasures {
  return {
    calls: 0,
    tokenKnownCalls: 0,
    cacheKnownCalls: 0,
    cacheWriteKnownCalls: 0,
    listClassKnownCalls: 0,
    pricedCalls: 0,
    chargedMicros: 0,
    listMicros: 0,
    listByClassMicros: null,
    listByClassApprox: false,
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    byPayer: {
      opengeni_credits: { calls: 0, chargedMicros: 0, listMicros: 0 },
      subscription: { calls: 0, chargedMicros: 0, listMicros: 0 },
      own_key: { calls: 0, chargedMicros: 0, listMicros: 0 },
    },
  };
}

function responseFor(input: Parameters<typeof core.getInsightsUsage>[1]): InsightsUsageResponse {
  return {
    scope:
      input.workspaceId === null
        ? { kind: "organization", accountId, workspaceId: null }
        : { kind: "workspace", accountId, workspaceId: input.workspaceId },
    range: input.query.range,
    windowStart: "2026-10-01T00:00:00.000Z",
    windowEnd: "2026-10-03T10:42:00.000Z",
    priorWindowStart: "2026-09-28T13:18:00.000Z",
    priorWindowEnd: "2026-10-01T00:00:00.000Z",
    bucket: input.query.range === "today" ? "hour" : "day",
    generatedAt: "2026-10-03T10:42:00.000Z",
    dataThrough: null,
    totals: emptyMeasures(),
    prior: null,
    groupBy: input.query.groupBy,
    groups: [],
    groupCount: 0,
    groupsTruncated: false,
    series: [],
    facets: {
      workspaces: [],
      providers: [],
      models: [],
      payers: [],
      projects: [],
      people: [],
      schedules: [],
    },
  };
}

describe("unified Insights route discipline", () => {
  test("registers all four endpoints and bounded route labels", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(app).toContain("registerInsightsUsageRoutes(app, routeDeps)");
    for (const scope of ["workspaces/:workspaceId", "organizations/:accountId"]) {
      for (const leaf of ["usage", "calls"]) {
        expect(app).toContain(`label: "/v1/${scope}/insights/${leaf}"`);
      }
    }
  });

  test("preserves repeated filters and rejects repeated scalar options through the schema", () => {
    expect(insightsQueryParameters({ provider: ["anthropic", "openai"], range: ["90d"] })).toEqual({
      provider: ["anthropic", "openai"],
      range: "90d",
    });
    expect(insightsQueryParameters({ range: ["week", "today"] })).toEqual({
      range: ["week", "today"],
    });
  });

  test("requires the existing scope permission before any query or database work", async () => {
    const app = appFor();
    for (const path of [
      `/v1/workspaces/${workspaceId}/insights/usage`,
      `/v1/workspaces/${workspaceId}/insights/calls`,
      `/v1/organizations/${accountId}/insights/usage`,
      `/v1/organizations/${accountId}/insights/calls`,
    ]) {
      expect((await app.request(`http://x${path}?range=bad`)).status).toBe(401);
      expect(
        (
          await app.request(`http://x${path}?range=bad`, {
            headers: { authorization: await token(["workspace:read"]) },
          })
        ).status,
      ).toBe(403);
    }
    const wrongAccount = crypto.randomUUID();
    expect(
      (
        await app.request(`http://x/v1/organizations/${wrongAccount}/insights/usage`, {
          headers: { authorization: await token(["billing:read"]) },
        })
      ).status,
    ).toBe(403);
  });

  test("rejects unknown, repeated scalar, invalid model and workspace-scope filters before a reader", async () => {
    const app = appFor();
    const authorization = await token(["workspace:admin", "billing:read"]);
    for (const query of [
      "range=week&range=today",
      "seriesGroups=0",
      "model=bare-model",
      "limit=201",
      "subjectId=user:spoofed",
      `workspaceId=${workspaceId}`,
      "groupBy=workspace",
    ]) {
      expect(
        (
          await app.request(`http://x/v1/workspaces/${workspaceId}/insights/usage?${query}`, {
            headers: { authorization },
          })
        ).status,
      ).toBe(400);
    }
    for (const leaf of ["usage", "calls"]) {
      expect(
        (
          await app.request(
            `http://x/v1/organizations/${accountId}/insights/${leaf}?initiatingHumanSubjectId=user:spoofed`,
            {
              headers: { authorization },
            },
          )
        ).status,
      ).toBe(400);
    }
  });

  test("passes normalized filters, scope and literal false to usage; results are never publicly cached", async () => {
    const read = spyOn(core, "getInsightsUsage").mockImplementation(async (_db, input) =>
      responseFor(input),
    );
    spies.push(read);
    const app = appFor();
    const result = await app.request(
      `http://x/v1/workspaces/${workspaceId}/insights/usage?range=90d&provider=anthropic,%20openai&provider=anthropic&model=openrouter/vendor/model&seriesGroups=false`,
      { headers: { authorization: await token(["workspace:admin"]) } },
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(read.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId,
      detailsWorkspaceIds: [workspaceId],
      query: {
        range: "90d",
        provider: ["anthropic", "openai", "anthropic"],
        model: ["openrouter/vendor/model"],
        seriesGroups: false,
        groupBy: "model",
        limit: 50,
      },
    });
    expect((await result.json()).prior).toBeNull();
  });

  test("malformed calls cursors return 400 in both scopes before database access", async () => {
    const app = appFor();
    const authorization = await token(["workspace:admin", "billing:read"]);
    for (const scope of [`workspaces/${workspaceId}`, `organizations/${accountId}`]) {
      const result = await app.request(
        `http://x/v1/${scope}/insights/calls?range=week&cursor=not_base64`,
        {
          headers: { authorization },
        },
      );
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain(workspaceId);
    }
  });

  test("organization reads bind the verified subject without manufacturing a human initiator", async () => {
    const actors: Array<string | null> = [];
    const usage = spyOn(core, "getInsightsUsage").mockImplementation(async (_db, input) => {
      actors.push(currentSessionRlsActorIdentityKey());
      return responseFor(input);
    });
    const calls = spyOn(core, "listInsightsCalls").mockImplementation(async () => {
      actors.push(currentSessionRlsActorIdentityKey());
      return { calls: [], nextCursor: null };
    });
    spies.push(usage, calls);
    const app = appFor();
    for (const leaf of ["usage", "calls"]) {
      const result = await app.request(
        `http://x/v1/organizations/${accountId}/insights/${leaf}?range=30d&workspaceId=${workspaceId}`,
        {
          headers: { authorization: await token(["billing:read"], "user:verified-billing") },
        },
      );
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(actors).toEqual([
      JSON.stringify(["user:verified-billing", null, null, null]),
      JSON.stringify(["user:verified-billing", null, null, null]),
    ]);
    expect(usage.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId: null,
      detailsWorkspaceIds: [],
      detailsSharedWorkspaces: false,
      query: { workspaceId: [workspaceId] },
    });
    expect(calls.mock.calls[0]![1]).toMatchObject({
      accountId,
      workspaceId: null,
      detailsWorkspaceIds: [],
      detailsSharedWorkspaces: false,
      query: { workspaceId: [workspaceId] },
    });
  });

  test("metadata authority requires same-actor workspace read grants, not account or credential claims", () => {
    const context: AccessContext = {
      mode: "managed",
      subjectId: "user:reader",
      accountGrants: [{ accountId, subjectId: "user:reader", permissions: ["account:admin"] }],
      workspaceGrants: [
        { accountId, workspaceId, subjectId: "user:reader", permissions: ["billing:read"] },
        {
          accountId,
          workspaceId: crypto.randomUUID(),
          subjectId: "user:other",
          permissions: ["workspace:admin"],
        },
        {
          accountId: crypto.randomUUID(),
          workspaceId: crypto.randomUUID(),
          subjectId: "user:reader",
          permissions: ["sessions:read"],
        },
      ],
      defaultAccountId: accountId,
      defaultWorkspaceId: workspaceId,
      credential: {
        kind: "organization_api_key",
        access: "full",
        accountId,
        workspaceId: null,
        effectiveWorkspacePermissions: ["workspace:admin"],
        note: "Informational only",
      },
    };
    expect(organizationInsightsScope(context, accountId)).toEqual({
      accountId,
      workspaceId: null,
      detailsWorkspaceIds: [],
      detailsSharedWorkspaces: false,
    });
    context.workspaceGrants[0]!.permissions = ["sessions:read"];
    expect(organizationInsightsScope(context, accountId).detailsWorkspaceIds).toEqual([
      workspaceId,
    ]);
    context.workspaceGrants[0]!.permissions = ["workspace:admin"];
    expect(organizationInsightsScope(context, accountId).detailsWorkspaceIds).toEqual([
      workspaceId,
    ]);
    context.workspaceGrants[0]!.permissionMode = "explicit";
    expect(organizationInsightsScope(context, accountId).detailsWorkspaceIds).toEqual([]);
    context.workspaceGrants[0]!.permissions.push("sessions:read");
    expect(organizationInsightsScope(context, accountId).detailsWorkspaceIds).toEqual([
      workspaceId,
    ]);
  });

  test("same-subject billing-only and readable-workspace requests do not share in-flight results", async () => {
    const pending: Array<() => void> = [];
    const read = spyOn(core, "getInsightsUsage").mockImplementation(async (_db, input) => {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === 2) for (const release of pending) release();
      });
      return responseFor(input);
    });
    spies.push(read);
    const app = appFor();
    const [billing, readable] = await Promise.all([
      token(["billing:read"], "user:same-actor"),
      token(["billing:read", "sessions:read"], "user:same-actor"),
    ]);
    const results = await Promise.all(
      [billing, readable].map((authorization) =>
        app.request(`http://x/v1/organizations/${accountId}/insights/usage?range=month`, {
          headers: { authorization },
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls.map(([, input]) => input.detailsWorkspaceIds)).toEqual(
      expect.arrayContaining([[], [workspaceId]]),
    );
  });

  test("sharing keys distinguish actors, scopes, every filter and calls cursors", () => {
    const scope = { accountId, workspaceId };
    const baseline = insightsUsageCoalesceKey(scope, { range: "week", provider: ["a"] }, "actor:a");
    for (const candidate of [
      insightsUsageCoalesceKey(scope, { range: "week", provider: ["a"] }, "actor:b"),
      insightsUsageCoalesceKey(
        { ...scope, workspaceId: null },
        { range: "week", provider: ["a"] },
        "actor:a",
      ),
      insightsUsageCoalesceKey(scope, { range: "90d", provider: ["a"] }, "actor:a"),
      insightsUsageCoalesceKey(scope, { range: "week", provider: ["b"] }, "actor:a"),
      insightsUsageCoalesceKey(
        { ...scope, detailsWorkspaceIds: [workspaceId] },
        { range: "week", provider: ["a"] },
        "actor:a",
      ),
      insightsUsageCoalesceKey(
        { ...scope, detailsSharedWorkspaces: true },
        { range: "week", provider: ["a"] },
        "actor:a",
      ),
      insightsUsageCoalesceKey(
        scope,
        { range: "week", provider: ["a"], cursor: "page2" },
        "actor:a",
      ),
    ])
      expect(candidate).not.toBe(baseline);
  });
});
