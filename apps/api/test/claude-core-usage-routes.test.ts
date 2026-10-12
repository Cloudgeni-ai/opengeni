// Claude usage routes by Claude's provider route (design 5.3, Claude track
// C2a, EP-N24 and EP-S13). db accessors are spied: on the core and
// maintenance routes every legacy Claude accessor is poisoned, so a route
// that reached legacy state fails loudly; on the legacy route the legacy
// handlers answer exactly as before after one route read.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { stampDelegatedHumanAuthorization } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "claude-core-usage-delegation-secret";
const WS = "00000000-0000-4000-8000-0000000000b1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000b3";
const CONNECTION = "22222222-0000-4000-8000-000000000001";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
  claudeSubscriptionEnabled: true,
});

const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched on these route paths");
    },
  },
);

function app() {
  return createApp({
    settings,
    db: poisonDb as never,
    bus: { publish: async () => undefined } as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubStateSecret: "claude-core-usage-state-secret",
  } as never);
}

async function bearer(permissions: Permission[], subjectId = "user:tester"): Promise<string> {
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

function organizationAdminRequest(path: string, init: RequestInit = {}): Request {
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

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function mock<K extends keyof typeof opengeniDb>(name: K, impl: (...args: never[]) => unknown) {
  const spy = spyOn(opengeniDb, name as never).mockImplementation(impl as never);
  restores.push(() => (spy as { mockRestore(): void }).mockRestore());
  return spy as unknown as { mock: { calls: unknown[][] } };
}

const LEGACY_ACCESSORS = [
  "getClaudeSubscriptionAccountAuthoritySnapshot",
  "getClaudeSubscriptionAccountMetadata",
  "listClaudeAccountUsage",
  "listOrganizationClaudeSubscriptions",
  "resolveClaudeAccountCredential",
  "recordClaudeAccountUsage",
] as const;

function route(value: "legacy" | "core" | "maintenance") {
  const read = mock("readSubscriptionCoreProviderRouteForWorkspace", async () => value);
  if (value !== "legacy") {
    for (const legacy of LEGACY_ACCESSORS) {
      mock(legacy, async () => {
        throw new Error(`legacy Claude accessor ${legacy} must not run`);
      });
    }
  }
  return read;
}

const observedAt = "2026-10-11T12:00:00.000Z";
function connectionRow(patch: Record<string, unknown> = {}) {
  return {
    id: CONNECTION,
    status: "active",
    provider_state: { oauthScopes: ["user:inference", "user:profile"] },
    quota: {
      windows: [{ id: "five_hour", usedPercent: 25, resetsAt: null, status: "ok" }],
      modelCooldowns: {},
      exhaustedUntil: null,
      exhaustedKind: null,
      source: "usage_endpoint",
    },
    quota_revision: 2,
    // Observed under an earlier credential generation: still shown.
    quota_observed_refresh_generation: 1,
    quota_updated_at: observedAt,
    // The row version is the usage credential version (the listing's).
    version: 3,
    ...patch,
  } as never;
}

const storedUsage = {
  connected: true,
  credentialVersion: 3,
  windows: [
    {
      id: "five_hour",
      usedPercent: 25,
      resetsAt: null,
      // Legacy usage-endpoint windows carried no status.
      status: null,
      observedAt,
      source: "provider",
    },
  ],
  observedAt,
  source: "provider",
  refreshStatus: "available",
  refreshCheckedAt: observedAt,
};

const workspacePath = `/v1/workspaces/${WS}/claude/accounts/${CONNECTION}/usage`;
const organizationPath = `/v1/organizations/${ACCOUNT}/claude/accounts/${CONNECTION}/usage`;

describe("workspace Claude usage on the core route", () => {
  test("GET projects the connection's core quota, with no legacy read", async () => {
    const read = route("core");
    const target = mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "organization",
      row: connectionRow(),
    }));
    const response = await app().request(workspacePath, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(storedUsage);
    expect(read.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      provider: "claude",
    });
    expect(target.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "user:tester",
      accountIdParam: CONNECTION,
    });
  });

  test("an account the caller cannot see is not found; a malformed id is refused first", async () => {
    route("core");
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => null);
    const missing = await app().request(workspacePath, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(missing.status).toBe(404);
    const malformed = await app().request(`/v1/workspaces/${WS}/claude/accounts/nope/usage`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(malformed.status).toBe(400);
  });

  test("maintenance is a typed 503", async () => {
    route("maintenance");
    const target = mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => {
      throw new Error("maintenance must not read the core");
    });
    for (const [path, method] of [
      [workspacePath, "GET"],
      [`${workspacePath}/refresh`, "POST"],
    ] as const) {
      const response = await app().request(path, {
        method,
        headers: { authorization: await bearer(["workspace:read", "workspace:admin"]) },
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { details?: { reason?: string } } };
      expect(body.error.details?.reason).toBe("subscription_core_cutover_disabled");
    }
    expect(target.mock.calls).toHaveLength(0);
  });

  test("POST refreshes a workspace connection live and wakes waiters on recovery", async () => {
    route("core");
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "workspace",
      row: connectionRow(),
    }));
    const refreshed = { ...storedUsage, refreshCheckedAt: "2026-10-11T12:05:00.000Z" };
    const refresh = mock("refreshSubscriptionCoreClaudeWorkspaceUsage", async () => ({
      usage: refreshed,
      recovered: true,
    }));
    const wakes: unknown[] = [];
    mock("deliverSubscriptionCoreProviderWake", async (...args: never[]) => {
      wakes.push(args.slice(1));
    });
    const response = await app().request(`${workspacePath}/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read", "workspace:admin"]) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(refreshed);
    expect((refresh.mock.calls[0]![2] as { workspaceId: string }).workspaceId).toBe(WS);
    expect(wakes).toEqual([["claude", { accountId: ACCOUNT, reason: "usage_recovered" }]]);
  });

  test("a failed wake never fails the committed read", async () => {
    route("core");
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "workspace",
      row: connectionRow(),
    }));
    mock("refreshSubscriptionCoreClaudeWorkspaceUsage", async () => ({
      usage: storedUsage,
      recovered: true,
    }));
    mock("deliverSubscriptionCoreProviderWake", async () => {
      throw new Error("wake delivery failed");
    });
    const response = await app().request(`${workspacePath}/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read", "workspace:admin"]) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(storedUsage);
  });

  test("the legacy authority checks apply by the connection's scope", async () => {
    route("core");
    const refresh = mock("refreshSubscriptionCoreClaudeWorkspaceUsage", async () => {
      throw new Error("must not refresh");
    });
    // An organization-pool connection is managed in organization settings.
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "organization",
      row: connectionRow(),
    }));
    const organization = await app().request(`${workspacePath}/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read", "workspace:admin"]) },
    });
    expect(organization.status).toBe(409);
    // A workspace connection needs workspace administration.
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "workspace",
      row: connectionRow(),
    }));
    const reader = await app().request(`${workspacePath}/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(reader.status).toBe(403);
    // A personal connection needs its verified owning person, even to read.
    mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => ({
      connectionId: CONNECTION,
      scope: "user",
      row: connectionRow(),
    }));
    const personal = await app().request(workspacePath, {
      headers: { authorization: await bearer(["workspace:read", "connections:write"]) },
    });
    expect(personal.status).toBe(403);
    expect(refresh.mock.calls).toHaveLength(0);
  });
});

