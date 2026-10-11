import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WEB_SEARCH_PROVIDER_CATALOG,
  WEB_SEARCH_PROVIDER_IDS,
  getSettings,
  resolveWebSearchProvider,
  webSearchCallPricing,
  webSearchCreditMicros,
  webSearchEnvironmentVariables,
  webSearchProviderConfig,
  webSearchToolPlan,
  type WebSearchSettings,
} from "../src";

const base: WebSearchSettings = { webSearchEnabled: true };
const keys = (entries: Record<string, string>): WebSearchSettings["webSearchProviderCredentials"] =>
  Object.fromEntries(Object.entries(entries).map(([id, apiKey]) => [id, { apiKey }]));

describe("web search provider catalog", () => {
  test("every provider can search or fetch and has a price source", () => {
    for (const id of WEB_SEARCH_PROVIDER_IDS) {
      const entry = WEB_SEARCH_PROVIDER_CATALOG[id];
      expect(entry.id).toBe(id);
      expect(entry.search ?? entry.fetch).not.toBeNull();
      expect(entry.pricingUrl).toMatch(/^https:\/\//u);
    }
  });

  test("lists every per-provider variable", () => {
    const names = webSearchEnvironmentVariables();
    expect(names).toContain("OPENGENI_WEB_TINYFISH_API_KEY");
    expect(names).toContain("OPENGENI_WEB_SEARXNG_BASE_URL");
    expect(names).toContain("OPENGENI_WEB_SEARCH_PREFER");
    expect(new Set(names).size).toBe(names.length);
  });

  test("the deployment generator passes every variable through", () => {
    const deployment = readFileSync(
      new URL("../../deployment/src/index.ts", import.meta.url),
      "utf8",
    );
    const passthrough = /WEB_SEARCH_PROVIDER_PASSTHROUGH_ENV[^=]*=\s*\[([^\]]*)\]/u.exec(
      deployment,
    )?.[1];
    const listed = [...(passthrough ?? "").matchAll(/"([A-Z0-9_]+)"/gu)].map((match) => match[1]);
    expect(new Set(listed)).toEqual(new Set(webSearchEnvironmentVariables()));
  });
});

