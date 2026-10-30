import { describe, expect, test } from "bun:test";
import type { ModelResidencyV1 } from "@opengeni/contracts";
import {
  PRIVACY_FACTS_TOOL_NAME,
  createPrivacyFactsAttemptToolDefinition,
  loadPrivacyFactsLive,
  privacyFactsRouteForTurn,
  providerDataPolicyFamily,
  renderPrivacyFacts,
  type PrivacyFactsDeployment,
  type PrivacyFactsLive,
  type PrivacyFactsRoute,
} from "../src/activities/agent-turn/privacy-facts";
import {
  NOT_STATED,
  PROVIDER_DATA_POLICIES,
  PROVIDER_DATA_POLICY_FAMILIES,
} from "../src/activities/agent-turn/provider-data-policy";

const AZURE_NEU = "https://openai-production-neu.openai.azure.com/openai/v1";
const BEDROCK_BRIDGE = "http://opengeni-bedrock.opengeni.svc.cluster.local:8080/anthropic/v1";

const EU_AZURE: ModelResidencyV1 = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: { source: "operator_declaration", reference: "Azure deployment", verifiedAt: null },
};
const EU_BEDROCK: ModelResidencyV1 = {
  geography: "eu",
  deploymentType: "bedrock_geo_profile",
  regions: ["eu-central-1", "eu-north-1"],
  evidence: { source: "operator_declaration", reference: "eu profile", verifiedAt: null },
};

function route(
  overrides: Partial<PrivacyFactsRoute> & {
    kind?: string;
    baseUrl?: string | null;
    wireProfile?: string | null;
  },
): PrivacyFactsRoute {
  const { kind, baseUrl, wireProfile, ...rest } = overrides;
  return {
    modelId: "m",
    modelLabel: "Model",
    provider: {
      id: "p",
      label: "Provider",
      kind: kind ?? "api-key",
      wireProfile: wireProfile === undefined ? "openai" : wireProfile,
      builtin: false,
      baseUrl: baseUrl === undefined ? null : baseUrl,
    },
    upstreamModelId: "upstream",
    residency: null,
    gatewayOnly: null,
    credentialSource: { kind: "deployment" },
    ...rest,
  };
}

const DEPLOYMENT: PrivacyFactsDeployment = {
  privacyPolicyUrl: "https://opengeni.ai/privacy",
  termsOfServiceUrl: "https://opengeni.ai/terms",
  supportEmail: "support@opengeni.ai",
  sessionArchiveIdleDays: 30,
};
const LIVE_OFF: PrivacyFactsLive = { euOnly: false, memberRetention: { mode: "retain" } };

