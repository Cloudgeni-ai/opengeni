import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  codeSearchDeploymentPolicy,
  decisionModelConfiguration,
  decisionModelRoute,
  getSettings,
  parseSideFeatureResidencyJson,
  SIDE_FEATURE_ROUTE_IDS,
  SIDE_FEATURE_ROUTES,
  sideFeatureProcessingResidency,
  sideFeatureRouteAllowed,
  sideFeatureRouteIsEu,
  sideFeatureRouteResidency,
  webSearchProviderConfig,
  webSearchToolPlan,
  type Settings,
} from "../src";

const euSelfHosted = {
  geography: "eu",
  deploymentType: "self_hosted",
  regions: ["fsn1"],
  evidence: {
    source: "operator_declaration",
    reference: "SearXNG on the deployment's Hetzner host",
    verifiedAt: "2026-10-26",
  },
} as const;

const euDataZone = {
  geography: "eu",
  deploymentType: "azure_data_zone",
  regions: ["swedencentral"],
  evidence: {
    source: "operator_declaration",
    reference: "Azure OpenAI decision deployment, DataZoneStandard",
    verifiedAt: "2026-10-26",
  },
} as const;

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings(overrides);
}

describe("side-feature residency records", () => {
  test("every route without an operator declaration is not EU", () => {
    const base = settings();
    for (const route of SIDE_FEATURE_ROUTE_IDS) {
      expect(sideFeatureRouteIsEu(base, route)).toBe(false);
    }
  });

  test("code-owned rules carry built-in evidence and are never EU", () => {
    const residency = sideFeatureRouteResidency(settings(), "image_generation.openai_hosted");
    expect(residency.geography).toBe("us");
    expect(residency.evidence.source).toBe("built_in_rule");
    expect(sideFeatureRouteResidency(settings(), "web_search.hosted").geography).toBe("global");
    expect(sideFeatureRouteResidency(settings(), "decision_model.jev").deploymentType).toBe(
      "gateway",
    );
  });

  test("an undeclared declarable route is unknown, and a declaration makes it EU", () => {
    expect(sideFeatureRouteResidency(settings(), "web_search.searxng").geography).toBe("unknown");
    const declared = settings({
      sideFeatureResidencyJson: JSON.stringify({ "web_search.searxng": euSelfHosted }),
    });
    expect(sideFeatureRouteIsEu(declared, "web_search.searxng")).toBe(true);
    expect(sideFeatureRouteResidency(declared, "web_search.searxng")).toMatchObject({
      geography: "eu",
      deploymentType: "self_hosted",
      regions: ["fsn1"],
    });
  });

  test("a route's id never grants EU: only its record does", () => {
    // Every route id names an integration, not a region; none is EU by default.
    for (const route of SIDE_FEATURE_ROUTE_IDS) {
      expect(route).not.toMatch(/(^|[._-])eu([._-]|$)/u);
    }
    const declaredUnknown = settings({
      sideFeatureResidencyJson: JSON.stringify({
        "realtime_voice.azure_live": { ...euSelfHosted, geography: "unknown" },
      }),
    });
    expect(sideFeatureRouteIsEu(declaredUnknown, "realtime_voice.azure_live")).toBe(false);
  });

  test("declarations are rejected for unknown or code-owned routes", () => {
    expect(() =>
      parseSideFeatureResidencyJson(JSON.stringify({ "web_search.eu": euSelfHosted })),
    ).toThrow(/unknown side-feature route/u);
    expect(() =>
      parseSideFeatureResidencyJson(JSON.stringify({ "web_search.hosted": euSelfHosted })),
    ).toThrow(/code-owned rule/u);
    expect(() => parseSideFeatureResidencyJson("[")).toThrow(/JSON object/u);
    expect(() =>
      parseSideFeatureResidencyJson(JSON.stringify({ "web_search.searxng": { geography: "eu" } })),
    ).toThrow(/invalid/u);
    expect(
      Object.entries(SIDE_FEATURE_ROUTES)
        .filter(([, spec]) => spec.declarable)
        .map(([route]) => route),
    ).toEqual([
      "web_search.firecrawl",
      "web_search.jina",
      "web_search.searxng",
      "realtime_voice.azure_live",
      "transcription.azure-openai",
      "transcription.azure-speech",
      "knowledge.embeddings",
      "decision_model.openai",
    ]);
  });

  test("an invalid environment declaration fails boot", () => {
    const boot = (declaration: unknown) =>
      getSettings({
        OPENGENI_OPENAI_API_KEY: "sk-test",
        OPENGENI_SIDE_FEATURE_RESIDENCY_JSON: JSON.stringify(declaration),
      });
    expect(() => boot({ nope: euSelfHosted })).toThrow();
    expect(() => boot({ "web_search.hosted": euSelfHosted })).toThrow();
    expect(
      sideFeatureRouteIsEu(boot({ "web_search.searxng": euSelfHosted }), "web_search.searxng"),
    ).toBe(true);
  });

  test("routes may run anywhere without the EU requirement and only on EU records under it", () => {
    expect(sideFeatureRouteAllowed(settings(), "web_search.hosted")).toBe(true);
    const eu = settings({ requiredModelGeography: "eu" });
    expect(sideFeatureRouteAllowed(eu, "web_search.hosted")).toBe(false);
    expect(sideFeatureRouteAllowed(eu, "web_search.searxng")).toBe(false);
    expect(
      sideFeatureRouteAllowed(
        { ...eu, sideFeatureResidencyJson: JSON.stringify({ "web_search.searxng": euSelfHosted }) },
        "web_search.searxng",
      ),
    ).toBe(true);
  });

  test("the recorded processing residency is the claim, never the evidence", () => {
    const declared = settings({
      sideFeatureResidencyJson: JSON.stringify({ "web_search.searxng": euSelfHosted }),
    });
    expect(sideFeatureProcessingResidency(declared, "web_search.searxng")).toEqual({
      geography: "eu",
      deploymentType: "self_hosted",
      regions: ["fsn1"],
    });
    expect(sideFeatureProcessingResidency(declared, "web_search.exa")).toEqual({
      geography: "unknown",
      deploymentType: "provider_default",
      regions: [],
    });
  });
});

