import { describe, expect, test } from "bun:test";
import {
  getSettings,
  resolveWebSearchProvider,
  webSearchCallPricing,
  webSearchCreditMicros,
  webSearchProviderConfig,
  webSearchToolPlan,
  type WebSearchSettings,
} from "../src";

const base: WebSearchSettings = { webSearchEnabled: true };

describe("web search provider configuration", () => {
  test("is off by default and when web search is turned off on the server", () => {
    expect(resolveWebSearchProvider(base)).toEqual({ status: "off" });
    expect(resolveWebSearchProvider({ ...base, webSearchProvider: "none" })).toEqual({
      status: "off",
    });
    expect(
      resolveWebSearchProvider({
        webSearchEnabled: false,
        webSearchProvider: "tinyfish",
        webSearchApiKey: "key",
      }),
    ).toEqual({ status: "off" });
    const settings = getSettings({ OPENGENI_ENV: "test" });
    expect(resolveWebSearchProvider(settings)).toEqual({ status: "off" });
  });

  test("reads every setting from the environment", () => {
    const settings = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_WEB_SEARCH_PROVIDER: "brave",
      OPENGENI_WEB_SEARCH_API_KEY: "brave-key",
      OPENGENI_WEB_FETCH_PROVIDER: "jina",
      OPENGENI_WEB_SEARCH_PROVIDER_MODE: "replace",
      OPENGENI_WEB_SEARCH_PRICING_JSON: '{"searchMicros":5000,"fetchMicros":0}',
      OPENGENI_WEB_SEARCH_REQUEST_TIMEOUT_MS: "9000",
    });
    expect(webSearchProviderConfig(settings)).toEqual({
      mode: "replace",
      search: { provider: "brave", apiKey: "brave-key", baseUrl: null },
      fetch: { provider: "jina", apiKey: null, baseUrl: null },
      pricingOverride: { searchMicros: 5000, fetchMicros: 0 },
      timeoutMs: 9000,
    });
  });

  test("the search provider fetches too when it can", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "TinyFish",
      webSearchApiKey: "key",
    });
    expect(config?.search.provider).toBe("tinyfish");
    expect(config?.fetch).toEqual(config!.search);
    expect(config?.mode).toBe("fallback");
    const brave = webSearchProviderConfig({
      ...base,
      webSearchProvider: "brave",
      webSearchApiKey: "k",
    });
    expect(brave?.fetch).toBeNull();
  });

  test("a misconfiguration withholds the tools with a reason", () => {
    const cases: Array<[WebSearchSettings, string]> = [
      [{ ...base, webSearchProvider: "google" }, "OPENGENI_WEB_SEARCH_PROVIDER must be one of"],
      [{ ...base, webSearchProvider: "exa" }, "exa search needs OPENGENI_WEB_SEARCH_API_KEY"],
      [
        { ...base, webSearchProvider: "exa", webSearchApiKey: "your-key" },
        "exa search needs OPENGENI_WEB_SEARCH_API_KEY",
      ],
      [{ ...base, webSearchProvider: "searxng" }, "needs OPENGENI_WEB_SEARCH_BASE_URL"],
      [
        { ...base, webSearchProvider: "searxng", webSearchBaseUrl: "ftp://search" },
        "OPENGENI_WEB_SEARCH_BASE_URL must be an absolute http(s) URL",
      ],
      [
        { ...base, webSearchProvider: "tinyfish", webSearchApiKey: "k", webFetchProvider: "brave" },
        "OPENGENI_WEB_FETCH_PROVIDER must be none or one of",
      ],
      [
        { ...base, webSearchProvider: "brave", webSearchApiKey: "k", webFetchProvider: "exa" },
        "exa fetch needs OPENGENI_WEB_FETCH_API_KEY",
      ],
      [
        {
          ...base,
          webSearchProvider: "tinyfish",
          webSearchApiKey: "k",
          webSearchProviderMode: "x",
        },
        "OPENGENI_WEB_SEARCH_PROVIDER_MODE must be fallback or replace",
      ],
      [
        { ...base, webSearchProvider: "tinyfish", webSearchApiKey: "k", webSearchPricingJson: "{" },
        "OPENGENI_WEB_SEARCH_PRICING_JSON must be valid JSON",
      ],
      [
        {
          ...base,
          webSearchProvider: "tinyfish",
          webSearchApiKey: "k",
          webSearchPricingJson: '{"searchMicros":-1,"fetchMicros":0}',
        },
        "OPENGENI_WEB_SEARCH_PRICING_JSON is invalid",
      ],
    ];
    for (const [settings, reason] of cases) {
      const resolution = resolveWebSearchProvider(settings);
      expect(resolution.status).toBe("invalid");
      expect(resolution.status === "invalid" ? resolution.reason : "").toContain(reason);
      expect(webSearchProviderConfig(settings)).toBeNull();
    }
  });

  test("searxng runs keyless against an operator base URL", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "searxng",
      webSearchBaseUrl: "http://searxng.example:8080/",
    });
    expect(config?.search).toEqual({
      provider: "searxng",
      apiKey: null,
      baseUrl: "http://searxng.example:8080",
    });
    expect(config?.fetch).toBeNull();
  });
});

