import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  codexAppsRequestAuthForDesignation,
  resolveCodexAppsCredentialIdForRun,
  resolveCodexAppsDesignationForRun,
  stampDelegatedHumanAuthorization,
} from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";
import { codexAccountJson } from "../src/routes/codex";

// Codex routes on the shared core. db accessors are spied.

const DELEGATION_SECRET = "codex-core-routes-delegation-secret";
const WS = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c3";
const CONNECTION = "11111111-0000-4000-8000-000000000001";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
  codexSubscriptionEnabled: true,
  codexConnectedAppsEnabled: true,
});

const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched on these route paths");
    },
  },
);

const wakes: unknown[] = [];
function app() {
  return createApp({
    settings,
    db: poisonDb as never,
    bus: { publish: async () => undefined } as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubStateSecret: "codex-core-routes-state-secret",
  } as never);
}

async function bearer(permissions: Permission[], subjectId = "tester"): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: ACCOUNT,
    workspaceId: WS,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

const account = {
  id: CONNECTION,
  source: "organization",
  chatgptAccountId: "chatgpt-core",
  label: "Core account",
  accountEmail: "core@example.test",
  planType: "pro",
  planCheckedAt: null,
  planPreviousType: null,
  planChangedAt: null,
  planEntitlementExclusion: null,
  status: "active",
  allocatorEnabled: true,
  allocatorVersion: 3,
  allocatorUpdatedBySubjectId: null,
  allocatorUpdatedAt: null,
  resetCreditAvailableCount: null,
  resetCreditsCheckedAt: null,
  connectedBySubjectId: null,
  isActive: true,
  expiresAt: null,
  lastRefreshAt: null,
  lastError: null,
  primaryUsedPercent: 12,
  primaryResetAt: null,
  secondaryUsedPercent: 30,
  secondaryResetAt: null,
  usageCheckedAt: null,
  exhaustedUntil: null,
  exhaustedKind: null,
} satisfies opengeniDb.CodexAccountStatus;

const projection = {
  accounts: [account],
  rotation: { activeCredentialId: CONNECTION, rotationEnabled: false, rotationStrategy: "sharded" },
  source: {
    accountId: ACCOUNT,
    workspaceId: WS,
    workspaceKind: "shared" as const,
    mode: "automatic" as const,
    effectiveSource: "organization" as const,
    workspaceAvailable: false,
    organizationAvailable: true,
  },
};

const restores: Array<() => void> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  wakes.length = 0;
  globalThis.fetch = realFetch;
  while (restores.length) restores.pop()!();
});

function mock<K extends keyof typeof opengeniDb>(name: K, impl: (...args: never[]) => unknown) {
  const spy = spyOn(opengeniDb, name as never).mockImplementation(impl as never);
  restores.push(() => (spy as { mockRestore(): void }).mockRestore());
  return spy as unknown as { mock: { calls: unknown[][] } };
}

/** The device-code endpoints the connect routes call. */
function mockDevice(handlers: {
  usercode?: () => Response;
  token?: () => Response;
  exchange?: () => Response;
}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/deviceauth/usercode") && handlers.usercode) return handlers.usercode();
    if (url.includes("/deviceauth/token") && handlers.token) return handlers.token();
    if (url.includes("/oauth/token") && handlers.exchange) return handlers.exchange();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function coreRoutes() {
  mock("buildCodexTokenResolver", async () => {
    throw new Error("legacy Codex token resolver must not run");
  });
  mock("deliverSubscriptionCoreCodexWake", async (_db: never, wake: never) => {
    wakes.push(wake);
  });
}

describe("Codex Apps designation authenticates before reading organization state", () => {
  test("unauthenticated and bearer callers are refused", async () => {
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", authorization: await bearer(["connections:write"]) },
    ]) {
      const response = await app().request(`/v1/workspaces/${WS}/codex/apps`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: CONNECTION, expectedVersion: 0 }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
  });
});

