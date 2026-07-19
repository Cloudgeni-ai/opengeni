import { describe, expect, test } from "bun:test";
import {
  configuredModels,
  contextInputBudgetTokens,
  parseModelProvidersJson,
  resolveModelProvider,
  settingsWithResolvedModelContext,
} from "@opengeni/config";
import {
  CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT,
  CODEX_MODEL_CONTEXT_WINDOW_TOKENS,
  CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS,
} from "@opengeni/codex";
import { compactionThresholdTokens } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  settingsWithCodexCredential,
  withCodexAppsMcpServer,
  withCodexProvider,
} from "../src/activities/capabilities";

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
    expect(codex?.models.some((m) => m.id === "codex/gpt-5.6-sol")).toBe(true);
    expect(codex?.models.every((m) => m.upstreamModelId === m.id.slice("codex/".length))).toBe(
      true,
    );
  });

  test("declares Codex CLI's raw, effective, and auto-compact token limits", () => {
    const settings = withCodexProvider(testSettings({ modelProvidersJson: "[]" }));
    const providers = parseModelProvidersJson(settings.modelProvidersJson);
    const codex = providers.find((p) => p.id === "codex-subscription");
    // Every codex model carries the (smaller-than-API) subscription window.
    expect(
      codex?.models.every((m) => m.contextWindowTokens === CODEX_MODEL_CONTEXT_WINDOW_TOKENS),
    ).toBe(true);
    // It flows through to the resolved model catalog.
    const sol = configuredModels(settings).find((m) => m.id === "codex/gpt-5.6-sol");
    expect(sol?.id).toBe("codex/gpt-5.6-sol");
    expect(sol?.upstreamModelId).toBe("gpt-5.6-sol");
    expect(sol?.contextWindowTokens).toBe(CODEX_MODEL_CONTEXT_WINDOW_TOKENS);
    expect(sol?.effectiveContextWindowTokens).toBe(CODEX_MODEL_EFFECTIVE_CONTEXT_WINDOW_TOKENS);
    expect(sol?.autoCompactTokenLimit).toBe(CODEX_MODEL_AUTO_COMPACT_TOKEN_LIMIT);

    const resolved = resolveModelProvider(settings, "codex/gpt-5.6-sol")!;
    expect(resolved.model.upstreamModelId).toBe("gpt-5.6-sol");
    const turnSettings = settingsWithResolvedModelContext(settings, resolved.model);
    expect(contextInputBudgetTokens(turnSettings)).toBe(258_400);
    const trigger = compactionThresholdTokens(turnSettings);
    expect(trigger).toBe(244_800);
    expect(trigger).toBeLessThan(contextInputBudgetTokens(turnSettings));
    // Contrast: the old 1.05M global default never fired before the cliff.
    const globalTrigger = compactionThresholdTokens({
      contextWindowTokens: 1_050_000,
      contextReservedOutputTokens: settings.contextReservedOutputTokens,
      contextCompactionThresholdRatio: settings.contextCompactionThresholdRatio,
    });
    expect(globalTrigger).toBeGreaterThan(340_000);
  });

  test("preserves existing registry providers", () => {
    const existing = JSON.stringify([
      { id: "fireworks", baseUrl: "https://api.fireworks.ai", models: [{ id: "glm" }] },
    ]);
    const result = withCodexProvider(testSettings({ modelProvidersJson: existing }));
    const ids = parseModelProvidersJson(result.modelProvidersJson).map((p) => p.id);
    expect(ids).toContain("fireworks");
    expect(ids).toContain("codex-subscription");
  });

  test("is idempotent — a second call does not double-inject", () => {
    const once = withCodexProvider(testSettings({ modelProvidersJson: "[]" }));
    const twice = withCodexProvider(once);
    expect(twice).toBe(once); // same reference: no change
    expect(
      parseModelProvidersJson(twice.modelProvidersJson).filter((p) => p.id === "codex-subscription")
        .length,
    ).toBe(1);
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
    const settings = testSettings({
      mcpServers: [
        { id: "opengeni", name: "OpenGeni", url: "http://x/mcp", cacheToolsList: false },
      ],
    });
    const result = withCodexAppsMcpServer(settings);
    const ids = result.mcpServers.map((s) => s.id);
    expect(ids).toContain("opengeni");
    expect(ids).toContain("codex_apps");
  });
});

describe("settingsWithCodexCredential", () => {
  test("is a no-op when the feature is disabled (never touches the db)", async () => {
    const settings = testSettings({ codexSubscriptionEnabled: false, modelProvidersJson: "[]" });
    const result = await settingsWithCodexCredential(
      undefined as unknown as Database,
      "ws_1",
      settings,
    );
    expect(result).toBe(settings); // same reference, no db access
  });

  test("active credential WITHOUT connector scopes => provider AND codex_apps server (scopes do not gate)", async () => {
    const settings = testSettings({
      codexSubscriptionEnabled: true,
      modelProvidersJson: "[]",
      mcpServers: [],
    });
    const result = await settingsWithCodexCredential(
      {} as unknown as Database,
      "ws_1",
      settings,
      true,
    );
    expect(
      parseModelProvidersJson(result.modelProvidersJson).some((p) => p.id === "codex-subscription"),
    ).toBe(true);
    // Connectors are account-gated server-side; a scope-less pro token still lists tools.
    expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(true);
  });

  test("active credential WITH connector scopes => both provider and codex_apps server", async () => {
    const settings = testSettings({
      codexSubscriptionEnabled: true,
      modelProvidersJson: "[]",
      mcpServers: [],
    });
    const result = await settingsWithCodexCredential(
      {} as unknown as Database,
      "ws_1",
      settings,
      true,
    );
    expect(
      parseModelProvidersJson(result.modelProvidersJson).some((p) => p.id === "codex-subscription"),
    ).toBe(true);
    expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(true);
  });

  test("inactive credential => nothing new (no codex_apps server)", async () => {
    const settings = testSettings({
      codexSubscriptionEnabled: true,
      modelProvidersJson: "[]",
      mcpServers: [],
    });
    const result = await settingsWithCodexCredential(
      {} as unknown as Database,
      "ws_1",
      settings,
      false,
    );
    expect(result).toBe(settings); // untouched
  });
});
