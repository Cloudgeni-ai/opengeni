import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as realDb from "@opengeni/db";
import * as realCore from "@opengeni/core";
import { SubscriptionUsagePoolsResponse } from "@opengeni/contracts";
import { buildSubscriptionUsagePool } from "@opengeni/subscriptions";

let authorized = true;
let personal = false;
const calls: Array<Record<string, unknown>> = [];
mock.module("@opengeni/db", () => ({
  ...realDb,
  resolveNamedManagedPersonalWorkspaceGrant: async () => (personal ? {} : null),
  readSubscriptionUsagePool: async (_db: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    return { provider: input.provider, observedAt: null, windows: [] };
  },
}));
mock.module("@opengeni/core", () => ({
  ...realCore,
  requireAccessGrant: async (
    _c: unknown,
    _deps: unknown,
    workspaceId: string,
    permission: string,
  ) => {
    if (!authorized) throw new HTTPException(403);
    expect(permission).toBe("workspace:read");
    return { accountId: "org", subjectId: "user:viewer", workspaceId };
  },
}));
mock.module("../src/routes/codex", () => ({
  requireOrganizationCodexHuman: async () => {
    if (!authorized) throw new HTTPException(403);
    return { subjectId: "user:admin" };
  },
}));
mock.module("../src/routes/subscription-pool-core", () => ({
  requireSubscriptionCoreRoute: async () => "core",
}));
mock.module("../src/routes/subscription-pool-access", () => ({
  requirePrivateSubscriptionHuman: async () => {
    if (personal) throw new HTTPException(401);
  },
}));
const { registerSubscriptionUsagePoolRoutes } =
  await import("../src/routes/subscription-usage-pool");
const app = new Hono();
registerSubscriptionUsagePoolRoutes(app, {
  db: {},
  settings: { claudeSubscriptionEnabled: true, supergrokSubscriptionEnabled: false },
} as never);
beforeEach(() => {
  authorized = true;
  personal = false;
  calls.length = 0;
});

test("refuses unauthorized organization and workspace reads before accessing histories", async () => {
  authorized = false;
  for (const path of ["organizations/org", "workspaces/workspace"]) {
    expect((await app.request(`/v1/${path}/subscription-usage-pools`)).status).toBe(403);
  }
  expect(calls).toEqual([]);
});
test("organization read includes only enabled providers under the admin identity", async () => {
  expect((await app.request("/v1/organizations/org/subscription-usage-pools")).status).toBe(200);
  expect(calls).toEqual(
    ["codex", "claude"].map((provider) => ({
      accountId: "org",
      workspaceId: null,
      subjectId: "user:admin",
      provider,
    })),
  );
});
test("workspace read binds every provider to the granted workspace and viewer", async () => {
  const response = await app.request("/v1/workspaces/workspace/subscription-usage-pools");
  expect(response.status).toBe(200);
  expect(calls).toEqual(
    ["codex", "claude"].map((provider) => ({
      accountId: "org",
      workspaceId: "workspace",
      subjectId: "user:viewer",
      provider,
    })),
  );
  expect(await response.json()).toMatchObject({ pools: [] });
});
test("personal telemetry keeps the owning-human account-list fence", async () => {
  personal = true;
  expect((await app.request("/v1/workspaces/workspace/subscription-usage-pools")).status).toBe(401);
  expect(calls).toEqual([]);
});

test("a full pool with fractional capacity weights passes the bounded response schema", () => {
  const now = Date.now();
  const pool = buildSubscriptionUsagePool({
    provider: "codex",
    now,
    historyStart: null,
    readings: [],
    calls: [],
    accounts: [9 / 31, 1, 69 / 31].map((planWeight, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      label: `Account ${index}`,
      plan: null,
      planWeight,
      windows: [
        { id: "weekly" as const, usedPercent: 0, observedAt: now, resetsAt: now + 86_400_000 },
      ],
    })),
  });
  const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
  const response = {
    checkedAt: iso(now),
    pools: [
      {
        ...pool,
        observedAt: iso(pool.observedAt),
        windows: pool.windows.map((window) => ({
          ...window,
          accounts: window.accounts.map((account) => ({
            ...account,
            observedAt: iso(account.observedAt),
            resetsAt: iso(account.resetsAt),
          })),
          forecast: {
            ...window.forecast,
            runsOutAt: iso(window.forecast.runsOutAt),
            nextResetAt: iso(window.forecast.nextResetAt),
          },
        })),
      },
    ],
  };
  expect(
    SubscriptionUsagePoolsResponse.parse(response).pools[0]!.windows.find(
      (window) => window.id === "weekly",
    )!.remainingPercent,
  ).toBe(100);
});