describe("Codex routes on the shared core", () => {
  test("GET accounts keeps the legacy shape, projected from the core", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    mock("getSubscriptionCoreCodexAppsSettings", async () => ({
      credentialId: CONNECTION,
      version: 2,
      designatedAt: new Date("2026-10-08T00:00:00Z"),
    }));
    const response = await app().request(`/v1/workspaces/${WS}/codex/accounts`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      ["accounts", "activeAccountId", "apps", "settings", "source"].sort(),
    );
    expect(body.accounts[0]).toMatchObject({
      id: CONNECTION,
      source: "organization",
      chatgptAccountId: "chatgpt-core",
      email: "core@example.test",
      plan: "pro",
      active: true,
      allocatorEnabled: true,
      allocatorVersion: 3,
      appsDesignated: true,
      canEnableApps: false,
      fiveHour: expect.anything(),
    });
    expect(body.apps).toMatchObject({ available: true, credentialId: CONNECTION, version: 2 });
    expect(body.settings).toEqual({
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: CONNECTION,
    });
  });

  test("GET status reports core readiness without a live provider probe", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    const response = await app().request(`/v1/workspaces/${WS}/codex/status`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "accountCount",
        "activeAccount",
        "activeAccountValid",
        "connected",
        "expiresAt",
        "lastError",
        "models",
        "plan",
        "poolReady",
        "source",
        "valid",
        "workerRoutable",
      ].sort(),
    );
    expect(body).toMatchObject({
      connected: true,
      plan: "pro",
      poolReady: true,
      workerRoutable: true,
      activeAccount: { id: CONNECTION, label: "Core account" },
      accountCount: 1,
    });
  });

  test("per-account credit consent writes use their own revision and wake placement", async () => {
    coreRoutes();
    const consent = mock("setSubscriptionCoreCodexExtraCredits", async () => ({
      result: {
        kind: "updated",
        extraCreditsEnabled: true,
        extraCreditsVersion: 2,
        extraCreditsUpdatedAt: null,
      },
      wake: { accountId: ACCOUNT, reason: "core_codex_extra_credits_changed" },
    }));
    const response = await app().request(
      `/v1/workspaces/${WS}/codex/accounts/${CONNECTION}/extra-credits`,
      {
        method: "PATCH",
        headers: {
          authorization: await bearer(["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true, expectedVersion: 1 }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      changed: true,
      extraCreditsEnabled: true,
      extraCreditsVersion: 2,
      extraCreditsUpdatedAt: null,
    });
    expect(consent.mock.calls[0]![1]).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WS,
      connectionId: CONNECTION,
      subjectId: "tester",
      enabled: true,
      expectedVersion: 1,
    });
    expect(wakes).toEqual([{ accountId: ACCOUNT, reason: "core_codex_extra_credits_changed" }]);
  });

  test("allocator and source writes go to the core and wake waiters", async () => {
    coreRoutes();
    const allocator = mock("setSubscriptionCoreCodexAllocator", async () => ({
      result: {
        kind: "updated",
        allocatorEnabled: false,
        allocatorVersion: 4,
        allocatorUpdatedAt: null,
      },
      wake: { accountId: ACCOUNT, reason: "core_codex_allocator_changed" },
    }));
    const response = await app().request(
      `/v1/workspaces/${WS}/codex/accounts/${CONNECTION}/allocator`,
      {
        method: "PATCH",
        headers: {
          authorization: await bearer(["connections:write"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false, expectedVersion: 3 }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allocatorEnabled: false,
      allocatorVersion: 4,
      allocatorUpdatedAt: null,
      changed: true,
    });
    expect(allocator.mock.calls[0]![1]).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "tester",
      connectionId: CONNECTION,
      enabled: false,
      expectedVersion: 3,
    });
    expect(wakes).toEqual([{ accountId: ACCOUNT, reason: "core_codex_allocator_changed" }]);

    mock("setSubscriptionCoreWorkspaceCodexSource", async () => ({
      source: { ...projection.source, mode: "workspace", effectiveSource: "workspace" },
      wake: { accountId: ACCOUNT, reason: "core_codex_source_changed", workspaceIds: [WS] },
    }));
    const source = await app().request(`/v1/workspaces/${WS}/codex/source`, {
      method: "PATCH",
      headers: {
        authorization: await bearer(["connections:write"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "workspace" }),
    });
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ mode: "workspace", effectiveSource: "workspace" });
    expect(wakes).toHaveLength(2);
  });

  test("a sign-in started on one API replica polls on another", async () => {
    coreRoutes();
    // Two independent processes configured like a real deployment: no
    // explicit manifest state secret, only the shared deployment secrets.
    const replica = () =>
      createApp({
        settings: {
          ...settings,
          githubAppManifestStateSecret: undefined,
          integrationsStateSecret: "shared-integrations-state-secret",
        },
        db: poisonDb as never,
        bus: { publish: async () => undefined } as never,
        workflowClient: {} as never,
        managedAuth: null,
      } as never);
    const headers = {
      authorization: await bearer(["workspace:read", "connections:write"]),
      "content-type": "application/json",
    };
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
      token: () => json({}, 403),
    });
    const started = await replica().request(`/v1/workspaces/${WS}/codex/connect/start`, {
      method: "POST",
      headers,
    });
    expect(started.status).toBe(200);
    const { state } = (await started.json()) as { state: string };
    const polled = await replica().request(`/v1/workspaces/${WS}/codex/connect/poll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ state }),
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({ status: "pending" });
  });

  test("connect start and poll write through the core writer (M3 PR 3b)", async () => {
    coreRoutes();
    const headers = {
      authorization: await bearer(["workspace:read", "connections:write"]),
      "content-type": "application/json",
    };
    mockDevice({
      usercode: () => json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" }),
    });
    const started = await app().request(`/v1/workspaces/${WS}/codex/connect/start`, {
      method: "POST",
      headers,
    });
    expect(started.status).toBe(200);
    const { state } = (await started.json()) as { state: string };
    const swapped = await app().request(`/v1/workspaces/${WS}/codex/connect/poll`, {
      method: "POST",
      headers: { ...headers, authorization: await bearer(["connections:write"], "another-person") },
      body: JSON.stringify({ state }),
    });
    expect(swapped.status).toBe(400);
    const signIn = () =>
      mockDevice({
        token: () => json({ authorization_code: "authorization-code", code_verifier: "verifier" }),
        exchange: () =>
          json({
            id_token: jwt({
              email: "core@example.test",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "chatgpt-core",
                chatgpt_plan_type: "pro",
              },
            }),
            access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: "refresh-token",
          }),
      });
    let result: unknown = {
      kind: "connected",
      id: CONNECTION,
      isNew: true,
      ownership: "shared",
      wake: { accountId: ACCOUNT, reason: "core_codex_connected", workspaceIds: [WS] },
    };
    const writer = mock("connectSubscriptionCoreCodexConnection", async () => result);
    mock("deliverSubscriptionCoreCodexWake", async (_db: never, wake: never) => {
      wakes.push(wake);
    });
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    const poll = async () => {
      signIn();
      return await app().request(`/v1/workspaces/${WS}/codex/connect/poll`, {
        method: "POST",
        headers,
        body: JSON.stringify({ state }),
      });
    };
    const connected = await poll();
    expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({
      status: "connected",
      plan: "pro",
      accountId: CONNECTION,
      isActive: true,
    });
    const call = writer.mock.calls[0]![1] as Record<string, unknown>;
    // The grant's own subject decides authority in the database.
    expect(call).toMatchObject({
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "tester",
      providerAccountId: "chatgpt-core",
      planType: "pro",
      accountEmail: "core@example.test",
      connectedBySubjectId: null,
    });
    // Only the encrypted envelope crosses the boundary.
    expect(String(call.credentialEncrypted)).not.toContain("refresh-token");
    expect(wakes).toHaveLength(1);
    for (const [reason, status] of [
      ["forbidden", 403],
      ["managed_elsewhere", 409],
      ["identity_unverified", 409],
      ["personal_connections_disabled", 409],
      ["unavailable", 503],
    ] as const) {
      result = { kind: "refused", reason };
      const refused = await poll();
      expect({ reason, status: refused.status }).toEqual({ reason, status });
      // A workspace's administrators may connect its own accounts (SUB-OWN-09),
      // so a refusal on a workspace route names both kinds of administrator.
      if (reason === "forbidden") {
        expect(await refused.text()).toContain(
          "only an administrator of this workspace or of the organization can connect a Codex account here",
        );
      }
    }
  });

  test("disconnect one and all map every core outcome (M3 PR 3b)", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    mock("deliverSubscriptionCoreCodexWake", async (_db: never, wake: never) => {
      wakes.push(wake);
    });
    const headers = { authorization: await bearer(["workspace:read", "connections:write"]) };
    let outcome: unknown = "removed";
    const one = mock(
      "disconnectSubscriptionCoreCodexConnection",
      async (_db: never, input: never) => {
        if (outcome === "organization") {
          throw new opengeniDb.SubscriptionCoreCodexOrganizationManagedError();
        }
        return {
          outcome,
          connectionId: (input as { connectionId: string }).connectionId,
          clearedAppsWorkspaceIds: [],
          wake:
            outcome === "removed"
              ? { accountId: ACCOUNT, reason: "core_codex_disconnected" }
              : null,
        };
      },
    );
    const aliased = "22222222-0000-4000-8000-000000000002";
    for (const id of [CONNECTION, aliased]) {
      outcome = "removed";
      const removed = await app().request(`/v1/workspaces/${WS}/codex/accounts/${id}`, {
        method: "DELETE",
        headers,
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ disconnected: true, newActiveId: CONNECTION });
      // The route id (canonical or a legacy alias) is resolved by the database.
      // The person's delegated token is audited as the app.
      expect(one.mock.calls.at(-1)![1]).toEqual({
        accountId: ACCOUNT,
        workspaceId: WS,
        subjectId: "tester",
        connectionId: id,
        audit: {
          subjectId: "tester",
          source: "app",
          principalKind: "human_session",
          via: "delegated_token",
        },
      });
    }
    for (const [next, status] of [
      ["not_found", 200],
      ["forbidden", 403],
      ["unresolved_redemption", 409],
      ["in_use", 409],
      ["organization", 409],
    ] as const) {
      outcome = next;
      const response = await app().request(`/v1/workspaces/${WS}/codex/accounts/${CONNECTION}`, {
        method: "DELETE",
        headers,
      });
      expect({ next, status: response.status }).toEqual({ next, status });
    }

    let all: unknown = {
      removed: 2,
      refused: null,
      clearedAppsWorkspaceIds: [],
      wake: { accountId: ACCOUNT, reason: "core_codex_disconnected" },
    };
    const disconnectAll = mock("disconnectAllSubscriptionCoreCodexConnections", async () => all);
    const removedAll = await app().request(`/v1/workspaces/${WS}/codex`, {
      method: "DELETE",
      headers,
    });
    expect(removedAll.status).toBe(200);
    expect(await removedAll.json()).toEqual({ disconnected: true });
    expect(disconnectAll.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "tester",
      audit: {
        subjectId: "tester",
        source: "app",
        principalKind: "human_session",
        via: "delegated_token",
      },
    });
    for (const [refusal, status] of [
      ["unresolved_redemption", 409],
      ["in_use", 409],
      ["forbidden", 403],
    ] as const) {
      all = {
        removed: 0,
        refused: { outcome: refusal, connectionIds: [CONNECTION] },
        clearedAppsWorkspaceIds: [],
        wake: null,
      };
      const refused = await app().request(`/v1/workspaces/${WS}/codex`, {
        method: "DELETE",
        headers,
      });
      expect({ refusal, status: refused.status }).toEqual({ refusal, status });
    }
  });

  test("a principal without connections:write reaches no writer", async () => {
    coreRoutes();
    for (const name of [
      "connectSubscriptionCoreCodexConnection",
      "disconnectSubscriptionCoreCodexConnection",
      "disconnectAllSubscriptionCoreCodexConnections",
    ] as const) {
      mock(name, async () => {
        throw new Error(`${name} must not run`);
      });
    }
    const headers = { authorization: await bearer(["workspace:read"]) };
    for (const [method, path] of [
      ["POST", "/codex/connect/start"],
      ["POST", "/codex/connect/poll"],
      ["DELETE", `/codex/accounts/${CONNECTION}`],
      ["DELETE", "/codex"],
    ] as const) {
      const response = await app().request(`/v1/workspaces/${WS}${path}`, { method, headers });
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
  });

  test("live usage, per-account usage and refresh read through the core seam", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    mock("resolveSubscriptionCoreCodexConnectionId", async (_db: never, input: never) =>
      (input as { connectionId: string }).connectionId === CONNECTION ? CONNECTION : null,
    );
    const usage = {
      status: "ok" as const,
      planType: "pro",
      fiveHour: null,
      weekly: null,
      limitReached: false,
      fetchedAt: new Date(0).toISOString(),
      rateLimitResetCredits: null,
    };
    const reads = mock("fetchSubscriptionCoreCodexUsage", async () => ({ usage, recovered: true }));
    const headers = { authorization: await bearer(["workspace:read"]) };

    const live = await app().request(`/v1/workspaces/${WS}/codex/usage`, { headers });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok", usage });
    const one = await app().request(`/v1/workspaces/${WS}/codex/accounts/${CONNECTION}/usage`, {
      headers,
    });
    expect(one.status).toBe(200);
    const missing = await app().request(
      `/v1/workspaces/${WS}/codex/accounts/22222222-0000-4000-8000-000000000002/usage`,
      { headers },
    );
    expect(missing.status).toBe(404);
    const refresh = await app().request(`/v1/workspaces/${WS}/codex/usage/refresh`, {
      method: "POST",
      headers,
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual({ usage: { [CONNECTION]: { status: "ok", usage } } });
    // Every read carried the explicit organization/workspace/caller context.
    expect(reads.mock.calls).toHaveLength(3);
    for (const call of reads.mock.calls) {
      expect(call[2]).toEqual({
        kind: "workspace",
        accountId: ACCOUNT,
        workspaceId: WS,
        subjectId: "tester",
      });
      expect(call[3]).toBe(CONNECTION);
    }
    // An ended exhaustion wakes the account's core waiters.
    expect(wakes).toEqual([
      { accountId: ACCOUNT, reason: "usage_recovered" },
      { accountId: ACCOUNT, reason: "usage_recovered" },
      { accountId: ACCOUNT, reason: "usage_recovered" },
    ]);
  });

  test("a failed wake hint never turns a committed usage read into an error", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    mock("deliverSubscriptionCoreCodexWake", async () => {
      throw new Error("wake delivery failed");
    });
    const usage = {
      status: "ok" as const,
      planType: "pro",
      fiveHour: null,
      weekly: null,
      limitReached: false,
      fetchedAt: new Date(0).toISOString(),
      rateLimitResetCredits: null,
    };
    mock("fetchSubscriptionCoreCodexUsage", async () => ({ usage, recovered: true }));
    const headers = { authorization: await bearer(["workspace:read"]) };
    const live = await app().request(`/v1/workspaces/${WS}/codex/usage`, { headers });
    expect(live.status).toBe(200);
    const refresh = await app().request(`/v1/workspaces/${WS}/codex/usage/refresh`, {
      method: "POST",
      headers,
    });
    expect(await refresh.json()).toEqual({ usage: { [CONNECTION]: { status: "ok", usage } } });
  });

  test("the overview settles usage and reset details per account through the core seam", async () => {
    coreRoutes();
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    const usage = {
      status: "ok" as const,
      planType: "pro",
      fiveHour: null,
      weekly: null,
      limitReached: false,
      fetchedAt: new Date(0).toISOString(),
      rateLimitResetCredits: null,
    };
    mock("fetchSubscriptionCoreCodexUsage", async () => ({ usage, recovered: false }));
    const tokens = mock("buildSubscriptionCoreCodexConnectionTokenResolver", () => ({
      getToken: async () => {
        throw new Error("reset details unavailable in this fixture");
      },
      refresh: async () => {
        throw new Error("reset details unavailable in this fixture");
      },
    }));
    const response = await app().request(`/v1/workspaces/${WS}/codex/overview`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accounts: Record<string, Record<string, unknown>> };
    expect(Object.keys(body.accounts)).toEqual([CONNECTION]);
    expect(body.accounts[CONNECTION]).toMatchObject({
      accountId: CONNECTION,
      usage: { source: "provider", value: usage },
      resetCredits: { error: "network_error" },
      // A bearer caller is never a redemption principal on the core.
      canRedeem: false,
      redemptionAccess: { ownership: "managed_human_unavailable" },
    });
    expect(tokens.mock.calls[0]![2]).toEqual({
      kind: "workspace",
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "tester",
    });
  });

  test("the session account view and pin use the core binding", async () => {
    coreRoutes();
    const sessionId = crypto.randomUUID();
    mock("getSessionAuthorizationFacts", async () => ({
      target: {
        sessionId,
        rootSessionId: sessionId,
        visibility: "workspace_shared",
        ownerSubjectId: null,
        slackAccess: null,
      },
      caller: null,
    }));
    const view = mock("getSubscriptionCoreSessionCodexAccounts", async () => ({
      accounts: [account],
      rotation: projection.rotation,
      currentSelection: { waiting: false, credentialId: CONNECTION },
      currentAccount: account,
      pinnedAccountId: CONNECTION,
      lastAccountId: CONNECTION,
    }));
    const response = await app().request(
      `/v1/workspaces/${WS}/sessions/${sessionId}/codex-accounts`,
      { headers: { authorization: await bearer(["workspace:read", "sessions:read"]) } },
    );
    expect(response.status).toBe(200);
    expect(view.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      sessionId,
      // Only the viewer's own personal connection resolves to an account.
      viewerSubjectId: "tester",
    });
    expect(await response.json()).toMatchObject({
      activeAccountId: CONNECTION,
      currentSelection: { waiting: false, credentialId: CONNECTION },
      currentAccount: { id: CONNECTION },
      pinnedAccountId: CONNECTION,
      lastAccountId: CONNECTION,
    });

    const pin = mock("pinSubscriptionCoreSessionCodexAccount", async () => ({
      result: { changed: true, appliedTo: "waiting_turn", events: [] },
      wake: { accountId: ACCOUNT, reason: "core_codex_session_pin_changed", workspaceIds: [WS] },
    }));
    const pinned = await app().request(`/v1/workspaces/${WS}/sessions/${sessionId}/codex-account`, {
      method: "POST",
      headers: {
        authorization: await bearer(["sessions:control"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ target: "auto" }),
    });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ pinned: "auto", appliedTo: "waiting_turn" });
    expect(pin.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      sessionId,
      connectionId: null,
      subjectId: "tester",
    });
    expect(wakes).toEqual([
      { accountId: ACCOUNT, reason: "core_codex_session_pin_changed", workspaceIds: [WS] },
    ]);
    // A refused choice (not eligible for this session) is the legacy 404.
    pin.mock.calls.length = 0;
    mock("pinSubscriptionCoreSessionCodexAccount", async () => ({
      result: { changed: false, appliedTo: "next_turn", events: [] },
      wake: null,
    }));
    const refused = await app().request(
      `/v1/workspaces/${WS}/sessions/${sessionId}/codex-account`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(["sessions:control"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: CONNECTION }),
      },
    );
    expect(refused.status).toBe(404);
  });
});

/** A request an agent makes as the organization administrator (no browser session). */
function organizationAdminRequest(path: string, init: RequestInit = {}): Request {
  // With a declared length the body-limit middleware keeps this Request
  // object, which carries the in-process authorization stamp.
  const request = new Request(`http://opengeni.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(typeof init.body === "string"
        ? { "content-length": String(Buffer.byteLength(init.body)) }
        : {}),
    },
  });
  stampDelegatedHumanAuthorization(request, {
    organizationId: ACCOUNT,
    subjectId: "user:org-admin",
    permissions: ["account:read", "account:admin"] as never,
    workspaceScope: { kind: "all" },
  });
  return request;
}