describe("web search tool plan", () => {
  const configured = { ...base, webSearchProvider: "tinyfish", webSearchApiKey: "k" };

  test("unconfigured deployments keep hosted search exactly as resolved", () => {
    expect(webSearchToolPlan(base, { hostedWebSearch: true })).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
    expect(webSearchToolPlan(base, { hostedWebSearch: false })).toEqual({
      hostedWebSearch: false,
      providerTools: [],
    });
  });

  test("fallback offers provider tools only where the model has no hosted search", () => {
    expect(webSearchToolPlan(configured, { hostedWebSearch: true })).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
    expect(webSearchToolPlan(configured, { hostedWebSearch: false })).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
  });

  test("replace swaps SDK-hosted search but never duplicates SuperGrok's transport search", () => {
    const replace = { ...configured, webSearchProviderMode: "replace" };
    expect(webSearchToolPlan(replace, { hostedWebSearch: true })).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
    expect(
      webSearchToolPlan(replace, { hostedWebSearch: true, transportHostedSearch: true }),
    ).toEqual({ hostedWebSearch: true, providerTools: [] });
  });

  test("a search-only provider offers web_search alone", () => {
    expect(
      webSearchToolPlan(
        { ...base, webSearchProvider: "brave", webSearchApiKey: "k" },
        { hostedWebSearch: false },
      ).providerTools,
    ).toEqual(["web_search"]);
  });
});

describe("web search pricing", () => {
  test("built-in list prices carry the 5% margin and keyless calls are free", () => {
    const exa = webSearchProviderConfig({
      ...base,
      webSearchProvider: "exa",
      webSearchApiKey: "k",
    })!;
    expect(webSearchCallPricing(exa, "search")).toEqual({
      providerMicros: 8_000,
      marginBps: 500,
      explicit: false,
    });
    const jina = webSearchProviderConfig({
      ...base,
      webSearchProvider: "brave",
      webSearchApiKey: "k",
      webFetchProvider: "jina",
    })!;
    expect(webSearchCallPricing(jina, "search").providerMicros).toBe(5_000);
    expect(webSearchCallPricing(jina, "fetch").providerMicros).toBe(0);
    const tinyfish = webSearchProviderConfig({
      ...base,
      webSearchProvider: "tinyfish",
      webSearchApiKey: "k",
    })!;
    expect(webSearchCallPricing(tinyfish, "search").providerMicros).toBe(0);
    expect(webSearchCallPricing(tinyfish, "fetch").providerMicros).toBe(0);
  });

  test("an explicit operator price wins", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "firecrawl",
      webSearchApiKey: "k",
      webSearchPricingJson: '{"searchMicros":1660,"fetchMicros":830,"marginBps":1000}',
    })!;
    expect(webSearchCallPricing(config, "fetch")).toEqual({
      providerMicros: 830,
      marginBps: 1000,
      explicit: true,
    });
  });

  test("credit cost rounds up after margin", () => {
    expect(webSearchCreditMicros(5_000, 500)).toBe(5_250);
    expect(webSearchCreditMicros(1, 500)).toBe(2);
    expect(webSearchCreditMicros(0, 500)).toBe(0);
    expect(() => webSearchCreditMicros(-1, 500)).toThrow();
  });
});