describe("organization Claude usage on the core route", () => {
  test("GET projects the organization connection; POST refreshes it through the administrator seam", async () => {
    route("core");
    // The organization administrator check, with no legacy Claude read.
    const administrator = mock("assertOrganizationCodexAdministrator", async () => undefined);
    const row = mock("readSubscriptionCoreClaudeOrganizationUsageRow", async () => connectionRow());
    const workspaceRefresh = mock("refreshSubscriptionCoreClaudeWorkspaceUsage", async () => {
      throw new Error("the organization path never uses the workspace seam");
    });
    const refreshed = { ...storedUsage, refreshCheckedAt: "2026-10-11T12:05:00.000Z" };
    const refresh = mock("refreshSubscriptionCoreClaudeOrganizationUsage", async () => ({
      usage: refreshed,
      recovered: true,
    }));
    const wakes: unknown[] = [];
    mock("deliverSubscriptionCoreProviderWake", async (...args: never[]) => {
      wakes.push(args.slice(1));
    });
    const read = await app().fetch(organizationAdminRequest(organizationPath));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(storedUsage);
    expect(administrator.mock.calls.length).toBeGreaterThan(0);
    expect(row.mock.calls[0]![1]).toEqual({
      organizationId: ACCOUNT,
      subjectId: "user:org-admin",
      accountIdParam: CONNECTION,
    });
    const posted = await app().fetch(
      organizationAdminRequest(`${organizationPath}/refresh`, { method: "POST", body: "{}" }),
    );
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual(refreshed);
    expect(refresh.mock.calls[0]![2]).toMatchObject({
      organizationId: ACCOUNT,
      subjectId: "user:org-admin",
    });
    expect(workspaceRefresh.mock.calls).toHaveLength(0);
    expect(wakes).toEqual([["claude", { accountId: ACCOUNT, reason: "usage_recovered" }]]);
    mock("readSubscriptionCoreClaudeOrganizationUsageRow", async () => null);
    const missing = await app().fetch(organizationAdminRequest(organizationPath));
    expect(missing.status).toBe(404);
  });
});

describe("the legacy route (no Claude cutover receipt)", () => {
  test("runs the legacy handlers unchanged after one route read", async () => {
    const read = route("legacy");
    const core = mock("readSubscriptionCoreClaudeWorkspaceUsageTarget", async () => {
      throw new Error("the legacy route must not read the core");
    });
    const legacyUsage = {
      connected: true,
      credentialVersion: 7,
      windows: [],
      observedAt: null,
      source: null,
      refreshStatus: "not_checked",
      refreshCheckedAt: null,
    };
    mock("getClaudeSubscriptionAccountAuthoritySnapshot", async () => ({
      version: 1,
      scope: "workspace",
    }));
    mock("getClaudeSubscriptionAccountMetadata", async () => ({ id: CONNECTION, version: 7 }));
    const list = mock("listClaudeAccountUsage", async () => new Map([[CONNECTION, legacyUsage]]));
    const response = await app().request(workspacePath, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(legacyUsage);
    expect(read.mock.calls).toHaveLength(1);
    expect(list.mock.calls).toHaveLength(1);
    expect(core.mock.calls).toHaveLength(0);
  });
});