describe("organization Codex routes", () => {
  function organizationRoutes() {
    coreRoutes();
    // The organization administrator check.
    mock("assertOrganizationCodexAdministrator", async () => undefined);
  }
  const orgPath = `/v1/organizations/${ACCOUNT}/codex`;
  const orgAdmin = { accountId: ACCOUNT, workspaceId: null, subjectId: "user:org-admin" };

  test("organization usage keeps administrator authority outside workspace routing", async () => {
    coreRoutes();
    const administrator = mock("assertOrganizationCodexAdministrator", async () => undefined);
    const payload = {
      status: "ok" as const,
      planType: "pro",
      weekly: null,
      fiveHour: null,
      limitReached: false,
      fetchedAt: new Date().toISOString(),
      credits: {
        hasCredits: true,
        unlimited: false,
        overageLimitReached: false,
        balance: "50.00",
      },
    };
    const usage = mock("fetchOrganizationCodexUsageForAccount", async () => payload);
    const path = `${orgPath}/accounts/${CONNECTION}/usage`;
    const response = await app().fetch(organizationAdminRequest(path));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", usage: payload });
    expect(administrator.mock.calls[0]![1]).toEqual({
      organizationId: ACCOUNT,
      actorSubjectId: "user:org-admin",
    });
    expect(usage.mock.calls[0]![2]).toEqual({
      organizationId: ACCOUNT,
      actorSubjectId: "user:org-admin",
      credentialId: CONNECTION,
    });
    const denied = await app().request(path);
    expect(denied.status).toBe(401);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  test("organization pause uses organization authority and preserves conflict responses", async () => {
    organizationRoutes();
    const allocator = mock("setSubscriptionCoreCodexAllocator", async () => ({
      result: {
        kind: "updated",
        allocatorEnabled: false,
        allocatorVersion: 4,
        allocatorUpdatedAt: null,
      },
      wake: { accountId: ACCOUNT, reason: "core_codex_allocator_changed" },
    }));
    const path = `${orgPath}/accounts/${CONNECTION}/allocator`;
    const response = await app().fetch(
      organizationAdminRequest(path, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false, expectedVersion: 3 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(allocator.mock.calls[0]![1]).toEqual({
      ...orgAdmin,
      connectionId: CONNECTION,
      enabled: false,
      expectedVersion: 3,
    });
    expect(wakes).toEqual([{ accountId: ACCOUNT, reason: "core_codex_allocator_changed" }]);
    mock("setSubscriptionCoreCodexAllocator", async () => ({
      result: {
        kind: "conflict",
        allocatorEnabled: false,
        allocatorVersion: 4,
        allocatorUpdatedAt: null,
      },
      wake: null,
    }));
    const conflict = await app().fetch(
      organizationAdminRequest(path, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true, expectedVersion: 3 }),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ allocatorVersion: 4, changed: false });
    const invalid = await app().fetch(
      organizationAdminRequest(path, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(invalid.status).toBe(400);
    const unauthorized = await app().request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, expectedVersion: 3 }),
    });
    expect(unauthorized.status).toBe(403);
  });

  test("organization disconnect goes to the core writer with no workspace (M3 PR 3b)", async () => {
    organizationRoutes();
    mock("getSubscriptionCoreOrganizationCodexProjection", async () => ({
      accounts: [],
      rotation: { activeCredentialId: null, rotationEnabled: true, rotationStrategy: "sharded" },
    }));
    mock("deliverSubscriptionCoreCodexWake", async () => undefined);
    let outcome = "removed";
    const writer = mock("disconnectSubscriptionCoreCodexConnection", async () => ({
      outcome,
      connectionId: CONNECTION,
      clearedAppsWorkspaceIds: [],
      wake:
        outcome === "removed" ? { accountId: ACCOUNT, reason: "core_codex_disconnected" } : null,
    }));
    const removed = await app().fetch(
      organizationAdminRequest(`${orgPath}/accounts/${CONNECTION}`, { method: "DELETE" }),
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ disconnected: true, newActiveId: null });
    expect(writer.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: null,
      subjectId: "user:org-admin",
      connectionId: CONNECTION,
      // A verified person proof with no more specific dispatch stamp.
      audit: { subjectId: "user:org-admin", source: "agent", principalKind: "delegated_person" },
    });
    outcome = "in_use";
    const busy = await app().fetch(
      organizationAdminRequest(`${orgPath}/accounts/${CONNECTION}`, { method: "DELETE" }),
    );
    expect(busy.status).toBe(409);
  });

  test("accounts, activate, settings and rename go to the core organization row", async () => {
    organizationRoutes();
    const orgProjection = mock("getSubscriptionCoreOrganizationCodexProjection", async () => ({
      accounts: [{ ...account, label: "Renamed" }],
      rotation: projection.rotation,
    }));
    const listed = await app().fetch(organizationAdminRequest(`${orgPath}/accounts`));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      accounts: [{ id: CONNECTION, active: true }],
      activeAccountId: CONNECTION,
      settings: { rotationEnabled: false, activeCredentialId: CONNECTION },
    });
    expect(orgProjection.mock.calls[0]![1]).toEqual({
      organizationId: ACCOUNT,
      subjectId: "user:org-admin",
    });

    const activate = mock("setSubscriptionCoreCodexPrimary", async () => ({
      activated: CONNECTION,
      wake: { accountId: ACCOUNT, reason: "core_codex_primary_changed" },
    }));
    const activated = await app().fetch(
      organizationAdminRequest(`${orgPath}/accounts/${CONNECTION}/activate`, {
        method: "POST",
        body: "{}",
      }),
    );
    expect(activated.status).toBe(200);
    expect(await activated.json()).toEqual({ activated: true, accountId: CONNECTION });
    expect(activate.mock.calls[0]![1]).toEqual({ ...orgAdmin, connectionId: CONNECTION });
    expect(wakes).toEqual([{ accountId: ACCOUNT, reason: "core_codex_primary_changed" }]);

    const rotation = mock("setSubscriptionCoreCodexRotation", async () => ({
      rotation: {
        activeCredentialId: CONNECTION,
        rotationEnabled: false,
        rotationStrategy: "sharded",
      },
      wake: { accountId: ACCOUNT, reason: "core_codex_rotation_changed" },
    }));
    const settingsResponse = await app().fetch(
      organizationAdminRequest(`${orgPath}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ rotationEnabled: false }),
      }),
    );
    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toEqual({
      rotationEnabled: false,
      rotationStrategy: "sharded",
      activeCredentialId: CONNECTION,
    });
    expect(rotation.mock.calls[0]![1]).toEqual({ ...orgAdmin, rotationEnabled: false });

    const rename = mock("renameSubscriptionCoreCodexConnection", async () => CONNECTION);
    // The response reads the renamed account itself: the organization route
    // also renames accounts a shared workspace manages, which its list omits.
    const renamedAccount = mock("getSubscriptionCoreOrganizationCodexAccount", async () => ({
      ...account,
      label: "Renamed",
    }));
    const renamed = await app().fetch(
      organizationAdminRequest(`${orgPath}/accounts/${CONNECTION}`, {
        method: "PATCH",
        body: JSON.stringify({ label: "Renamed" }),
      }),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: CONNECTION, label: "Renamed" });
    expect(rename.mock.calls[0]![1]).toEqual({
      ...orgAdmin,
      connectionId: CONNECTION,
      label: "Renamed",
    });
    expect(renamedAccount.mock.calls[0]![1]).toEqual({
      organizationId: ACCOUNT,
      subjectId: orgAdmin.subjectId,
      connectionId: CONNECTION,
    });

    // A refused account (not an organization account, or not manageable) is the legacy 404.
    mock("setSubscriptionCoreCodexPrimary", async () => ({ activated: null, wake: null }));
    mock("renameSubscriptionCoreCodexConnection", async () => null);
    for (const [method, path, body] of [
      ["POST", `/accounts/${CONNECTION}/activate`, {}],
      ["PATCH", `/accounts/${CONNECTION}`, { label: "x" }],
    ] as const) {
      const refused = await app().fetch(
        organizationAdminRequest(`${orgPath}${path}`, { method, body: JSON.stringify(body) }),
      );
      expect(refused.status).toBe(404);
    }
  });
});

describe("the organization access editor for a workspace-managed Codex account", () => {
  const MANAGER = "00000000-0000-4000-8000-0000000000b2";
  const PERSON = "00000000-0000-4000-8000-0000000000d4";
  const path = `/v1/organizations/${ACCOUNT}/model-connections/codex/${CONNECTION}/access`;
  function editor() {
    coreRoutes();
    mock("assertOrganizationCodexAdministrator", async () => undefined);
    mock("getOrganizationAdministrationOverview", async () => ({
      workspaces: [
        { id: WS, name: "Research" },
        { id: MANAGER, name: "Platform" },
      ],
    }));
    const member = (id: string, subjectId: string, status = "active") => ({
      id,
      organizationId: ACCOUNT,
      subjectId,
      name: subjectId,
      email: null,
      role: "member",
      status,
      authorizationRevision: 1,
      sharedWorkspaceAccess: [],
      revokedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mock("listOrganizationAdministrationMembers", async () => [
      member(PERSON, "user:ada"),
      member("00000000-0000-4000-8000-0000000000d5", "service:robot"),
      member("00000000-0000-4000-8000-0000000000d6", "user:left", "revoked"),
    ]);
  }

  test("reads its reach and the managing workspace's own copy; people only when no workspace manages it", async () => {
    editor();
    mock("readSubscriptionCoreProviderModelConnectionAccess", async () => ({
      policy: {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version: 1,
      },
      localWorkspaceIds: [MANAGER],
      managedByWorkspaceId: MANAGER,
      peopleSupported: false,
    }));
    const response = await app().fetch(organizationAdminRequest(path));
    expect(response.status).toBe(200);
    const body = await response.json();
    // An older form saves exactly what it saved before: no people key.
    expect(body.policy).toEqual({
      allowedModels: null,
      allowedWorkspaces: [],
      allowPersonalWorkspaces: false,
      version: 1,
    });
    expect(body).toMatchObject({
      peopleSupported: false,
      localWorkspaceIds: [MANAGER],
      managedByWorkspaceId: MANAGER,
    });
    expect(body.people).toBeUndefined();

    // A workspace's own copy no workspace manages can be limited to people.
    mock("readSubscriptionCoreProviderModelConnectionAccess", async () => ({
      policy: {
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version: 1,
      },
      localWorkspaceIds: [MANAGER],
      managedByWorkspaceId: null,
      peopleSupported: true,
    }));
    const unmanaged = await (await app().fetch(organizationAdminRequest(path))).json();
    expect(unmanaged).toMatchObject({
      peopleSupported: true,
      people: [{ id: PERSON, name: "user:ada", email: null }],
      localWorkspaceIds: [MANAGER],
      managedByWorkspaceId: null,
    });

    // Beyond what the member list can show, people are not offered; the editor
    // still works. The database refuses with SQLSTATE 54000, wrapped by the
    // query layer, before any response parsing.
    mock("listOrganizationAdministrationMembers", async () => {
      throw Object.assign(new Error("Failed query"), {
        cause: Object.assign(
          new Error("organization member inventory exceeds the bounded projection"),
          { code: "54000" },
        ),
      });
    });
    const large = await app().fetch(organizationAdminRequest(path));
    expect(large.status).toBe(200);
    const largeBody = await large.json();
    expect(largeBody.peopleSupported).toBe(false);
    expect(largeBody.people).toBeUndefined();
    // Any other failure is not hidden.
    mock("listOrganizationAdministrationMembers", async () => {
      throw Object.assign(new Error("Failed query"), { cause: { code: "42501" } });
    });
    expect((await app().fetch(organizationAdminRequest(path))).status).toBe(500);
  });

  test("a person outside the organization or a mixed choice is a 422, never a write", async () => {
    editor();
    for (const error of [
      new opengeniDb.SubscriptionCoreAccessPersonNotInOrganizationError(),
      new opengeniDb.SubscriptionCoreAccessPeopleUnlistableError(),
      new opengeniDb.SubscriptionCoreAccessInvalidError("mixed"),
    ]) {
      mock("updateSubscriptionCoreProviderModelConnectionAccess", async () => {
        throw error;
      });
      const body = JSON.stringify({
        allowedModels: null,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: [PERSON],
        version: 1,
      });
      const response = await app().fetch(organizationAdminRequest(path, { method: "PUT", body }));
      expect(response.status).toBe(422);
    }
    expect(wakes).toEqual([]);
  });
});

describe("the Codex Apps designation for a run", () => {
  const poison = poisonDb as never;
  function leaves() {
    mock("getWorkspaceGrant", async () => ({
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "user:owner",
      permissions: ["connections:write"],
    }));
    const core = mock("resolveSubscriptionCoreCodexAppsDesignation", async () => ({
      connectionId: CONNECTION,
      status: "active",
    }));
    const lookup = mock("rlsContextForWorkspace", async () => ({
      accountId: ACCOUNT,
      workspaceId: WS,
    }));
    return { core, lookup };
  }

  test("uses only an active core designation and preserves the credential-ID alias", async () => {
    const { core } = leaves();
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toEqual({
      source: "core",
      accountId: ACCOUNT,
      connectionId: CONNECTION,
    });
    expect(await resolveCodexAppsCredentialIdForRun(poison, WS)).toBe(CONNECTION);
    mock("resolveSubscriptionCoreCodexAppsDesignation", async () => ({
      connectionId: CONNECTION,
      status: "needs_relogin",
    }));
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toBeNull();
    expect(core.mock.calls.length).toBeGreaterThan(0);
  });

  test("request authentication follows the designation's source", () => {
    const coreAuth = mock("subscriptionCoreCodexAppsRequestAuth", () => ({ kind: "core" }));
    expect(
      codexAppsRequestAuthForDesignation(poison, settings, WS, {
        source: "core",
        accountId: ACCOUNT,
        connectionId: CONNECTION,
      }),
    ).toEqual({ kind: "core" } as never);
    expect(coreAuth.mock.calls[0]![2]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      connectionId: CONNECTION,
    });
  });
});

describe("the organization account list's wire shape", () => {
  test("says which workspaces use an account as their own, only when the list knows", () => {
    // Pages list a workspace's own account once from this field (design 5.4).
    expect(codexAccountJson({ ...account, ownInWorkspaceIds: [WS] }).ownInWorkspaceIds).toEqual([
      WS,
    ]);
    expect(codexAccountJson({ ...account, ownInWorkspaceIds: [] }).ownInWorkspaceIds).toEqual([]);
    expect("ownInWorkspaceIds" in codexAccountJson(account)).toBe(false);
  });
});

describe("the organization access editor for an organization API key", () => {
  test("offers Personal workspaces for every organization key, like a subscription", async () => {
    mock("assertOrganizationCodexAdministrator", async () => undefined);
    mock("getOrganizationAdministrationOverview", async () => ({
      workspaces: [{ id: WS, name: "Research" }],
    }));
    mock("listOrganizationModelProviderCustomModels", async () => []);
    const read = mock("getModelConnectionAccess", async () => ({
      allowedModels: null,
      allowedWorkspaces: [WS],
      allowPersonalWorkspaces: false,
      version: 2,
    }));
    for (const kind of ["openrouter", "vercel_gateway", "opper"]) {
      const response = await app().fetch(
        organizationAdminRequest(
          `/v1/organizations/${ACCOUNT}/model-connections/${kind}/current/access`,
        ),
      );
      expect({ kind, status: response.status }).toEqual({ kind, status: 200 });
      expect(await response.json()).toMatchObject({
        policy: { allowedWorkspaces: [WS], allowPersonalWorkspaces: false, version: 2 },
        personalWorkspacesSupported: true,
      });
    }
    // Read at organization scope: no workspace, so never a Personal workspace's own row.
    expect(
      read.mock.calls.every((call) => (call[1] as { workspaceId: unknown }).workspaceId === null),
    ).toBe(true);
  });
});