describe("provider data policy table", () => {
  test("every row is complete and every known row cites provider documentation", () => {
    for (const family of PROVIDER_DATA_POLICY_FAMILIES) {
      const row = PROVIDER_DATA_POLICIES[family];
      expect(row.family).toBe(family);
      for (const field of [row.provider, row.training, row.retention, row.location]) {
        expect(field.trim().length).toBeGreaterThan(0);
      }
      if (family === "unknown") {
        expect(row.sources).toEqual([]);
        expect(row.checkedOn).toBeNull();
        continue;
      }
      expect(row.sources.length).toBeGreaterThan(0);
      for (const url of row.sources) expect(new URL(url).protocol).toBe("https:");
      expect(row.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  test("gaps stay unknown rather than guessed", () => {
    expect(PROVIDER_DATA_POLICIES.azure_foundry_fireworks.training).toBe(NOT_STATED);
    expect(PROVIDER_DATA_POLICIES.azure_foundry_fireworks.retention).toBe(NOT_STATED);
    expect(PROVIDER_DATA_POLICIES.xai_subscription.retention).toBe(NOT_STATED);
    expect(PROVIDER_DATA_POLICIES.unknown.training).toBe("Unknown.");
  });
});

describe("providerDataPolicyFamily", () => {
  test.each([
    [
      "azure-sol (built-in style Azure route)",
      route({ wireProfile: "azure-openai", baseUrl: AZURE_NEU, upstreamModelId: "gpt-6.1-sol" }),
      "azure_openai",
    ],
    [
      "azure-eu data zone",
      route({
        wireProfile: "azure-openai",
        baseUrl: AZURE_NEU,
        upstreamModelId: "gpt-6.1-sol-eu",
        residency: EU_AZURE,
      }),
      "azure_openai",
    ],
    [
      "azure-flash Fireworks on Foundry",
      route({ wireProfile: "openai", baseUrl: AZURE_NEU, upstreamModelId: "FW-GLM-5.3-Flash" }),
      "azure_foundry_fireworks",
    ],
    [
      "bedrock global profile behind the bridge",
      route({ baseUrl: BEDROCK_BRIDGE, upstreamModelId: "global.anthropic.claude-opus-5-5" }),
      "amazon_bedrock",
    ],
    [
      "bedrock-eu profile",
      route({
        baseUrl: BEDROCK_BRIDGE,
        upstreamModelId: "eu.anthropic.claude-opus-5-5",
        residency: EU_BEDROCK,
      }),
      "amazon_bedrock",
    ],
    [
      "vertex through Vercel AI Gateway",
      route({
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        upstreamModelId: "vmc/gemini-4-argon-vertex",
      }),
      "vercel_ai_gateway",
    ],
    ["managed Vercel gateway kind", route({ kind: "vercel-gateway-managed" }), "vercel_ai_gateway"],
    [
      "codex subscription",
      route({ kind: "codex-subscription", baseUrl: "https://chatgpt.com/backend-api/codex" }),
      "codex_subscription",
    ],
    [
      "SuperGrok subscription",
      route({ kind: "xai-subscription", baseUrl: "https://api.x.ai/v1" }),
      "xai_subscription",
    ],
    [
      "Claude subscription",
      route({ kind: "claude-subscription-workspace", baseUrl: "https://api.anthropic.com" }),
      "claude_subscription",
    ],
    ["Anthropic organization key", route({ kind: "anthropic-organization" }), "anthropic_api"],
    ["OpenAI workspace key", route({ kind: "direct-openai-workspace" }), "openai_api"],
    ["Azure organization key", route({ kind: "direct-azure-organization" }), "azure_openai"],
    ["OpenRouter managed", route({ kind: "openrouter-managed" }), "openrouter"],
    [
      "Opper managed",
      route({ kind: "opper-managed", upstreamModelId: "aws/claude-opus-5-5" }),
      "opper",
    ],
    [
      "xAI API host",
      route({ baseUrl: "https://api.x.ai/v1", upstreamModelId: "grok-5" }),
      "xai_api",
    ],
    [
      "custom compatible endpoint",
      route({ kind: "direct-compatible-workspace", baseUrl: "https://llm.example.com/v1" }),
      "unknown",
    ],
    [
      "self-hosted api-key route",
      route({ baseUrl: "http://vllm.internal:8000/v1", upstreamModelId: "qwen3" }),
      "unknown",
    ],
    [
      "look-alike host is not Azure",
      route({ baseUrl: "https://openai.azure.com.evil.example/v1" }),
      "unknown",
    ],
    ["no provider", { ...route({}), provider: null }, "unknown"],
  ] as const)("%s", (_name, input, family) => {
    expect(providerDataPolicyFamily(input)).toBe(family);
  });
});

describe("privacyFactsRouteForTurn", () => {
  const policy = {
    productModelId: "gpt-6-luna",
    upstreamModelId: "gpt-6-luna",
    credentialSource: { kind: "deployment", mechanism: "api_key" },
  };

  test("the legacy fallback describes the built-in Azure client", () => {
    const result = privacyFactsRouteForTurn({
      settings: { openaiProvider: "azure", azureOpenaiBaseUrl: AZURE_NEU },
      policy,
      resolved: null,
    });
    expect(result.provider?.label).toBe("Azure OpenAI");
    expect(result.residency).toBeNull();
    expect(providerDataPolicyFamily(result)).toBe("azure_openai");
  });

  test("the legacy fallback describes the built-in OpenAI client", () => {
    const result = privacyFactsRouteForTurn({
      settings: { openaiProvider: "openai" },
      policy,
      resolved: null,
    });
    expect(providerDataPolicyFamily(result)).toBe("openai_api");
  });
});

describe("renderPrivacyFacts", () => {
  test("EU-only off with an undeclared route never claims the EU", () => {
    const text = renderPrivacyFacts({
      route: route({
        wireProfile: "azure-openai",
        baseUrl: AZURE_NEU,
        modelId: "azure-sol/gpt-6.1-sol",
        modelLabel: "GPT-6.1 Sol",
        upstreamModelId: "gpt-6.1-sol",
      }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(text).toContain("Model: GPT-6.1 Sol (azure-sol/gpt-6.1-sol)");
    expect(text).toContain("Where this route runs: Not declared for this route (unknown).");
    expect(text).toContain("EU-only: off.");
    expect(text).toContain("Microsoft Azure OpenAI");
    expect(text).toContain("Sources (checked 2026-10-30): https://learn.microsoft.com/");
    expect(text).toContain("Privacy policy: https://opengeni.ai/privacy");
    expect(text).toContain("support@opengeni.ai");
    expect(text).toContain("Chats idle for 30 days become read-only");
    expect(text).not.toContain("Declared as processing in the EU");
  });

  test("EU-only on with an EU data zone route states the declared regions", () => {
    const text = renderPrivacyFacts({
      route: route({ wireProfile: "azure-openai", baseUrl: AZURE_NEU, residency: EU_AZURE }),
      live: { euOnly: true, memberRetention: { mode: "delete_after", days: 60 } },
      deployment: DEPLOYMENT,
    });
    expect(text).toContain(
      "Where this route runs: Declared as processing in the EU (swedencentral), deployment type azure_data_zone.",
    );
    expect(text).toContain("EU-only: on.");
    expect(text).toContain("deleted 60 days after they leave");
  });

  test("a gateway route shows its pinned upstream, or says the upstream is unknown", () => {
    const unpinned = renderPrivacyFacts({
      route: route({ baseUrl: "https://ai-gateway.vercel.sh/v1" }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(unpinned).toContain(
      "Upstream provider behind the gateway: not pinned by this route (unknown).",
    );
    const pinned = renderPrivacyFacts({
      route: route({ baseUrl: "https://ai-gateway.vercel.sh/v1", gatewayOnly: ["vertex"] }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(pinned).toContain(
      "Upstream provider behind the gateway: Google Cloud Vertex AI (Gemini)",
    );
  });

  test("unknown routes, unreadable settings and missing links are stated as such", () => {
    const text = renderPrivacyFacts({
      route: { ...route({ baseUrl: "http://vllm.internal:8000/v1" }), credentialSource: null },
      live: { euOnly: null, memberRetention: null },
      deployment: {
        privacyPolicyUrl: null,
        termsOfServiceUrl: null,
        supportEmail: null,
        sessionArchiveIdleDays: null,
      },
    });
    expect(text).toContain("Trains on the data: Unknown.");
    expect(text).toContain("Sources: none; this provider is not in Opengeni's reviewed table.");
    expect(text).toContain("Paid through: Unknown.");
    expect(text).toContain("EU-only: unknown (could not be read).");
    expect(text).toContain("When a member leaves the organization: unknown (could not be read).");
    expect(text).toContain("Privacy policy: not configured on this deployment");
    expect(text).toContain("no contact configured on this deployment");
    expect(text).toContain("Idle chats are not moved to long-term storage");
  });

  test("subscription routes say the account's own terms apply", () => {
    const text = renderPrivacyFacts({
      route: route({
        kind: "codex-subscription",
        credentialSource: { kind: "connected_subscription", provider: "codex" },
      }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(text).toContain(
      "A connected ChatGPT subscription; that account's own settings and terms",
    );
    expect(text).toContain("Improve the model for everyone");
  });
});

describe("loadPrivacyFactsLive", () => {
  const db = {} as never;
  const base = { db, accountId: "a", workspaceId: "w", actorSubjectId: "user:1" };

  test("deployment EU-only wins without a read; an admin sees the member rule", async () => {
    let euReads = 0;
    const live = await loadPrivacyFactsLive({
      ...base,
      deploymentEuOnly: true,
      isEuOnly: async () => {
        euReads += 1;
        return false;
      },
      getRetentionPolicy: async () => ({ mode: "delete_after", retentionDays: 45 }) as never,
    });
    expect(euReads).toBe(0);
    expect(live).toEqual({ euOnly: true, memberRetention: { mode: "delete_after", days: 45 } });
  });

  test("a non-admin refusal is not_visible; other failures are unknown", async () => {
    const refused = await loadPrivacyFactsLive({
      ...base,
      deploymentEuOnly: false,
      isEuOnly: async () => true,
      getRetentionPolicy: async () => {
        throw Object.assign(new Error("organization administration required"), { code: "42501" });
      },
    });
    expect(refused).toEqual({ euOnly: true, memberRetention: { mode: "not_visible" } });
    const failed = await loadPrivacyFactsLive({
      ...base,
      deploymentEuOnly: false,
      isEuOnly: async () => {
        throw new Error("db down");
      },
      getRetentionPolicy: async () => {
        throw new Error("db down");
      },
    });
    expect(failed).toEqual({ euOnly: null, memberRetention: null });
  });

  test("a turn without a person cannot read the admin-only rule", async () => {
    const live = await loadPrivacyFactsLive({
      ...base,
      actorSubjectId: null,
      deploymentEuOnly: false,
      isEuOnly: async () => false,
      getRetentionPolicy: async () => {
        throw new Error("must not be called");
      },
    });
    expect(live.memberRetention).toEqual({ mode: "not_visible" });
  });
});

describe("privacy_facts tool", () => {
  test("is a read-only, argument-free Opengeni tool that renders live facts", async () => {
    let loads = 0;
    const definition = createPrivacyFactsAttemptToolDefinition({
      route: route({ kind: "direct-openai-workspace" }),
      deployment: DEPLOYMENT,
      loadLive: async () => {
        loads += 1;
        return LIVE_OFF;
      },
    });
    expect(definition.modelName).toBe(PRIVACY_FACTS_TOOL_NAME);
    expect(definition.identity).toEqual({ serverId: "opengeni", toolName: "privacy_facts" });
    expect(definition.approval).toBe("none");
    expect(definition.annotations?.readOnlyHint).toBe(true);
    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const result = await definition.execute({}, {} as never);
    expect(loads).toBe(1);
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Provider: OpenAI API");
    await expect(definition.execute({ x: 1 }, {} as never)).rejects.toThrow("accepts no arguments");
  });
});