describe("web search under EU-only inference", () => {
  const searchProviders = {
    webSearchEnabled: true,
    webSearchProvider: "exa,searxng",
    webSearchProviderCredentials: {
      exa: { apiKey: "exa-key" },
      searxng: { baseUrl: "https://search.internal.example" },
    },
  } satisfies Partial<Settings>;

  test("hosted search and non-EU providers are removed; no fallback leaves the EU", () => {
    const base = settings(searchProviders);
    const unrestricted = webSearchProviderConfig(base);
    // Precondition: both providers configured, in order.
    expect(unrestricted?.search.map((endpoint) => endpoint.provider)).toEqual(["exa", "searxng"]);

    const euUndeclared = { ...base, requiredModelGeography: "eu" as const };
    expect(webSearchProviderConfig(euUndeclared)).toBeNull();
    expect(
      webSearchToolPlan(euUndeclared, { hostedWebSearch: true, transportHostedSearch: false }),
    ).toEqual({ hostedWebSearch: false, providerTools: [] });

    const euDeclared = {
      ...euUndeclared,
      sideFeatureResidencyJson: JSON.stringify({ "web_search.searxng": euSelfHosted }),
    };
    expect(
      webSearchProviderConfig(euDeclared)?.search.map((endpoint) => endpoint.provider),
    ).toEqual(["searxng"]);
    const plan = webSearchToolPlan(euDeclared, {
      hostedWebSearch: true,
      transportHostedSearch: true,
    });
    expect(plan.hostedWebSearch).toBe(false);
    expect(plan.providerTools).toContain("web_search");
  });

  test("without the EU requirement nothing changes", () => {
    const base = settings(searchProviders);
    expect(
      webSearchToolPlan(base, { hostedWebSearch: true, transportHostedSearch: false })
        .hostedWebSearch,
    ).toBe(true);
  });
});

describe("decision models under EU-only inference", () => {
  const jev = {
    decisionModelProvider: "jev",
    decisionModelId: "jev-decide",
    decisionModelApiKey: "jev-key",
  } as const;
  const openai = {
    decisionModelProvider: "openai",
    decisionModelApiKey: "key",
    decisionModelId: "gpt-decide",
    decisionModelBaseUrl: "https://decide.example.com/v1",
  } as const;

  test("a gateway decision model is switched off, so code search is unavailable", () => {
    const base = settings({ ...jev, codeSearchMode: "default_on" });
    expect(decisionModelConfiguration(base)?.provider).toBe("jev");
    expect(codeSearchDeploymentPolicy(base).available).toBe(true);
    const eu = { ...base, requiredModelGeography: "eu" as const };
    expect(decisionModelConfiguration(eu)).toBeUndefined();
    expect(codeSearchDeploymentPolicy(eu)).toEqual({ available: false, workspaceDefault: "off" });
    // The route is still known, for recording where calls ran.
    expect(decisionModelRoute(eu)).toBe("decision_model.jev");
  });

  test("an OpenAI-compatible decision model declared EU stays on", () => {
    const eu = settings({
      ...openai,
      requiredModelGeography: "eu",
      sideFeatureResidencyJson: JSON.stringify({ "decision_model.openai": euDataZone }),
    });
    expect(decisionModelConfiguration(eu)?.provider).toBe("openai");
    const undeclared = settings({ ...openai, requiredModelGeography: "eu" });
    expect(decisionModelConfiguration(undeclared)).toBeUndefined();
  });
});
