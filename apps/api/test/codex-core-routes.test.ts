import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

// Codex routes for an organization whose Codex cutover row exists. db
// accessors are spied; every legacy Codex accessor is poisoned so a core or
// maintenance route that reached legacy state fails loudly.

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

async function bearer(permissions: Permission[]): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: ACCOUNT,
    workspaceId: WS,
    subjectId: "tester",
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
afterEach(() => {
  wakes.length = 0;
  while (restores.length) restores.pop()!();
});

function mock<K extends keyof typeof opengeniDb>(name: K, impl: (...args: never[]) => unknown) {
  const spy = spyOn(opengeniDb, name as never).mockImplementation(impl as never);
  restores.push(() => (spy as { mockRestore(): void }).mockRestore());
  return spy as unknown as { mock: { calls: unknown[][] } };
}

function cutover(disposition: "core" | "maintenance") {
  mock("readCodexCutoverDisposition", async () => disposition);
  for (const legacy of [
    "listCodexAccountStatuses",
    "getCodexRotationSettings",
    "getCodexAppsSettings",
    "getWorkspaceCodexSubscriptionSource",
    "getCodexCredentialStatus",
    "updateCodexAllocatorEligibility",
    "getSessionCodexAccounts",
    "switchSessionCodexAccount",
  ] as const) {
    mock(legacy, async () => {
      throw new Error(`legacy Codex accessor ${legacy} must not run`);
    });
  }
  mock("deliverSubscriptionCoreCodexWake", async (_db: never, wake: never) => {
    wakes.push(wake);
  });
}

describe("Codex routes with a disabled cutover", () => {
  test("fail closed with a typed 503 and read no legacy state", async () => {
    cutover("maintenance");
    for (const path of ["/codex/accounts", "/codex/status", "/codex/source"]) {
      const response = await app().request(`/v1/workspaces/${WS}${path}`, {
        headers: { authorization: await bearer(["workspace:read"]) },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: {
          status: 503,
          code: "upstream_unavailable",
          details: { reason: "subscription_core_cutover_disabled" },
        },
      });
    }
  });
});

describe("Codex Apps designation authenticates before reading organization state", () => {
  test("unauthenticated and bearer callers learn nothing about the cutover row", async () => {
    const cutoverRead = mock("readCodexCutoverDisposition", async () => "core");
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
    expect(cutoverRead.mock.calls.length).toBe(0);
  });
});

describe("Codex routes with an enabled cutover", () => {
  test("GET accounts keeps the legacy shape, projected from the core", async () => {
    cutover("core");
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
    cutover("core");
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

  test("allocator and source writes go to the core and wake waiters", async () => {
    cutover("core");
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

  test("operations the core does not serve yet answer a typed 409", async () => {
    cutover("core");
    const requests: Array<[string, string]> = [
      ["POST", "/codex/usage/refresh"],
      ["GET", "/codex/usage"],
      ["GET", `/codex/accounts/${CONNECTION}/usage`],
      ["GET", "/codex/overview"],
      ["POST", "/codex/connect/start"],
      ["DELETE", `/codex/accounts/${CONNECTION}`],
      ["DELETE", "/codex"],
    ];
    for (const [method, path] of requests) {
      const response = await app().request(`/v1/workspaces/${WS}${path}`, {
        method,
        headers: { authorization: await bearer(["workspace:read", "connections:write"]) },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          status: 409,
          code: "conflict",
          details: { reason: "subscription_core_route_unsupported" },
        },
      });
    }
  });

  test("the session account view and pin use the core binding", async () => {
    cutover("core");
    const sessionId = crypto.randomUUID();
    mock("getSessionAuthorityProjection", async () => ({
      sessionId,
      rootSessionId: sessionId,
      visibility: "workspace_shared",
      ownerSubjectId: null,
    }));
    mock("getSlackInteractionSessionAccessForSession", async () => null);
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
    expect(view.mock.calls[0]![1]).toEqual({ accountId: ACCOUNT, workspaceId: WS, sessionId });
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
