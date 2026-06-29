import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { CodexCredentialForRun, Database } from "@opengeni/db";
import { CodexReloginRequired } from "@opengeni/codex";
import { buildCodexTokenResolver, type CodexAuthDeps } from "../src/activities/codex-auth";

const db = {} as Database;
const settings = testSettings({ codexSubscriptionEnabled: true });

function makeCred(overrides: Partial<CodexCredentialForRun> = {}): CodexCredentialForRun {
  return {
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

function deps(overrides: Partial<CodexAuthDeps> = {}): { deps: CodexAuthDeps; counts: { refresh: number; record: number; status: number } } {
  const counts = { refresh: 0, record: 0, status: 0 };
  const base: CodexAuthDeps = {
    loadCredential: async () => makeCred(),
    refresh: async () => { counts.refresh += 1; return { accessToken: "AC2", refreshToken: "RF2", idToken: "ID2" }; },
    recordRefresh: async () => { counts.record += 1; },
    setStatus: async () => { counts.status += 1; },
    encrypt: () => "v1:enc",
    keyBytes: () => new Uint8Array(32),
    ...overrides,
  };
  return { deps: base, counts };
}

describe("buildCodexTokenResolver", () => {
  test("returns the cached token without refreshing when not stale", async () => {
    const { deps: d, counts } = deps();
    const resolver = buildCodexTokenResolver(db, settings, "ws_fresh", d);
    const token = await resolver.getToken();
    expect(token.accessToken).toBe("AC");
    expect(counts.refresh).toBe(0);
  });

  test("refreshes and persists when the token is within the expiry window", async () => {
    const { deps: d, counts } = deps({ loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }) });
    const resolver = buildCodexTokenResolver(db, settings, "ws_stale", d);
    const token = await resolver.getToken();
    expect(token.accessToken).toBe("AC2");
    expect(counts.refresh).toBe(1);
    expect(counts.record).toBe(1);
  });

  test("single-flight: two concurrent getToken() trigger exactly one refresh", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => { counts.refresh += 1; await gate; return { accessToken: "AC2" }; },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_concurrent", d);
    const both = Promise.all([resolver.getToken(), resolver.getToken()]);
    release();
    const [a, b] = await both;
    expect(counts.refresh).toBe(1);
    expect(a.accessToken).toBe("AC2");
    expect(b.accessToken).toBe("AC2");
  });

  test("single-flight: a forced refresh concurrent with another refresh does not double-spend the token", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => { counts.refresh += 1; await gate; return { accessToken: "AC2" }; },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_force_concurrent", d);
    const both = Promise.all([resolver.refresh(), resolver.refresh()]); // two 401 retries at once
    release();
    await both;
    expect(counts.refresh).toBe(1); // coalesced -> the one-time refresh token spent once
  });

  test("a permanent refresh failure marks needs_relogin and rethrows", async () => {
    const { deps: d, counts } = deps({
      loadCredential: async () => makeCred({ expiresAt: new Date(Date.now() - 1000) }),
      refresh: async () => { counts.refresh += 1; throw new CodexReloginRequired("expired"); },
    });
    const resolver = buildCodexTokenResolver(db, settings, "ws_relogin", d);
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
    expect(counts.status).toBe(1);
  });

  test("a missing credential throws CodexReloginRequired", async () => {
    const { deps: d } = deps({ loadCredential: async () => null });
    const resolver = buildCodexTokenResolver(db, settings, "ws_missing", d);
    await expect(resolver.getToken()).rejects.toBeInstanceOf(CodexReloginRequired);
  });
});