describe("web search provider configuration", () => {
  test("is off without a provider key, when set to none, and when web search is off", () => {
    expect(resolveWebSearchProvider(base)).toEqual({ status: "off" });
    expect(resolveWebSearchProvider({ ...base, webSearchProvider: "none" })).toEqual({
      status: "off",
    });
    expect(
      resolveWebSearchProvider({
        webSearchEnabled: false,
        webSearchProviderCredentials: keys({ tinyfish: "key" }),
      }),
    ).toEqual({ status: "off" });
    // A legacy slot key alone never turns the default provider on.
    expect(resolveWebSearchProvider({ ...base, webSearchApiKey: "key" })).toEqual({
      status: "off",
    });
    expect(resolveWebSearchProvider(getSettings({ OPENGENI_ENV: "test" }))).toEqual({
      status: "off",
    });
  });

  test("defaults to TinyFish search and fetch once its key is set", () => {
    const settings = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_WEB_TINYFISH_API_KEY: "tf-key",
    });
    const tinyfish = { provider: "tinyfish", apiKey: "tf-key", baseUrl: null };
    expect(webSearchProviderConfig(settings)).toEqual({
      preference: "native",
      search: [tinyfish],
      fetch: [tinyfish],
      pricingOverrides: {},
      timeoutMs: 20_000,
    });
  });

  test("reads ordered failover lists and per-provider credentials from the environment", () => {
    const settings = getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_WEB_SEARCH_PROVIDER: "Parallel, tinyfish",
      OPENGENI_WEB_FETCH_PROVIDER: "tinyfish,jina",
      OPENGENI_WEB_PARALLEL_API_KEY: "p-key",
      OPENGENI_WEB_TINYFISH_API_KEY: "tf-key",
      OPENGENI_WEB_JINA_BASE_URL: "http://reader.internal:3000/",
      OPENGENI_WEB_SEARCH_PREFER: "provider",
      OPENGENI_WEB_SEARCH_PRICING_JSON: '{"parallel":{"searchMicros":900,"fetchMicros":900}}',
      OPENGENI_WEB_SEARCH_REQUEST_TIMEOUT_MS: "9000",
    });
    expect(webSearchProviderConfig(settings)).toEqual({
      preference: "provider",
      search: [
        { provider: "parallel", apiKey: "p-key", baseUrl: null },
        { provider: "tinyfish", apiKey: "tf-key", baseUrl: null },
      ],
      fetch: [
        { provider: "tinyfish", apiKey: "tf-key", baseUrl: null },
        { provider: "jina", apiKey: null, baseUrl: "http://reader.internal:3000" },
      ],
      pricingOverrides: { parallel: { searchMicros: 900, fetchMicros: 900 } },
      timeoutMs: 9000,
    });
  });

  test("search providers that can read pages also fetch, in order", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "perplexity,parallel,searxng",
      webSearchProviderCredentials: {
        ...keys({ perplexity: "a", parallel: "b" }),
        searxng: { baseUrl: "http://searxng.internal" },
      },
    });
    expect(config?.search.map((entry) => entry.provider)).toEqual([
      "perplexity",
      "parallel",
      "searxng",
    ]);
    expect(config?.fetch).toEqual([{ provider: "parallel", apiKey: "b", baseUrl: null }]);
    const none = webSearchProviderConfig({
      ...base,
      webSearchProvider: "parallel",
      webFetchProvider: "none",
      webSearchProviderCredentials: keys({ parallel: "b" }),
    });
    expect(none?.fetch).toEqual([]);
  });

  test("earlier single-provider settings still configure the first provider", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "searxng",
      webSearchBaseUrl: "http://searxng.example:8080/",
      webFetchProvider: "jina",
      webSearchProviderMode: "replace",
    });
    expect(config).toEqual({
      preference: "provider",
      search: [{ provider: "searxng", apiKey: null, baseUrl: "http://searxng.example:8080" }],
      fetch: [{ provider: "jina", apiKey: null, baseUrl: null }],
      pricingOverrides: {},
      timeoutMs: 20_000,
    });
    const exa = webSearchProviderConfig({
      ...base,
      webSearchProvider: "exa",
      webSearchApiKey: "exa-key",
    });
    expect(exa?.fetch).toEqual([{ provider: "exa", apiKey: "exa-key", baseUrl: null }]);
    expect(
      webSearchProviderConfig({
        ...base,
        webSearchPrefer: "native",
        webSearchProviderMode: "replace",
        webSearchProvider: "exa",
        webSearchApiKey: "k",
      })?.preference,
    ).toBe("native");
  });

  test("a misconfiguration withholds the tools with a reason", () => {
    const cases: Array<[WebSearchSettings, string]> = [
      [{ ...base, webSearchProvider: "google" }, "OPENGENI_WEB_SEARCH_PROVIDER must be none or"],
      [{ ...base, webSearchProvider: " , " }, "OPENGENI_WEB_SEARCH_PROVIDER names no provider"],
      [{ ...base, webSearchProvider: "exa" }, "exa search needs OPENGENI_WEB_EXA_API_KEY"],
      [
        { ...base, webSearchProvider: "exa", webSearchApiKey: "your-key" },
        "exa search needs OPENGENI_WEB_EXA_API_KEY",
      ],
      [
        {
          ...base,
          webSearchProvider: "tinyfish,parallel",
          webSearchProviderCredentials: keys({ tinyfish: "k" }),
        },
        "parallel search needs OPENGENI_WEB_PARALLEL_API_KEY",
      ],
      [{ ...base, webSearchProvider: "searxng" }, "needs OPENGENI_WEB_SEARXNG_BASE_URL"],
      [
        { ...base, webSearchProvider: "searxng", webSearchBaseUrl: "ftp://search" },
        "OPENGENI_WEB_SEARCH_BASE_URL must be an absolute http(s) URL",
      ],
      [
        {
          ...base,
          webSearchProvider: "searxng",
          webSearchProviderCredentials: { searxng: { baseUrl: "http://u:p@search.example" } },
        },
        "OPENGENI_WEB_SEARXNG_BASE_URL must not embed credentials",
      ],
      [
        { ...base, webSearchProvider: "tinyfish", webSearchApiKey: "k", webFetchProvider: "brave" },
        "OPENGENI_WEB_FETCH_PROVIDER must be none or",
      ],
      [
        { ...base, webSearchProvider: "brave", webSearchApiKey: "k", webFetchProvider: "exa" },
        "exa fetch needs OPENGENI_WEB_EXA_API_KEY",
      ],
      [
        { ...base, webSearchProvider: "tinyfish", webSearchApiKey: "k", webSearchPrefer: "x" },
        "OPENGENI_WEB_SEARCH_PREFER must be native or provider",
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
      [
        {
          ...base,
          webSearchProvider: "tinyfish",
          webSearchApiKey: "k",
          webSearchPricingJson: '{"google":{"searchMicros":1,"fetchMicros":1}}',
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
});

describe("web search tool plan", () => {
  const configured: WebSearchSettings = {
    ...base,
    webSearchProviderCredentials: keys({ tinyfish: "k" }),
  };

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

  test("native preference offers provider tools only where the model has no hosted search", () => {
    expect(webSearchToolPlan(configured, { hostedWebSearch: true })).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
    expect(webSearchToolPlan(configured, { hostedWebSearch: false })).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
  });

  test("provider preference swaps SDK-hosted search but never SuperGrok's transport search", () => {
    const provider = { ...configured, webSearchPrefer: "provider" };
    expect(webSearchToolPlan(provider, { hostedWebSearch: true })).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
    expect(
      webSearchToolPlan(provider, { hostedWebSearch: true, transportHostedSearch: true }),
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

  test("with credits off, a tool stays while any of its providers is free", () => {
    const billed: WebSearchSettings = {
      ...base,
      billingMode: "stripe",
      webSearchProvider: "parallel,tinyfish",
      webFetchProvider: "parallel",
      webSearchProviderCredentials: keys({ parallel: "p", tinyfish: "t" }),
    };
    expect(
      webSearchToolPlan(billed, { hostedWebSearch: false, creditsDisabled: true }).providerTools,
    ).toEqual(["web_search"]);
    expect(
      webSearchToolPlan(
        { ...billed, webSearchProvider: "parallel" },
        { hostedWebSearch: true, creditsDisabled: true },
      ),
    ).toEqual({ hostedWebSearch: true, providerTools: [] });
  });
});

describe("web search pricing", () => {
  test("list prices come from the catalog and keyless calls are free", () => {
    const config = webSearchProviderConfig({
      ...base,
      webSearchProvider: "parallel,perplexity,exa",
      webFetchProvider: "jina",
      webSearchProviderCredentials: keys({ parallel: "a", perplexity: "b", exa: "c" }),
    })!;
    const [parallel, perplexity, exa] = config.search;
    expect(webSearchCallPricing(config, parallel!, "search")).toEqual({
      providerMicros: 1_000,
      marginBps: 500,
      explicit: false,
    });
    expect(webSearchCallPricing(config, perplexity!, "search").providerMicros).toBe(1_000);
    expect(webSearchCallPricing(config, exa!, "search").providerMicros).toBe(8_000);
    expect(webSearchCallPricing(config, config.fetch[0]!, "fetch").providerMicros).toBe(0);
    const tinyfish = webSearchProviderConfig({
      ...base,
      webSearchProviderCredentials: keys({ tinyfish: "k" }),
    })!;
    expect(webSearchCallPricing(tinyfish, tinyfish.search[0]!, "search").providerMicros).toBe(0);
    expect(webSearchCallPricing(tinyfish, tinyfish.fetch[0]!, "fetch").providerMicros).toBe(0);
  });

  test("an explicit operator price wins, flat or per provider", () => {
    const flat = webSearchProviderConfig({
      ...base,
      webSearchProvider: "firecrawl",
      webSearchApiKey: "k",
      webSearchPricingJson: '{"searchMicros":1660,"fetchMicros":830,"marginBps":1000}',
    })!;
    expect(webSearchCallPricing(flat, flat.fetch[0]!, "fetch")).toEqual({
      providerMicros: 830,
      marginBps: 1000,
      explicit: true,
    });
    const perProvider = webSearchProviderConfig({
      ...base,
      webSearchProvider: "parallel,exa",
      webSearchProviderCredentials: keys({ parallel: "a", exa: "c" }),
      webSearchPricingJson: '{"exa":{"searchMicros":4000,"fetchMicros":1000}}',
    })!;
    expect(webSearchCallPricing(perProvider, perProvider.search[0]!, "search").explicit).toBe(
      false,
    );
    expect(webSearchCallPricing(perProvider, perProvider.search[1]!, "search")).toEqual({
      providerMicros: 4_000,
      marginBps: 500,
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
