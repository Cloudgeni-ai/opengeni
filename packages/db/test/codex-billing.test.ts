import { describe, expect, spyOn, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import * as db from "../src/index";
import type { Database } from "../src/index";
import { isCodexBilledModel, isCodexBilledTurn, workspaceCodexSubscriptionActive } from "../src/index";

/**
 * Spies on the ONLY db read the codex-billed predicate performs
 * (getCodexCredentialStatus) so the canonical detection can be exercised without
 * a live Postgres. Mirrors apps/worker/test/codex-overlay.test.ts.
 */
function mockCredentialStatus(status: string | null): () => void {
  if (status === null) {
    const spy = spyOn(db, "getCodexCredentialStatus").mockResolvedValue(null);
    return () => spy.mockRestore();
  }
  const spy = spyOn(db, "getCodexCredentialStatus").mockResolvedValue({
    connected: status === "active",
    chatgptAccountId: "acct-1",
    scopes: null,
    planType: "pro",
    status,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
  } as Awaited<ReturnType<typeof db.getCodexCredentialStatus>>);
  return () => spy.mockRestore();
}

describe("isCodexBilledModel (pure prefix test)", () => {
  test("true for a codex/<slug> id", () => {
    expect(isCodexBilledModel("codex/gpt-5.5")).toBe(true);
  });
  test("false for a normal model id, null, and undefined", () => {
    expect(isCodexBilledModel("gpt-5")).toBe(false);
    expect(isCodexBilledModel("scripted-model")).toBe(false);
    expect(isCodexBilledModel(null)).toBe(false);
    expect(isCodexBilledModel(undefined)).toBe(false);
  });
});

describe("workspaceCodexSubscriptionActive", () => {
  test("false when the feature is disabled (never reads the db)", async () => {
    // Pass a poisoned db: if it were read the call would throw, proving no read.
    const poison = new Proxy({}, { get() { throw new Error("db must not be read when feature disabled"); } }) as unknown as Database;
    const settings = testSettings({ codexSubscriptionEnabled: false });
    expect(await workspaceCodexSubscriptionActive(poison, settings, "ws_1")).toBe(false);
  });
  test("true for an active credential when enabled", async () => {
    const restore = mockCredentialStatus("active");
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true });
      expect(await workspaceCodexSubscriptionActive({} as Database, settings, "ws_1")).toBe(true);
    } finally { restore(); }
  });
  test("false for a needs_relogin credential", async () => {
    const restore = mockCredentialStatus("needs_relogin");
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true });
      expect(await workspaceCodexSubscriptionActive({} as Database, settings, "ws_1")).toBe(false);
    } finally { restore(); }
  });
  test("false when no credential row exists", async () => {
    const restore = mockCredentialStatus(null);
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true });
      expect(await workspaceCodexSubscriptionActive({} as Database, settings, "ws_1")).toBe(false);
    } finally { restore(); }
  });
});

describe("isCodexBilledTurn (canonical predicate)", () => {
  test("codex model + active credential + enabled => true", async () => {
    const restore = mockCredentialStatus("active");
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true });
      expect(await isCodexBilledTurn({ db: {} as Database, settings, workspaceId: "ws_1", model: "codex/gpt-5.5" })).toBe(true);
    } finally { restore(); }
  });

  test("codex model but NO active credential => false (no free bypass)", async () => {
    const restore = mockCredentialStatus("needs_relogin");
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true });
      expect(await isCodexBilledTurn({ db: {} as Database, settings, workspaceId: "ws_1", model: "codex/gpt-5.5" })).toBe(false);
    } finally { restore(); }
  });

  test("codex model but feature disabled => false", async () => {
    const poison = new Proxy({}, { get() { throw new Error("db must not be read when feature disabled"); } }) as unknown as Database;
    const settings = testSettings({ codexSubscriptionEnabled: false });
    expect(await isCodexBilledTurn({ db: poison, settings, workspaceId: "ws_1", model: "codex/gpt-5.5" })).toBe(false);
  });

  test("non-codex model => false WITHOUT a credential read (prefix is a necessary condition)", async () => {
    // Poisoned db proves the common non-codex path issues no credential read.
    const poison = new Proxy({}, { get() { throw new Error("db must not be read for a non-codex model"); } }) as unknown as Database;
    const settings = testSettings({ codexSubscriptionEnabled: true });
    expect(await isCodexBilledTurn({ db: poison, settings, workspaceId: "ws_1", model: "scripted-model" })).toBe(false);
  });
});
