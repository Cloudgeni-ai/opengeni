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

const SEARXNG = "https://search.internal.example";
const searxngTarget = { route: "web_search.searxng", endpoint: SEARXNG } as const;

/** One declaration in `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON`: a route at one endpoint. */
function declarations(entries: Record<string, { endpoint: string; residency: unknown }>): string {
  return JSON.stringify(entries);
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings(overrides);
}

describe("side-feature residency records", () => {
  test("every route without an operator declaration is not EU", () => {
    const base = settings();
    for (const route of SIDE_FEATURE_ROUTE_IDS) {
      expect(sideFeatureRouteIsEu(base, { route, endpoint: SEARXNG })).toBe(false);
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
    expect(sideFeatureRouteResidency(settings(), searxngTarget).geography).toBe("unknown");
    const declared = settings({
      sideFeatureResidencyJson: declarations({
        "web_search.searxng": { endpoint: `${SEARXNG}/`, residency: euSelfHosted },
      }),
    });
    // The declaration names an origin; any path at it is the same deployment.
    expect(
      sideFeatureRouteIsEu(declared, { ...searxngTarget, endpoint: `${SEARXNG}/search` }),
    ).toBe(true);
    expect(sideFeatureRouteResidency(declared, searxngTarget)).toMatchObject({
      geography: "eu",
      deploymentType: "self_hosted",
      regions: ["fsn1"],
    });
  });

  test("a declaration covers only the endpoint it names", () => {
    const declared = settings({
      sideFeatureResidencyJson: declarations({
        "web_search.searxng": { endpoint: SEARXNG, residency: euSelfHosted },
        "decision_model.openai": {
          endpoint: "https://decide.example.com/v1",
          residency: euDataZone,
        },
      }),
    });
    // Another host, or no endpoint at all, is unknown.
    for (const endpoint of ["https://search.other.example", "not a url", null, undefined]) {
      expect(sideFeatureRouteIsEu(declared, { route: "web_search.searxng", endpoint })).toBe(false);
    }
    // A declaration for one route does not cover another at the same endpoint.
    expect(sideFeatureRouteIsEu(declared, { route: "web_search.jina", endpoint: SEARXNG })).toBe(
      false,
    );
    // A declarable route named without its endpoint is unknown.
    expect(
      sideFeatureRouteIsEu(declared, { route: "decision_model.openai", endpoint: undefined }),
    ).toBe(false);
  });

  test("vendor default hosts keep their code-owned rule and cannot be declared", () => {
    for (const [route, endpoint, geography] of [
      ["decision_model.openai", "https://api.openai.com/v1", "us"],
      ["knowledge.embeddings", "https://api.openai.com/v1", "us"],
      ["web_search.firecrawl", "https://api.firecrawl.dev", "unknown"],
      ["web_search.jina", "https://s.jina.ai", "unknown"],
      ["web_search.jina", "https://r.jina.ai", "unknown"],
    ] as const) {
      const residency = sideFeatureRouteResidency(settings(), { route, endpoint });
      expect(residency.geography).toBe(geography);
      expect(residency.evidence.source).toBe("built_in_rule");
      expect(() =>
        parseSideFeatureResidencyJson(
          declarations({ [route]: { endpoint, residency: euDataZone } }),
        ),
      ).toThrow(/vendor default host/u);
    }
  });

  test("a route's id never grants EU: only its record does", () => {
    // Every route id names an integration, not a region; none is EU by default.
    for (const route of SIDE_FEATURE_ROUTE_IDS) {
      expect(route).not.toMatch(/(^|[._-])eu([._-]|$)/u);
    }
    const azure = "https://live.example.azure.com";
    const declaredUnknown = settings({
      sideFeatureResidencyJson: declarations({
        "realtime_voice.azure_live": {
          endpoint: azure,
          residency: { ...euSelfHosted, geography: "unknown" },
        },
      }),
    });
    expect(
      sideFeatureRouteIsEu(declaredUnknown, {
        route: "realtime_voice.azure_live",
        endpoint: azure,
      }),
    ).toBe(false);
  });

  test("declarations are rejected for unknown or code-owned routes and bad endpoints", () => {
    const valid = { endpoint: SEARXNG, residency: euSelfHosted };
    expect(() => parseSideFeatureResidencyJson(declarations({ "web_search.eu": valid }))).toThrow(
      /unknown side-feature route/u,
    );
    expect(() =>
      parseSideFeatureResidencyJson(declarations({ "web_search.hosted": valid })),
    ).toThrow(/code-owned rule/u);
    expect(() => parseSideFeatureResidencyJson("[")).toThrow(/JSON object/u);
    expect(() =>
      parseSideFeatureResidencyJson(
        declarations({
          "web_search.searxng": { endpoint: SEARXNG, residency: { geography: "eu" } },
        }),
      ),
    ).toThrow(/invalid/u);
    // The old shape, a bare residency with no endpoint, is refused.
    expect(() =>
      parseSideFeatureResidencyJson(JSON.stringify({ "web_search.searxng": euSelfHosted })),
    ).toThrow(/endpoint/u);
    expect(() =>
      parseSideFeatureResidencyJson(
        declarations({
          "web_search.searxng": { endpoint: "ftp://search", residency: euSelfHosted },
        }),
      ),
    ).toThrow(/http\(s\) URL/u);
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
    const valid = { endpoint: SEARXNG, residency: euSelfHosted };
    expect(() => boot({ nope: valid })).toThrow();
    expect(() => boot({ "web_search.hosted": valid })).toThrow();
    expect(() => boot({ "web_search.searxng": euSelfHosted })).toThrow();
    expect(() =>
      boot({
        "decision_model.openai": { endpoint: "https://api.openai.com/v1", residency: euDataZone },
      }),
    ).toThrow();
    expect(sideFeatureRouteIsEu(boot({ "web_search.searxng": valid }), searxngTarget)).toBe(true);
  });

  test("routes may run anywhere without the EU requirement and only on EU records under it", () => {
    expect(sideFeatureRouteAllowed(settings(), "web_search.hosted")).toBe(true);
    const eu = settings({ requiredModelGeography: "eu" });
    expect(sideFeatureRouteAllowed(eu, "web_search.hosted")).toBe(false);
    expect(sideFeatureRouteAllowed(eu, searxngTarget)).toBe(false);
    expect(
      sideFeatureRouteAllowed(
        {
          ...eu,
          sideFeatureResidencyJson: declarations({
            "web_search.searxng": { endpoint: SEARXNG, residency: euSelfHosted },
          }),
        },
        searxngTarget,
      ),
    ).toBe(true);
  });

  test("the recorded processing residency is the claim, never the evidence", () => {
    const declared = settings({
      sideFeatureResidencyJson: declarations({
        "web_search.searxng": { endpoint: SEARXNG, residency: euSelfHosted },
      }),
    });
    expect(sideFeatureProcessingResidency(declared, searxngTarget)).toEqual({
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
      searxng: { baseUrl: SEARXNG },
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
      sideFeatureResidencyJson: declarations({
        "web_search.searxng": { endpoint: SEARXNG, residency: euSelfHosted },
      }),
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

  test("Firecrawl and Jina at their vendor hosts are not EU, even when a declaration exists", () => {
    const selfHosted = "https://crawl.internal.example";
    const declared = declarations({
      "web_search.firecrawl": { endpoint: selfHosted, residency: euSelfHosted },
      "web_search.jina": { endpoint: selfHosted, residency: euSelfHosted },
    });
    const vendor = settings({
      webSearchEnabled: true,
      webSearchProvider: "firecrawl,jina",
      webSearchProviderCredentials: {
        firecrawl: { apiKey: "fc-key" },
        jina: { apiKey: "jina-key" },
      },
      requiredModelGeography: "eu",
      sideFeatureResidencyJson: declared,
    });
    expect(webSearchProviderConfig(vendor)).toBeNull();
    const own = settings({
      webSearchEnabled: true,
      webSearchProvider: "firecrawl",
      webSearchProviderCredentials: { firecrawl: { apiKey: "fc-key", baseUrl: selfHosted } },
      requiredModelGeography: "eu",
      sideFeatureResidencyJson: declared,
    });
    expect(webSearchProviderConfig(own)?.search.map((endpoint) => endpoint.provider)).toEqual([
      "firecrawl",
    ]);
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
      sideFeatureResidencyJson: declarations({
        "decision_model.openai": { endpoint: openai.decisionModelBaseUrl, residency: euDataZone },
      }),
    });
    expect(decisionModelConfiguration(eu)?.provider).toBe("openai");
    const undeclared = settings({ ...openai, requiredModelGeography: "eu" });
    expect(decisionModelConfiguration(undeclared)).toBeUndefined();
  });

  test("an OpenAI decision model without a base URL calls api.openai.com and is switched off", () => {
    const { decisionModelBaseUrl: _unused, ...defaultHost } = openai;
    const declaredElsewhere = declarations({
      "decision_model.openai": { endpoint: openai.decisionModelBaseUrl, residency: euDataZone },
    });
    const eu = settings({
      ...defaultHost,
      requiredModelGeography: "eu",
      sideFeatureResidencyJson: declaredElsewhere,
    });
    expect(decisionModelRoute(eu)).toEqual({
      route: "decision_model.openai",
      endpoint: "https://api.openai.com/v1",
    });
    expect(decisionModelConfiguration(eu)).toBeUndefined();
    // A base URL other than the declared one is unknown too.
    expect(
      decisionModelConfiguration(
        settings({
          ...openai,
          decisionModelBaseUrl: "https://other.example.com/v1",
          requiredModelGeography: "eu",
          sideFeatureResidencyJson: declaredElsewhere,
        }),
      ),
    ).toBeUndefined();
  });
});
