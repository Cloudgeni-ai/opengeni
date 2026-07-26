import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import type { CodexUsagePayload } from "@opengeni/codex";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

// Per-account usage routes (P2): the batched live refresh, the single-account live
// read, and the repointed back-compat /usage. db accessors are spied so no real
// Postgres or provider call is made — the routes' batching/keying/status mapping
// is what's under test. requireAccessGrant authenticates from the delegated token
// alone (no db hit), so the underlying db is a poison proxy.

const DELEGATION_SECRET = "codex-usage-delegation-secret";
const STATE_SECRET = "codex-usage-state-secret";
const WS = "00000000-0000-4000-8000-0000000000a1";
const ACCOUNT = "00000000-0000-4000-8000-0000000000c3";
const ID_A = "11111111-0000-4000-8000-000000000001";
const ID_B = "22222222-0000-4000-8000-000000000002";
const ID_C = "33333333-0000-4000-8000-000000000003";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: DELEGATION_SECRET,
});

const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db must not be touched directly on these route paths");
    },
  },
);

function app() {
  return createApp({
    settings,
    db: poisonDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubStateSecret: STATE_SECRET,
  } as never);
}

async function bearer(permissions: Permission[]): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: ACCOUNT,
    workspaceId: WS,
    subjectId: "tester",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `Bearer ${token}`;
}

function account(
  id: string,
  over: Partial<opengeniDb.CodexAccountStatus> = {},
): opengeniDb.CodexAccountStatus {
  return {
    id,
    chatgptAccountId: `acct-${id}`,
    label: `acct ${id}`,
    accountEmail: null,
    planType: "pro",
    status: "active",
    isActive: id === ID_A,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
    primaryUsedPercent: null,
    primaryResetAt: null,
    secondaryUsedPercent: null,
    secondaryResetAt: null,
    usageCheckedAt: null,
    exhaustedUntil: null,
    connectorNamespaces: null,
    connectorsCheckedAt: null,
    ...over,
  };
}

