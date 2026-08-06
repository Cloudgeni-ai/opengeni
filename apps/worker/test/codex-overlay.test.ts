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
import { buildOpenGeniAgent, compactionThresholdTokens } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import type { Database } from "@opengeni/db";
import {
  enabledCapabilityMcpToolRefs,
  resolveSessionToolPolicy,
  settingsWithCodexAppsMcpServer,
} from "@opengeni/core";
import { settingsWithCodexCredential, withCodexProvider } from "../src/activities/capabilities";

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
    expect(codex?.models.every((m) => m.hostedWebSearch === true)).toBe(true);
    expect(
      configuredModels(result)
        .filter((model) => model.providerId === "codex-subscription")
        .every(
          (model) =>
            model.hostedWebSearch === true &&
            model.capabilities.hostedTools.webSearch.upstream === "supported" &&
            model.capabilities.hostedTools.webSearch.runnable === true,
        ),
    ).toBe(true);
  });

  test("builds the bounded native web-search manifest only when the turn policy allows it", () => {
    const settings = withCodexProvider(testSettings({ modelProvidersJson: "[]" }));
    const resolved = resolveModelProvider(settings, "codex/gpt-5.6-sol")!;
    const webSearchTools = (allowed: boolean) => {
      const agent = buildOpenGeniAgent(settings, [], {
        model: resolved.model.upstreamModelId,
        hostedWebSearch: resolved.model.hostedWebSearch && allowed,
      });
      return agent.tools.filter(
        (tool) =>
          tool.type === "hosted_tool" &&
          (tool.providerData as { type?: unknown } | undefined)?.type === "web_search",
      );
    };

    const workspaceDefault = webSearchTools(true);
    expect(workspaceDefault).toHaveLength(1);
    expect(workspaceDefault[0]?.providerData).toMatchObject({
      type: "web_search",
      name: "web_search",
      search_context_size: "medium",
    });
    expect(webSearchTools(false)).toHaveLength(0);
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
  // Registration requires both deployment enablement and an active workspace
  // designation. Session policy independently controls visibility.
  test("appends exactly one codex_apps entry with the right metadata and NO headers", () => {
    const settings = testSettings({ codexConnectedAppsEnabled: true, mcpServers: [] });
    const result = settingsWithCodexAppsMcpServer(settings, true);
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
    const once = settingsWithCodexAppsMcpServer(
      testSettings({ codexConnectedAppsEnabled: true, mcpServers: [] }),
      true,
    );
    const twice = settingsWithCodexAppsMcpServer(once, true);
    expect(twice).toBe(once); // same reference, no change
    expect(twice.mcpServers.filter((s) => s.id === "codex_apps")).toHaveLength(1);
  });

  test("preserves pre-existing mcp servers", () => {
    const settings = testSettings({
      codexConnectedAppsEnabled: true,
      mcpServers: [
        { id: "opengeni", name: "OpenGeni", url: "http://x/mcp", cacheToolsList: false },
      ],
    });
    const result = settingsWithCodexAppsMcpServer(settings, true);
    const ids = result.mcpServers.map((s) => s.id);
    expect(ids).toContain("opengeni");
    expect(ids).toContain("codex_apps");
  });

  test("is a no-op when connected apps are disabled", () => {
    const settings = testSettings({ codexConnectedAppsEnabled: false, mcpServers: [] });
    expect(settingsWithCodexAppsMcpServer(settings, true)).toBe(settings);
  });

  test("is a no-op without a workspace-designated Apps credential", () => {
    const settings = testSettings({ codexConnectedAppsEnabled: true, mcpServers: [] });
    expect(settingsWithCodexAppsMcpServer(settings, false)).toBe(settings);
  });

  test("uses workspace defaults without widening explicit session policies", () => {
    const settings = testSettings({
      codexConnectedAppsEnabled: true,
      mcpServers: [
        {
          id: "opengeni",
          name: "OpenGeni",
          url: "http://localhost/mcp",
          cacheToolsList: false,
        },
        {
          id: "host-tools",
          name: "Host tools",
          url: "http://localhost/host-tools",
          cacheToolsList: false,
        },
      ],
    });
    const runtimeSettings = settingsWithCodexAppsMcpServer(settings, true);
    const defaultRefs = enabledCapabilityMcpToolRefs(settings, runtimeSettings);
    expect(defaultRefs).toEqual([{ kind: "mcp", id: "codex_apps", optional: true }]);

    const availableMcpServerIds = runtimeSettings.mcpServers.map((server) => server.id);
    const defaultMcpServerIds = defaultRefs.map((tool) => tool.id);
    const workspaceDefault = resolveSessionToolPolicy({
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
      sessionTools: defaultRefs,
      availableMcpServerIds,
      defaultMcpServerIds,
    });
    expect(workspaceDefault.toolRefs).toContainEqual({
      kind: "mcp",
      id: "codex_apps",
      optional: true,
    });

    const explicit = resolveSessionToolPolicy({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: [{ kind: "mcp", id: "host-tools" }],
      availableMcpServerIds,
      defaultMcpServerIds,
    });
    expect(explicit.toolRefs.map((tool) => tool.id)).toEqual(["host-tools", "opengeni"]);

    const explicitApps = resolveSessionToolPolicy({
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      sessionTools: [{ kind: "mcp", id: "codex_apps" }],
      availableMcpServerIds,
      defaultMcpServerIds,
    });
    expect(explicitApps.toolRefs.map((tool) => tool.id)).toEqual(["codex_apps", "opengeni"]);
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

  test("active credential keeps Codex routing but omits connected apps by default", async () => {
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
    expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(false);
  });

  test("credential resolution does not widen the MCP registry", async () => {
    const settings = testSettings({
      codexSubscriptionEnabled: true,
      codexConnectedAppsEnabled: true,
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
    expect(result.mcpServers.some((s) => s.id === "codex_apps")).toBe(false);
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
