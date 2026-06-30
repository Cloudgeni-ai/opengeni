import { describe, expect, mock, test } from "bun:test";
import { parseModelProvidersJson } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  codexConnectorsAvailable,
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

describe("codexConnectorsAvailable", () => {
  test("true only when BOTH connector scopes are granted", () => {
    expect(codexConnectorsAvailable(BOTH_SCOPES)).toBe(true);
    expect(codexConnectorsAvailable("api.connectors.read")).toBe(false);
    expect(codexConnectorsAvailable("api.connectors.invoke")).toBe(false);
  });

  test("tolerates extra scopes and arbitrary whitespace delimiters", () => {
    expect(codexConnectorsAvailable("openid  api.connectors.read\tapi.connectors.invoke\nprofile")).toBe(true);
  });

  test("false for null, empty, or undefined scopes (device-code path gate)", () => {
    expect(codexConnectorsAvailable(null)).toBe(false);
    expect(codexConnectorsAvailable("")).toBe(false);
    expect(codexConnectorsAvailable(undefined)).toBe(false);
  });
});

describe("withCodexAppsMcpServer", () => {
  test("appends exactly one codex_apps entry with the right metadata and NO headers", () => {
    const settings = testSettings({ mcpServers: [] });
    const result = withCodexAppsMcpServer(settings, BOTH_SCOPES);
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
    const once = withCodexAppsMcpServer(testSettings({ mcpServers: [] }), BOTH_SCOPES);
    const twice = withCodexAppsMcpServer(once, BOTH_SCOPES);
    expect(twice).toBe(once); // same reference, no change
    expect(twice.mcpServers.filter((s) => s.id === "codex_apps")).toHaveLength(1);
  });

  test("is a no-op when scopes are null, empty, or missing one connector scope", () => {
    for (const scopes of [null, "", "api.connectors.read"]) {
      const settings = testSettings({ mcpServers: [] });
      const result = withCodexAppsMcpServer(settings, scopes);
      expect(result).toBe(settings); // same reference, nothing injected
    }
  });

  test("preserves pre-existing mcp servers", () => {
    const settings = testSettings({ mcpServers: [{ id: "opengeni", name: "OpenGeni", url: "http://x/mcp", cacheToolsList: false }] });
    const result = withCodexAppsMcpServer(settings, BOTH_SCOPES);
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

  test("active credential WITHOUT connector scopes => provider injected, no codex_apps server", async () => {
    const restore = mockCredentialStatus({ status: "active", scopes: null });
    try {
      const settings = testSettings({ codexSubscriptionEnabled: true, modelProvidersJson: "[]", mcpServers: [] });
      const result = await settingsWithCodexCredential({} as unknown as Database, "ws_1", settings);
      expect(parseModelProvidersJson(result.modelProvidersJson).some((p) => p.id === "codex-subscription")).toBe(true);
      expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(false);
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
 * Swaps @opengeni/db's getCodexCredentialStatus (the ONLY db read on the overlay
 * path) for a stub, so settingsWithCodexCredential can be exercised end-to-end
 * without a live Postgres. Returns a restorer that reinstates the real module.
 */
function mockCredentialStatus(overrides: { status: string; scopes: string | null }): () => void {
  const actual = require("@opengeni/db");
  mock.module("@opengeni/db", () => ({
    ...actual,
    getCodexCredentialStatus: async () => ({
      connected: overrides.status === "active",
      chatgptAccountId: "acct-1",
      scopes: overrides.scopes,
      planType: "pro",
      status: overrides.status,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
    }),
  }));
  return () => {
    mock.module("@opengeni/db", () => actual);
  };
}
