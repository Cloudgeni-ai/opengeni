import { describe, expect, test } from "bun:test";
import { COMPUTER_SCREENSHOT_RETENTION_MS, type ModelResidencyV1 } from "@opengeni/contracts";
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
import { normalizedCodexRequestBody } from "@opengeni/codex";
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
    api?: string;
    baseUrl?: string | null;
    wireProfile?: string | null;
  },
): PrivacyFactsRoute {
  const { kind, api, baseUrl, wireProfile, ...rest } = overrides;
  return {
    modelId: "m",
    modelLabel: "Model",
    provider: {
      id: "p",
      label: "Provider",
      kind: kind ?? "api-key",
      api: api ?? "responses",
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
  subprocessorsUrl: null,
  dataHostingLocation: null,
  sandboxes: { backend: "modal", regions: null },
  sessionArchiveIdleDays: 30,
};
const LIVE_OFF: PrivacyFactsLive = { euOnly: false };

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
    expect(PROVIDER_DATA_POLICIES.claude_subscription.location).toBe(NOT_STATED);
    expect(PROVIDER_DATA_POLICIES.unknown.training).toBe("Unknown.");
  });
});

describe("Opengeni's own storage claims in the table", () => {
  test("say what the request code does with provider response storage", () => {
    // The Codex transport forces store:false, so that row may say so.
    const codex = normalizedCodexRequestBody(
      { model: "gpt-6-luna", input: [], store: true },
      (slug) => slug,
    );
    expect(codex.store).toBe(false);
    expect(PROVIDER_DATA_POLICIES.codex_subscription.opengeni).toContain(
      "Opengeni asks OpenAI not to store responses",
    );
    // Main chat turns on Azure and the OpenAI API leave `store` at its default.
    expect(PROVIDER_DATA_POLICIES.openai_api.opengeni).toContain(
      "Opengeni does not turn off Responses API storage for chat turns",
    );
    expect(PROVIDER_DATA_POLICIES.azure_openai.opengeni).toContain(
      "Opengeni does not turn off Responses API storage on Azure chat turns",
    );
    for (const family of ["openai_api", "azure_openai", "vercel_ai_gateway"] as const) {
      expect(PROVIDER_DATA_POLICIES[family].opengeni ?? "").not.toContain(
        "asks OpenAI not to store",
      );
    }
    // Statements about Opengeni's own requests live only in `opengeni`.
    for (const policy of Object.values(PROVIDER_DATA_POLICIES)) {
      expect(`${policy.training} ${policy.retention} ${policy.location}`).not.toMatch(
        /Opengeni (does not|asks)/,
      );
    }
  });

  test("are shown for a direct route but not for a gateway's upstream provider", () => {
    const direct = renderPrivacyFacts({
      route: route({ kind: "direct-openai-workspace" }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(direct).toContain(
      "- Opengeni's requests: Opengeni does not turn off Responses API storage for chat turns.",
    );
    const gateway = renderPrivacyFacts({
      route: route({ baseUrl: "https://ai-gateway.vercel.sh/v1", gatewayOnly: ["openai"] }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(gateway).toContain("Upstream provider behind the gateway");
    expect(gateway).not.toContain("Opengeni's requests:");
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
      route({
        api: "chat",
        wireProfile: "openai",
        baseUrl: AZURE_NEU,
        upstreamModelId: "FW-GLM-5.3-Flash",
      }),
      "azure_foundry_fireworks",
    ],
    [
      "bedrock global profile behind the bridge",
      route({
        api: "anthropic-messages",
        baseUrl: BEDROCK_BRIDGE,
        upstreamModelId: "global.anthropic.claude-opus-5-5",
      }),
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
    [
      "Bedrock endpoint host",
      route({
        baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1",
        upstreamModelId: "eu.anthropic.claude-sonnet-5-5",
      }),
      "amazon_bedrock",
    ],
    [
      "a Bedrock-looking model id on a self-hosted server is not Bedrock",
      route({ baseUrl: "http://vllm.internal:8000/v1", upstreamModelId: "qwen.qwen3-32b" }),
      "unknown",
    ],
    [
      "a Bedrock-looking model id on a workspace's own endpoint is not Bedrock",
      route({
        kind: "direct-compatible-workspace",
        baseUrl: "https://my-bedrock.example.com/v1",
        upstreamModelId: "openai.gpt-oss-120b",
      }),
      "unknown",
    ],
    [
      "Claude through Anthropic's Messages API on an Azure host is not Azure OpenAI",
      route({
        api: "anthropic-messages",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        upstreamModelId: "claude-opus-5-5",
      }),
      "unknown",
    ],
    [
      "a partner model over chat on an Azure host is not Azure OpenAI",
      route({
        api: "chat",
        baseUrl: "https://example.services.ai.azure.com/models",
        upstreamModelId: "Some-Partner-Model",
      }),
      "unknown",
    ],
    [
      "Claude on a declared Azure route is still not Azure OpenAI",
      route({
        api: "anthropic-messages",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        upstreamModelId: "claude-opus-5-5",
        residency: EU_AZURE,
      }),
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
    expect(text).toContain("Chats idle for 30 days, unless marked to stay live, become read-only");
    expect(text).not.toContain("Declared as processing in the EU");
  });

  test("Opengeni's own retention lines follow the code that enforces them", () => {
    const text = renderPrivacyFacts({ route: route({}), live: LIVE_OFF, deployment: DEPLOYMENT });
    const days = COMPUTER_SCREENSHOT_RETENTION_MS / 86_400_000;
    expect(Number.isInteger(days)).toBe(true);
    expect(text).toContain(`are deleted ${days} days after they are stored`);
    expect(text).toContain("Opengeni does not delete them by age.");
    // The departing-member rule is admin-only; the tool names where it lives.
    expect(text).toContain("an organization admin's setting in organization settings decides");
    expect(text).not.toMatch(/deleted \d+ days after they leave/u);
  });

  test("EU-only on with an EU data zone route states the declared regions", () => {
    const text = renderPrivacyFacts({
      route: route({ wireProfile: "azure-openai", baseUrl: AZURE_NEU, residency: EU_AZURE }),
      live: { euOnly: true },
      deployment: DEPLOYMENT,
    });
    expect(text).toContain(
      "Where this route runs: Declared as processing in the EU (swedencentral), deployment type azure_data_zone.",
    );
    expect(text).toContain("EU-only: on.");
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
      "Upstream provider behind the gateway (that provider's public default for its own API customers; Vercel's agreement with it may differ): Google Cloud Vertex AI (Gemini)",
    );
  });

  test("unknown routes, unreadable settings and missing links are stated as such", () => {
    const text = renderPrivacyFacts({
      route: { ...route({ baseUrl: "http://vllm.internal:8000/v1" }), credentialSource: null },
      live: { euOnly: null },
      deployment: {
        privacyPolicyUrl: null,
        termsOfServiceUrl: null,
        supportEmail: null,
        subprocessorsUrl: null,
        dataHostingLocation: null,
        sandboxes: { backend: "daytona", regions: null },
        sessionArchiveIdleDays: null,
      },
    });
    expect(text).toContain("Trains on the data: Unknown.");
    expect(text).toContain("Sources: none; this provider is not in Opengeni's reviewed table.");
    expect(text).toContain("Paid through: Unknown.");
    expect(text).toContain("EU-only: unknown (could not be read).");
    expect(text).toContain("Privacy policy: not configured on this deployment");
    expect(text).toContain("no contact configured on this deployment");
    expect(text).toContain("Idle chats are not moved to long-term storage");
    expect(text).toContain(
      "Where app data (database, files, backups) is hosted: not declared in this deployment's configuration (unknown).",
    );
    expect(text).toContain("run on daytona; its region is not declared (unknown).");
    expect(text).toContain("Subprocessor list: not published on this deployment");
    expect(text).not.toContain("open the privacy policy");
  });

  test("states the operator's hosting, sandbox placement and subprocessor list", () => {
    const declared = renderPrivacyFacts({
      route: route({}),
      live: LIVE_OFF,
      deployment: {
        ...DEPLOYMENT,
        dataHostingLocation: "Microsoft Azure, North Europe (Ireland)",
        subprocessorsUrl: "https://opengeni.ai/privacy#sharing",
        sandboxes: { backend: "modal", regions: ["eu"] },
      },
    });
    expect(declared).toContain(
      "- App data (database, files, backups) is hosted in: Microsoft Azure, North Europe (Ireland) (the operator's declaration).",
    );
    expect(declared).toContain("run on Modal, placed in region eu.");
    expect(declared).toContain("Subprocessor list: https://opengeni.ai/privacy#sharing");
    expect(declared).toContain("open the privacy policy (or subprocessor list) page now");

    // Unset declarations stay unknown, and the policy is where to look.
    const undeclared = renderPrivacyFacts({
      route: route({}),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(undeclared).toContain("is hosted: not declared in this deployment's configuration");
    expect(undeclared).toContain("run on Modal, not pinned to a region (unknown).");
    expect(undeclared).toContain(
      "Subprocessor list: no separate list configured; check the privacy policy above",
    );
    expect(undeclared).toContain("open the privacy policy (or subprocessor list) page now");

    for (const [backend, expected] of [
      ["docker", "run on this deployment's own servers (docker)."],
      ["none", "this deployment runs no cloud sandboxes."],
    ] as const) {
      const text = renderPrivacyFacts({
        route: route({}),
        live: LIVE_OFF,
        deployment: { ...DEPLOYMENT, sandboxes: { backend, regions: null } },
      });
      expect(text).toContain(expected);
    }
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

  test("never shows upstream model ids or endpoint URLs", () => {
    const text = renderPrivacyFacts({
      route: route({
        baseUrl: AZURE_NEU,
        wireProfile: "openai",
        upstreamModelId: "FW-GLM-5.3-Flash",
      }),
      live: LIVE_OFF,
      deployment: DEPLOYMENT,
    });
    expect(text).toContain("Fireworks AI");
    expect(text).not.toContain("FW-GLM-5.3-Flash");
    expect(text).not.toContain("openai-production-neu");
  });
});

describe("loadPrivacyFactsLive", () => {
  const base = { db: {} as never, accountId: "a", workspaceId: "w" };

  test("deployment EU-only wins without a read", async () => {
    let euReads = 0;
    const live = await loadPrivacyFactsLive({
      ...base,
      deploymentEuOnly: true,
      isEuOnly: async () => {
        euReads += 1;
        return false;
      },
    });
    expect(euReads).toBe(0);
    expect(live).toEqual({ euOnly: true });
  });

  test("reads the workspace setting, and a failed read is unknown", async () => {
    expect(
      await loadPrivacyFactsLive({ ...base, deploymentEuOnly: false, isEuOnly: async () => true }),
    ).toEqual({ euOnly: true });
    expect(
      await loadPrivacyFactsLive({
        ...base,
        deploymentEuOnly: false,
        isEuOnly: async () => {
          throw new Error("db down");
        },
      }),
    ).toEqual({ euOnly: null });
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