function payload(
  status: CodexUsagePayload["status"],
  over: Partial<CodexUsagePayload> = {},
): CodexUsagePayload {
  return {
    status,
    planType: "pro",
    fiveHour:
      status === "ok" || status === "limit_reached"
        ? {
            used: 40,
            limit: 100,
            remaining: 60,
            percent: 40,
            resetAt: null,
            resetAfterSeconds: 3600,
            limitWindowSeconds: 18000,
          }
        : null,
    weekly:
      status === "ok" || status === "limit_reached"
        ? {
            used: 10,
            limit: 100,
            remaining: 90,
            percent: 10,
            resetAt: null,
            resetAfterSeconds: 200000,
            limitWindowSeconds: 604800,
          }
        : null,
    limitReached: status === "limit_reached",
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function spyAccounts(rows: opengeniDb.CodexAccountStatus[]): void {
  const spy = spyOn(opengeniDb, "listCodexAccountStatuses").mockResolvedValue(rows);
  restores.push(() => spy.mockRestore());
}
function spyUsage(
  byId: Record<string, CodexUsagePayload | (() => Promise<CodexUsagePayload>)>,
): void {
  const spy = spyOn(opengeniDb, "fetchCodexUsageForAccount").mockImplementation(
    async (_db, _settings, _ws, id: string) => {
      const entry = byId[id];
      if (typeof entry === "function") return entry();
      if (!entry) throw new Error(`unexpected usage fetch for ${id}`);
      return entry;
    },
  );
  restores.push(() => spy.mockRestore());
}

describe("POST /codex/usage/refresh — batched per-account live refresh", () => {
  test("returns usage keyed by credential id, each entry independently statused", async () => {
    spyAccounts([account(ID_A), account(ID_B), account(ID_C)]);
    spyUsage({
      [ID_A]: payload("ok"),
      [ID_B]: payload("limit_reached"),
      // An account whose usage read rejects: allSettled keeps the batch alive and
      // the route maps the rejection to an `error` entry.
      [ID_C]: async () => {
        throw new Error("boom 401");
      },
    });
    const res = await app().request(`/v1/workspaces/${WS}/codex/usage/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usage: Record<string, { status: string; usage: CodexUsagePayload }>;
    };
    expect(Object.keys(body.usage).sort()).toEqual([ID_A, ID_B, ID_C].sort());
    expect(body.usage[ID_A]!.status).toBe("ok");
    expect(body.usage[ID_B]!.status).toBe("limit_reached");
    expect(body.usage[ID_C]!.status).toBe("error"); // the thrown one didn't sink the batch
    expect(body.usage[ID_A]!.usage.fiveHour?.remaining).toBe(60);
  });

  test("an account whose usage 404s/limit-reached surfaces as limit_reached, not error", async () => {
    spyAccounts([account(ID_A)]);
    spyUsage({ [ID_A]: payload("limit_reached", { limitReached: true }) });
    const res = await app().request(`/v1/workspaces/${WS}/codex/usage/refresh`, {
      method: "POST",
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    const body = (await res.json()) as { usage: Record<string, { status: string }> };
    expect(body.usage[ID_A]!.status).toBe("limit_reached");
  });

  test("requires workspace:read", async () => {
    spyAccounts([]);
    const res = await app().request(`/v1/workspaces/${WS}/codex/usage/refresh`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /codex/accounts/:id/usage — single-account live read", () => {
  test("returns the normalized payload for a known account", async () => {
    spyAccounts([account(ID_A)]);
    spyUsage({ [ID_A]: payload("ok") });
    const res = await app().request(`/v1/workspaces/${WS}/codex/accounts/${ID_A}/usage`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; usage: CodexUsagePayload };
    expect(body.status).toBe("ok");
    expect(body.usage.weekly?.remaining).toBe(90);
  });

  test("404s an unknown account id (not in the workspace)", async () => {
    spyAccounts([account(ID_A)]);
    const res = await app().request(`/v1/workspaces/${WS}/codex/accounts/${ID_B}/usage`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /codex/usage — back-compat, repointed through the refreshing wrapper", () => {
  test("reads the active account via fetchCodexUsageForAccount (no stale-token 401)", async () => {
    {
      const spy = spyOn(opengeniDb, "getCodexCredentialStatus").mockResolvedValue({
        connected: true,
        credentialId: ID_A,
        chatgptAccountId: "a",
        scopes: null,
        planType: "pro",
        status: "active",
        expiresAt: null,
        lastRefreshAt: null,
        lastError: null,
      });
      restores.push(() => spy.mockRestore());
    }
    spyUsage({ [ID_A]: payload("ok") });
    const res = await app().request(`/v1/workspaces/${WS}/codex/usage`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("404s when no subscription is connected", async () => {
    {
      const spy = spyOn(opengeniDb, "getCodexCredentialStatus").mockResolvedValue(null);
      restores.push(() => spy.mockRestore());
    }
    const res = await app().request(`/v1/workspaces/${WS}/codex/usage`, {
      headers: { authorization: await bearer(["workspace:read"]) },
    });
    expect(res.status).toBe(404);
  });
});

// P3: PATCH /codex/settings — the rotation toggle/strategy write path. db accessors
// are spied (poison db), so the route's validation + permission gate is what's tested.
describe("PATCH /codex/settings — rotation settings", () => {
  function spySettings(): {
    ensure: ReturnType<typeof spyOn>;
    update: ReturnType<typeof spyOn>;
    mutation: ReturnType<typeof spyOn>;
  } {
    const ensure = spyOn(opengeniDb, "ensureCodexRotationSettings").mockResolvedValue(undefined);
    const update = spyOn(opengeniDb, "updateCodexRotationSettings").mockResolvedValue({
      activeCredentialId: ID_A,
      rotationEnabled: true,
      leaseRotationEnabled: true,
      rotationStrategy: "most_remaining",
    });
    const mutation = spyOn(opengeniDb, "withCodexCapacityMutation").mockImplementation(
      async (_db, _input, mutate) => {
        const result = await mutate({} as never);
        return { result: result.result, wakeTargets: [] };
      },
    );
    restores.push(() => ensure.mockRestore());
    restores.push(() => update.mockRestore());
    restores.push(() => mutation.mockRestore());
    return { ensure, update, mutation };
  }

  test("enables rotation and returns the effective settings", async () => {
    const { ensure, update } = spySettings();
    const res = await app().request(`/v1/workspaces/${WS}/codex/settings`, {
      method: "PATCH",
      headers: {
        authorization: await bearer(["workspace:admin"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ rotationEnabled: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotationEnabled: boolean; rotationStrategy: string };
    expect(body.rotationEnabled).toBe(true);
    expect(body.rotationStrategy).toBe("sharded"); // sharded-rotation policy: the only effective strategy
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.anything(), WS, { rotationEnabled: true });
  });

  test("sharded-rotation policy: a strategy-only write is a deprecated no-op (200, db untouched)", async () => {
    // The strategy picker is gone — rotation-enabled always behaves as sharded.
    // Old SDK/UI callers that PATCH a strategy (valid or bogus) must not break
    // and must not write anything.
    const { update } = spySettings();
    for (const rotationStrategy of ["most_remaining", "bogus"]) {
      const res = await app().request(`/v1/workspaces/${WS}/codex/settings`, {
        method: "PATCH",
        headers: {
          authorization: await bearer(["workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({ rotationStrategy }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rotationStrategy: string };
      expect(body.rotationStrategy).toBe("sharded");
    }
    expect(update).not.toHaveBeenCalled();
  });

  test("an empty patch is a 400 (no settings to update)", async () => {
    spySettings();
    const res = await app().request(`/v1/workspaces/${WS}/codex/settings`, {
      method: "PATCH",
      headers: {
        authorization: await bearer(["workspace:admin"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("requires workspace:admin (read-only token is 403/401)", async () => {
    spySettings();
    const res = await app().request(`/v1/workspaces/${WS}/codex/settings`, {
      method: "PATCH",
      headers: {
        authorization: await bearer(["workspace:read"]),
        "content-type": "application/json",
      },
      body: JSON.stringify({ rotationEnabled: true }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
