import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { CodexCredentialForRun, Database } from "@opengeni/db";
import { CodexReloginRequired } from "@opengeni/codex";
import { buildCodexTokenResolver, type CodexAuthDeps } from "../src/activities/codex-auth";

const db = {} as Database;
const settings = testSettings({ codexSubscriptionEnabled: true });

function makeCred(overrides: Partial<CodexCredentialForRun> = {}): CodexCredentialForRun {
  return {
    id: "cred_1",
    version: 1,
    workspaceId: "ws_1",
    tokens: { accessToken: "AC", refreshToken: "RF", idToken: "ID" },
    chatgptAccountId: "acct_1",
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // fresh by default
    lastRefreshAt: new Date(),
    status: "active",
    lastError: null,
    ...overrides,
  };
}

type Counts = {
  refresh: number;
  record: number;
  status: number;
  recordArgs: Array<{ id: string; version: number }>;
  statusArgs: Array<{ status: string; expected?: { id: string; version: number } }>;
};

function deps(overrides: Partial<CodexAuthDeps> = {}): { deps: CodexAuthDeps; counts: Counts } {
  const counts: Counts = { refresh: 0, record: 0, status: 0, recordArgs: [], statusArgs: [] };
  const base: CodexAuthDeps = {
    loadCredential: async () => makeCred(),
    refresh: async () => {
      counts.refresh += 1;
      return { accessToken: "AC2", refreshToken: "RF2", idToken: "ID2" };
    },
    recordRefresh: async (_db, input) => {
      counts.record += 1;
      counts.recordArgs.push({ id: input.id, version: input.version });
      return true;
    },
    setStatus: async (_db, _ws, status, _err, expected) => {
      counts.status += 1;
      counts.statusArgs.push({ status, expected });
      return true;
    },
    encrypt: () => "v1:enc",
    keyBytes: () => new Uint8Array(32),
    ...overrides,
  };
  return { deps: base, counts };
}

describe("buildCodexTokenResolver", () => {
  test("returns the cached token without refreshing when not stale", async () => {
    const { deps: d, counts } = deps();
    const resolver = buildCodexTokenResolver(db, settings, "ws_fresh", "cred_1", d);
    const token = await resolver.getToken();
    expect(token.accessToken).toBe("AC");
    expect(counts.refresh).toBe(0);
  });

  test("refreshes and persists when the token is within the expiry window", async () => {
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_stale", "cred_1", d);
    const token = await resolver.getToken();
    expect(token.accessToken).toBe("AC2");
    expect(counts.refresh).toBe(1);
    expect(counts.record).toBe(1);
  });

  test("single-flight: two concurrent getToken() trigger exactly one refresh", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => {
        counts.refresh += 1;
        await gate;
        return { accessToken: "AC2" };
      },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_concurrent", "cred_1", d);
    const both = Promise.all([resolver.getToken(), resolver.getToken()]);
    release();
    const [a, b] = await both;
    expect(counts.refresh).toBe(1);
    expect(a.accessToken).toBe("AC2");
    expect(b.accessToken).toBe("AC2");
  });

  test("single-flight: a forced refresh concurrent with another refresh does not double-spend the token", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => {
        counts.refresh += 1;
        await gate;
        return { accessToken: "AC2" };
      },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_force_concurrent", "cred_1", d);
    const both = Promise.all([resolver.refresh(), resolver.refresh()]); // two 401 retries at once
    release();
    await both;
    expect(counts.refresh).toBe(1); // coalesced -> the one-time refresh token spent once
  });

  test("a permanent refresh failure marks needs_relogin and rethrows", async () => {
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => {
        counts.refresh += 1;
        throw new CodexReloginRequired("expired");
      },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_relogin", "cred_1", d);
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
    expect(counts.status).toBe(1);
  });

  test("a missing credential throws CodexReloginRequired", async () => {
    const { deps: d } = deps({ loadCredential: async () => null });
    const resolver = buildCodexTokenResolver(db, settings, "ws_missing", "cred_1", d);
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
  });

  test("P1-c: the refresh write is compare-and-set on the loaded id+version", async () => {
    const { deps: d, counts } = deps({
      loadCredential: async () =>
        makeCred({ id: "cred_A", version: 7, expiresAt: new Date(Date.now() - 1000) }),
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_cas", "cred_1", d);
    await resolver.getToken();
    expect(counts.recordArgs).toEqual([{ id: "cred_A", version: 7 }]);
  });

  test("P1-c: a CAS miss (row changed under us) falls back to the now-active credential, no relogin", async () => {
    let load = 0;
    const { deps: d, counts } = deps({
      // First load: the OLD credential (stale). After the failed CAS, a reload
      // returns the freshly RECONNECTED credential (new id, active).
      loadCredential: async () => {
        load += 1;
        return load === 1
          ? makeCred({ id: "cred_old", version: 1, expiresAt: new Date(Date.now() - 1000) })
          : makeCred({
              id: "cred_new",
              version: 1,
              tokens: { accessToken: "NEW", refreshToken: "RFn", idToken: "IDn" },
              status: "active",
            });
      },
      recordRefresh: async () => {
        counts.record += 1;
        return false;
      }, // CAS miss
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_reconnect", "cred_1", d);
    const token = await resolver.getToken();
    expect(token.accessToken).toBe("NEW"); // used the reconnected credential, not the stale rotation
    expect(counts.status).toBe(0); // never stamped needs_relogin on the new row
  });

  test("P1-c: a CAS miss with nothing active remaining surfaces relogin (CAS-guarded stamp)", async () => {
    let load = 0;
    const { deps: d, counts } = deps({
      loadCredential: async () => {
        load += 1;
        return load === 1
          ? makeCred({ id: "cred_old", version: 3, expiresAt: new Date(Date.now() - 1000) })
          : null; // disconnected; nothing to fall back to
      },
      recordRefresh: async () => {
        counts.record += 1;
        return false;
      }, // CAS miss
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_reconnect_gone", "cred_1", d);
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
    // The needs_relogin stamp is compare-and-set on the OLD id+version, so it
    // can never clobber a credential that replaced it.
    expect(counts.statusArgs).toEqual([
      { status: "needs_relogin", expected: { id: "cred_old", version: 3 } },
    ]);
  });

  test("P1-b: a reconnect's new row does NOT coalesce onto the old in-flight refresh", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let load = 0;
    const { deps: d, counts } = deps({
      loadCredential: async () => {
        load += 1;
        // first caller loads the old row; the second (post-reconnect) loads a new row id
        return makeCred({
          id: load === 1 ? "cred_old" : "cred_new",
          version: 1,
          expiresAt: new Date(Date.now() - 1000),
        });
      },
      refresh: async () => {
        counts.refresh += 1;
        await gate;
        return { accessToken: "AC2" };
      },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_reconnect_inflight", "cred_1", d);
    const both = Promise.all([resolver.refresh(), resolver.refresh()]);
    release();
    await both;
    // Distinct credential instances → distinct single-flight keys → two refreshes,
    // NOT coalesced (the old behavior would have spent the new row's refresh onto
    // the old family).
    expect(counts.refresh).toBe(2);
  });
});
