import { describe, expect, spyOn, test } from "bun:test";
import { parseModelProvidersJson } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  settingsWithCodexCredential,
  withCodexAppsMcpServer,
  withCodexProvider,
} from "../src/activities/capabilities";

const BOTH_SCOPES = "api.connectors.read api.connectors.invoke";

describe("withCodexProvider", () => {
  test("appends one codex-subscription provider with namespaced models", () => {
    const settings = testSettings({ modelProvidersJson: "[]" });
    const result = withCodexProvider(settings);
    const providers = parseModelProvidersJson(result.modelProvidersJson);
    const codex = providers.find((p) => p.id === "codex-subscription");
    expect(codex).toBeDefined();
    expect(codex?.kind).toBe("codex-subscription");
    expect(codex?.api).toBe("responses");
    expect(codex?.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(codex?.models.every((m) => m.id.startsWith("codex/"))).toBe(true);
    expect(codex?.models.some((m) => m.id === "codex/gpt-5.5")).toBe(true);
  });

  test("preserves existing registry providers", () => {
    const existing = JSON.stringify([{ id: "fireworks", baseUrl: "https://api.fireworks.ai", models: [{ id: "glm" }] }]);
    const result = withCodexProvider(testSettings({ modelProvidersJson: existing }));
    const ids = parseModelProvidersJson(result.modelProvidersJson).map((p) => p.id);
    expect(ids).toContain("fireworks");
    expect(ids).toContain("codex-subscription");
  });

  test("is idempotent — a second call does not double-inject", () => {
    const once = withCodexProvider(testSettings({ modelProvidersJson: "[]" }));
    const twice = withCodexProvider(once);
    expect(twice).toBe(once); // same reference: no change
    expect(parseModelProvidersJson(twice.modelProvidersJson).filter((p) => p.id === "codex-subscription").length).toBe(1);
  });
});

describe("withCodexAppsMcpServer", () => {
  // Connector access is gated SERVER-SIDE per ChatGPT account (chatgpt-account-id),
  // NOT by token scopes — so injection is unconditional for any active credential
  // and the actual tool set is discovered at runtime.
  test("appends exactly one codex_apps entry with the right metadata and NO headers", () => {
    const settings = testSettings({ mcpServers: [] });
    const result = withCodexAppsMcpServer(settings);
    const apps = result.mcpServers.filter((s) => s.id === "codex_apps");
    expect(apps).toHaveLength(1);
    const entry = apps[0]!;
    expect(entry.name).toBe("codex_apps");
    expect(entry.url).toBe("https://chatgpt.com/backend-api/ps/mcp");
    expect(entry.timeoutMs).toBe(30000);
    expect(entry.cacheToolsList).toBe(false);
    expect("headers" in entry).toBe(false); // refreshing bearer is dynamic, never baked
  });

  test("is idempotent — a second call does not double-inject", () => {
    const once = withCodexAppsMcpServer(testSettings({ mcpServers: [] }));
    const twice = withCodexAppsMcpServer(once);
    expect(twice).toBe(once); // same reference, no change
    expect(twice.mcpServers.filter((s) => s.id === "codex_apps")).toHaveLength(1);
  });

  test("preserves pre-existing mcp servers", () => {
    const settings = testSettings({ mcpServers: [{ id: "opengeni", name: "OpenGeni", url: "http://x/mcp", cacheToolsList: false }] });
    const result = withCodexAppsMcpServer(settings);
    const ids = result.mcpServers.map((s) => s.id);
    expect(ids).toContain("opengeni");
    expect(ids).toContain("codex_apps");
  });
});

describe("settingsWithCodexCredential", () => {
  test("is a no-op when the feature is disabled (never touches the db)", async () => {
    const settings = testSettings({ codexSubscriptionEnabled: false, modelProvidersJson: "[]" });
    const result = await settingsWithCodexCredential(undefined as unknown as Database, "ws_1", settings);
    expect(result).toBe(settings); // same reference, no db access
  });

  test("active credential WITHOUT connector scopes => provider AND codex_apps server (scopes do not gate)", async () => {
    const restore = mockCredentialStatus({ status: "active", scopes: null });
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true, modelProvidersJson: "[]", mcpServers: [] });
      const result = await settingsWithCodexCredential({} as unknown as Database, "ws_1", settings);
      expect(parseModelProvidersJson(result.modelProvidersJson).some((p) => p.id === "codex-subscription")).toBe(true);
      // Connectors are account-gated server-side; a scope-less pro token still lists tools.
      expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(true);
    } finally {
      restore();
    }
  });

  test("active credential WITH connector scopes => both provider and codex_apps server", async () => {
    const restore = mockCredentialStatus({ status: "active", scopes: BOTH_SCOPES });
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true, modelProvidersJson: "[]", mcpServers: [] });
      const result = await settingsWithCodexCredential({} as unknown as Database, "ws_1", settings);
      expect(parseModelProvidersJson(result.modelProvidersJson).some((p) => p.id === "codex-subscription")).toBe(true);
      expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(true);
    } finally {
      restore();
    }
  });

  test("inactive credential => nothing new (no codex_apps server)", async () => {
    const restore = mockCredentialStatus({ status: "needs_relogin", scopes: BOTH_SCOPES });
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true, modelProvidersJson: "[]", mcpServers: [] });
      const result = await settingsWithCodexCredential({} as unknown as Database, "ws_1", settings);
      expect(result).toBe(settings); // untouched
    } finally {
      restore();
    }
  });
});

/**
 * Spies on @opengeni/db's getCodexCredentialStatus (the ONLY db read on the
 * overlay path) so settingsWithCodexCredential can be exercised end-to-end
 * without a live Postgres. Uses spyOn (NOT mock.module) deliberately: mock.module
 * registers a PROCESS-GLOBAL override that bleeds into other test files in the
 * same `bun test` run (notably packages/db's codex_subscription_credentials
 * integration test) and is NOT undone by mock.restore(). spyOn is scoped to the
 * namespace and the returned restorer fully reinstates the real implementation.
 */
function mockCredentialStatus(overrides: { status: string; scopes: string | null }): () => void {
  const spy = spyOn(opengeniDb, "getCodexCredentialStatus").mockResolvedValue({
    connected: overrides.status === "active",
    chatgptAccountId: "acct-1",
    scopes: overrides.scopes,
    planType: "pro",
    status: overrides.status,
    expiresAt: null,
    lastRefreshAt: null,
    lastError: null,
  } as Awaited<ReturnType<typeof opengeniDb.getCodexCredentialStatus>>);
  return () => {
    spy.mockRestore();
  };
}
