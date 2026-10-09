import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  codexAppsRequestAuthForDesignation,
  resolveCodexAppsCredentialIdForRun,
  resolveCodexAppsDesignationForRun,
  stampDelegatedHumanAuthorization,
} from "@opengeni/core";
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
    "fetchCodexUsageForAccount",
    "buildCodexTokenResolver",
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

  test("per-account credit consent writes use their own revision and wake placement", async () => {
    cutover("core");
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

  test("connect and disconnect (left to PR 3) still answer a typed 409", async () => {
    cutover("core");
    const requests: Array<[string, string]> = [
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

  test("live usage, per-account usage and refresh read through the core seam", async () => {
    cutover("core");
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
    cutover("core");
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
    cutover("core");
    mock("getSubscriptionCoreCodexWorkspaceProjection", async () => projection);
    mock("listCodexResetRedemptionRecoveries", async () => {
      throw new Error("legacy redemption recoveries must not run");
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

describe("organization Codex routes with a cutover row", () => {
  function organizationCutover(disposition: "core" | "maintenance") {
    cutover(disposition);
    // The organization administrator check (no Codex state is returned).
    mock("getOrganizationCodexRotationSettings", async () => null);
    for (const legacy of [
      "listOrganizationCodexAccountStatuses",
      "setActiveOrganizationCodexCredential",
      "updateOrganizationCodexRotationSettings",
      "renameOrganizationCodexAccount",
    ] as const) {
      mock(legacy, async () => {
        throw new Error(`legacy Codex accessor ${legacy} must not run`);
      });
    }
  }
  const orgPath = `/v1/organizations/${ACCOUNT}/codex`;
  const orgAdmin = { accountId: ACCOUNT, workspaceId: null, subjectId: "user:org-admin" };

  for (const mode of ["legacy", "core"] as const) {
    test(`organization usage keeps administrator authority outside workspace routing (${mode})`, async () => {
      cutover(mode);
      mock("getOrganizationCodexRotationSettings", async () => null);
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
      expect(usage.mock.calls[0]![2]).toEqual({
        organizationId: ACCOUNT,
        actorSubjectId: "user:org-admin",
        credentialId: CONNECTION,
        mode,
      });
      const denied = await app().request(path);
      expect(denied.status).toBe(401);
      expect(usage).toHaveBeenCalledTimes(1);
      cutover("maintenance");
      const held = await app().fetch(organizationAdminRequest(path));
      expect(held.status).toBe(503);
      expect(usage).toHaveBeenCalledTimes(1);
    });
  }

  test("organization pause uses organization authority and preserves conflict responses", async () => {
    organizationCutover("core");
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

  test("a disabled cutover fails closed on every organization route", async () => {
    organizationCutover("maintenance");
    for (const [method, path, body] of [
      ["GET", "/accounts", undefined],
      ["POST", `/accounts/${CONNECTION}/activate`, {}],
      ["PATCH", "/settings", { rotationEnabled: false }],
      ["PATCH", `/accounts/${CONNECTION}`, { label: "x" }],
      ["PATCH", `/accounts/${CONNECTION}/allocator`, { enabled: false, expectedVersion: 3 }],
    ] as const) {
      const response = await app().fetch(
        organizationAdminRequest(`${orgPath}${path}`, {
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error.details.reason).toBe(
        "subscription_core_cutover_disabled",
      );
    }
  });

  test("accounts, activate, settings and rename go to the core organization row", async () => {
    organizationCutover("core");
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

describe("the Codex Apps designation for a run", () => {
  const poison = poisonDb as never;
  function leaves() {
    const legacy = mock("getCodexAppsCredentialAuthorizationForRun", async () => ({
      credentialId: "legacy-apps",
      ownerSubjectId: "user:owner",
    }));
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
    return { legacy, core, lookup };
  }

  test("maintenance designates nothing and reads neither the legacy nor the core designation", async () => {
    const { legacy, core, lookup } = leaves();
    mock("readCodexCutoverDisposition", async () => "maintenance");
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toBeNull();
    expect(await resolveCodexAppsDesignationForRun(poison, WS)).toBeNull();
    expect(
      await resolveCodexAppsDesignationForRun(poison, WS, { disposition: "maintenance" }),
    ).toBeNull();
    expect(await resolveCodexAppsCredentialIdForRun(poison, WS)).toBeNull();
    expect(legacy.mock.calls.length).toBe(0);
    expect(core.mock.calls.length).toBe(0);
    // A known organization (or a known disposition) is never looked up.
    expect(lookup.mock.calls.length).toBe(2);
  });

  test("core uses only an active core designation; legacy only the legacy one", async () => {
    const { legacy, core, lookup } = leaves();
    mock("readCodexCutoverDisposition", async () => "core");
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toEqual({
      source: "core",
      accountId: ACCOUNT,
      connectionId: CONNECTION,
    });
    expect(await resolveCodexAppsCredentialIdForRun(poison, WS)).toBeNull();
    mock("resolveSubscriptionCoreCodexAppsDesignation", async () => ({
      connectionId: CONNECTION,
      status: "needs_relogin",
    }));
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toBeNull();
    expect(legacy.mock.calls.length).toBe(0);

    const dispositionRead = mock("readCodexCutoverDisposition", async () => "legacy");
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { accountId: ACCOUNT })).toEqual({
      source: "legacy",
      credentialId: "legacy-apps",
    });
    expect(await resolveCodexAppsCredentialIdForRun(poison, WS)).toBe("legacy-apps");
    // A known disposition skips both the cutover read and the organization lookup.
    const lookupsBefore = lookup.mock.calls.length;
    const readsBefore = dispositionRead.mock.calls.length;
    expect(await resolveCodexAppsDesignationForRun(poison, WS, { disposition: "legacy" })).toEqual({
      source: "legacy",
      credentialId: "legacy-apps",
    });
    expect(lookup.mock.calls.length).toBe(lookupsBefore);
    expect(dispositionRead.mock.calls.length).toBe(readsBefore);
    expect(core.mock.calls.length).toBeGreaterThan(0);
  });

  test("request authentication follows the designation's source", () => {
    const coreAuth = mock("subscriptionCoreCodexAppsRequestAuth", () => ({ kind: "core" }));
    const legacyAuth = mock("codexAppsRequestAuth", () => ({ kind: "legacy" }));
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
    expect(
      codexAppsRequestAuthForDesignation(poison, settings, WS, {
        source: "legacy",
        credentialId: "legacy-apps",
      }),
    ).toEqual({ kind: "legacy" } as never);
    expect(legacyAuth.mock.calls[0]![2]).toEqual({ workspaceId: WS, credentialId: "legacy-apps" });
  });
});
