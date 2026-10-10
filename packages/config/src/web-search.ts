import { z } from "zod";

/**
 * Provider-agnostic web search: the deployment-funded `web_search` and
 * `web_fetch` agent tools.
 *
 * Hosted search (the provider-executed `web_search` tool of OpenAI, Azure,
 * Codex and SuperGrok) follows the model catalog. Provider search is a
 * separate, deployment-configured HTTP provider that Opengeni calls from the
 * worker. It is inert until `OPENGENI_WEB_SEARCH_PROVIDER` names a provider
 * with its credentials, and it is offered only where the turn has no hosted
 * search unless the operator selects `replace`.
 */

export const WEB_SEARCH_PROVIDER_IDS = [
  "tinyfish",
  "exa",
  "tavily",
  "firecrawl",
  "brave",
  "jina",
  "searxng",
] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** Model-visible names of the provider tools. */
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export type WebSearchProviderToolName = typeof WEB_SEARCH_TOOL_NAME | typeof WEB_FETCH_TOOL_NAME;

/**
 * `fallback` (default): offer provider tools only to turns without hosted
 * search. `replace`: offer them to every turn and withhold the SDK-hosted
 * `web_search` tool. SuperGrok keeps its transport-level native search in
 * both modes because Opengeni does not attach it as an agent tool.
 */
export const WebSearchProviderMode = z.enum(["fallback", "replace"]);
export type WebSearchProviderMode = z.infer<typeof WebSearchProviderMode>;

type ProviderTraits = {
  search: boolean;
  fetch: boolean;
  /** Needs an API key for this operation. */
  searchKey: boolean;
  fetchKey: boolean;
  /** Needs an explicit base URL (self-hosted). */
  baseUrl: boolean;
};

/** What each adapter can do. Jina fetch works keyless at a low rate limit. */
export const WEB_SEARCH_PROVIDER_TRAITS: Readonly<Record<WebSearchProviderId, ProviderTraits>> = {
  tinyfish: { search: true, fetch: true, searchKey: true, fetchKey: true, baseUrl: false },
  exa: { search: true, fetch: true, searchKey: true, fetchKey: true, baseUrl: false },
  tavily: { search: true, fetch: true, searchKey: true, fetchKey: true, baseUrl: false },
  firecrawl: { search: true, fetch: true, searchKey: true, fetchKey: true, baseUrl: false },
  brave: { search: true, fetch: false, searchKey: true, fetchKey: false, baseUrl: false },
  jina: { search: true, fetch: true, searchKey: true, fetchKey: false, baseUrl: false },
  searxng: { search: true, fetch: false, searchKey: false, fetchKey: false, baseUrl: true },
};

/**
 * Upstream list price of one call in integer USD micros, plus the Opengeni
 * margin in basis points (500 = +5%, as for model pricing). Credit billing
 * charges `ceil(providerCost * (10000 + marginBps) / 10000)` per call.
 */
export type WebSearchPricing = {
  searchMicros: number;
  fetchMicros: number;
  marginBps?: number | undefined;
};

const WebSearchPricingSchema = z
  .object({
    searchMicros: z.number().int().nonnegative().max(10_000_000),
    fetchMicros: z.number().int().nonnegative().max(10_000_000),
    marginBps: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

/**
 * Built-in pay-as-you-go list prices (checked 2026-10). A provider response
 * that reports its own dollar cost (Exa `costDollars`, Tavily `usage.credits`)
 * bills that cost instead; an explicit `OPENGENI_WEB_SEARCH_PRICING_JSON`
 * overrides both. Plan-dependent providers (Firecrawl) should set the JSON.
 */
export const DEFAULT_WEB_SEARCH_PRICING: Readonly<Record<WebSearchProviderId, WebSearchPricing>> = {
  // Search and Fetch are free at any wallet balance.
  tinyfish: { searchMicros: 0, fetchMicros: 0, marginBps: 500 },
  // Auto search $7/1k + highlights $1/1k; contents text $1/1k pages.
  exa: { searchMicros: 8_000, fetchMicros: 1_000, marginBps: 500 },
  // Basic search 1 credit, basic extract 1 credit per 5 URLs; $0.008/credit.
  tavily: { searchMicros: 8_000, fetchMicros: 1_600, marginBps: 500 },
  // 2 credits per 10 results, 1 credit per scrape, at Hobby-plan credit cost.
  firecrawl: { searchMicros: 6_400, fetchMicros: 3_200, marginBps: 500 },
  // $5 per 1k requests.
  brave: { searchMicros: 5_000, fetchMicros: 0, marginBps: 500 },
  // At least 10k tokens per search at $0.05/1M; reader billed per token.
  jina: { searchMicros: 500, fetchMicros: 250, marginBps: 500 },
  // Self-hosted.
  searxng: { searchMicros: 0, fetchMicros: 0, marginBps: 500 },
};

/** Tavily's pay-as-you-go price of one credit, used for reported usage. */
export const TAVILY_CREDIT_MICROS = 8_000;

export type WebSearchProviderEndpoint = {
  provider: WebSearchProviderId;
  apiKey: string | null;
  baseUrl: string | null;
};

export type WebSearchProviderConfig = {
  mode: WebSearchProviderMode;
  search: WebSearchProviderEndpoint;
  /** Null when no configured provider can fetch pages. */
  fetch: WebSearchProviderEndpoint | null;
  /** Explicit operator price, else null (built-in or provider-reported). */
  pricingOverride: WebSearchPricing | null;
  timeoutMs: number;
};

export type WebSearchSettings = {
  webSearchEnabled: boolean;
  webSearchProvider?: string | undefined;
  webSearchApiKey?: string | undefined;
  webSearchBaseUrl?: string | undefined;
  webFetchProvider?: string | undefined;
  webFetchApiKey?: string | undefined;
  webFetchBaseUrl?: string | undefined;
  webSearchProviderMode?: string | undefined;
  webSearchPricingJson?: string | undefined;
  webSearchRequestTimeoutMs?: number | undefined;
  /** Credit billing is active for this deployment (see webSearchCreditBillingActive). */
  billingMode?: string | undefined;
  usageLimitsMode?: string | undefined;
};

export type WebSearchProviderResolution =
  | { status: "off" }
  | { status: "invalid"; reason: string }
  | { status: "configured"; config: WebSearchProviderConfig };

function usableSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // `.env.example` placeholders must never advertise a dead tool.
  if (/^(your[-_ ]|<|changeme|replace[-_ ]?me|xxx)/iu.test(trimmed)) return null;
  return trimmed;
}

function normalizedBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error("must be an absolute http(s) URL", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("must be an absolute http(s) URL");
  }
  if (url.username || url.password) throw new Error("must not embed credentials");
  return url.toString().replace(/\/+$/u, "");
}

function providerId(value: string): WebSearchProviderId | null {
  const normalized = value.trim().toLowerCase();
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(normalized)
    ? (normalized as WebSearchProviderId)
    : null;
}

/**
 * Resolve the deployment's provider search. `off` is the default and also
 * applies when `OPENGENI_WEB_SEARCH_ENABLED=false` (the server-wide web search
 * switch). `invalid` means an operator named a provider but the configuration
 * cannot work; the tools stay unoffered and the worker logs the reason.
 */
export function resolveWebSearchProvider(settings: WebSearchSettings): WebSearchProviderResolution {
  const raw = settings.webSearchProvider?.trim() ?? "";
  if (!settings.webSearchEnabled || raw === "" || raw.toLowerCase() === "none") {
    return { status: "off" };
  }
  try {
    const search = providerId(raw);
    if (!search) {
      throw new Error(
        `OPENGENI_WEB_SEARCH_PROVIDER must be one of none, ${WEB_SEARCH_PROVIDER_IDS.join(", ")}`,
      );
    }
    const modeResult = WebSearchProviderMode.safeParse(
      settings.webSearchProviderMode?.trim().toLowerCase() || "fallback",
    );
    if (!modeResult.success) {
      throw new Error("OPENGENI_WEB_SEARCH_PROVIDER_MODE must be fallback or replace");
    }
    let searchBaseUrl: string | null;
    try {
      searchBaseUrl = normalizedBaseUrl(settings.webSearchBaseUrl);
    } catch (error) {
      throw new Error(`OPENGENI_WEB_SEARCH_BASE_URL ${(error as Error).message}`, {
        cause: error,
      });
    }
    const searchTraits = WEB_SEARCH_PROVIDER_TRAITS[search];
    const searchKey = usableSecret(settings.webSearchApiKey);
    if (searchTraits.searchKey && !searchKey) {
      throw new Error(`${search} search needs OPENGENI_WEB_SEARCH_API_KEY`);
    }
    if (searchTraits.baseUrl && !searchBaseUrl) {
      throw new Error(`${search} search needs OPENGENI_WEB_SEARCH_BASE_URL`);
    }
    const searchEndpoint: WebSearchProviderEndpoint = {
      provider: search,
      apiKey: searchKey,
      baseUrl: searchBaseUrl,
    };

    const fetchRaw = settings.webFetchProvider?.trim() ?? "";
    let fetch: WebSearchProviderEndpoint | null = null;
    if (fetchRaw === "") {
      // The search provider fetches too when it can.
      if (searchTraits.fetch) fetch = searchEndpoint;
    } else if (fetchRaw.toLowerCase() !== "none") {
      const fetchProvider = providerId(fetchRaw);
      if (!fetchProvider || !WEB_SEARCH_PROVIDER_TRAITS[fetchProvider].fetch) {
        throw new Error(
          `OPENGENI_WEB_FETCH_PROVIDER must be none or one of ${WEB_SEARCH_PROVIDER_IDS.filter(
            (id) => WEB_SEARCH_PROVIDER_TRAITS[id].fetch,
          ).join(", ")}`,
        );
      }
      let fetchBaseUrl: string | null;
      try {
        fetchBaseUrl = normalizedBaseUrl(settings.webFetchBaseUrl);
      } catch (error) {
        throw new Error(`OPENGENI_WEB_FETCH_BASE_URL ${(error as Error).message}`, {
          cause: error,
        });
      }
      const sameProvider = fetchProvider === search;
      const fetchKey = usableSecret(settings.webFetchApiKey) ?? (sameProvider ? searchKey : null);
      if (WEB_SEARCH_PROVIDER_TRAITS[fetchProvider].fetchKey && !fetchKey) {
        throw new Error(`${fetchProvider} fetch needs OPENGENI_WEB_FETCH_API_KEY`);
      }
      fetch = {
        provider: fetchProvider,
        apiKey: fetchKey,
        baseUrl: fetchBaseUrl ?? (sameProvider ? searchBaseUrl : null),
      };
    }

    let pricingOverride: WebSearchPricing | null = null;
    const pricingRaw = settings.webSearchPricingJson?.trim();
    if (pricingRaw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(pricingRaw);
      } catch (error) {
        throw new Error("OPENGENI_WEB_SEARCH_PRICING_JSON must be valid JSON", { cause: error });
      }
      const result = WebSearchPricingSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `OPENGENI_WEB_SEARCH_PRICING_JSON is invalid: ${result.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      pricingOverride = result.data;
    }
    return {
      status: "configured",
      config: {
        mode: modeResult.data,
        search: searchEndpoint,
        fetch,
        pricingOverride,
        timeoutMs: settings.webSearchRequestTimeoutMs ?? 20_000,
      },
    };
  } catch (error) {
    return { status: "invalid", reason: (error as Error).message };
  }
}

/** The configured provider, or null when off or invalid. */
export function webSearchProviderConfig(
  settings: WebSearchSettings,
): WebSearchProviderConfig | null {
  const resolution = resolveWebSearchProvider(settings);
  return resolution.status === "configured" ? resolution.config : null;
}

/**
 * The single web-search plan for one turn, shared by the worker (which tools
 * it attaches) and the API's effective-tools projection (what it reports).
 *
 * `hostedWebSearch` is whether the resolved model attaches the SDK-hosted
 * `web_search` tool. `transportHostedSearch` is true for providers whose native
 * search is added by the transport rather than as an agent tool (SuperGrok).
 */
export function webSearchToolPlan(
  settings: WebSearchSettings,
  turn: {
    hostedWebSearch: boolean;
    transportHostedSearch?: boolean;
    /**
     * The workspace turned Opengeni credits off: provider tools whose calls
     * would spend credits are not offered (admission still refuses them if
     * the switch flips mid-turn).
     */
    creditsDisabled?: boolean;
  },
): { hostedWebSearch: boolean; providerTools: WebSearchProviderToolName[] } {
  const config = webSearchProviderConfig(settings);
  if (!config || turn.transportHostedSearch) {
    return { hostedWebSearch: turn.hostedWebSearch, providerTools: [] };
  }
  if (config.mode === "fallback" && turn.hostedWebSearch) {
    return { hostedWebSearch: true, providerTools: [] };
  }
  const offered: WebSearchProviderToolName[] = config.fetch
    ? [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME]
    : [WEB_SEARCH_TOOL_NAME];
  const providerTools = turn.creditsDisabled
    ? offered.filter((tool) => !webSearchToolSpendsCredits(settings, config, tool))
    : offered;
  return {
    // `replace` withholds hosted search only in favour of a provider tool the
    // turn actually gets.
    hostedWebSearch: turn.hostedWebSearch && !providerTools.includes(WEB_SEARCH_TOOL_NAME),
    providerTools,
  };
}

/** Whether this deployment bills web search and fetch in Opengeni credits. */
export function webSearchCreditBillingActive(
  settings: Pick<WebSearchSettings, "billingMode" | "usageLimitsMode">,
): boolean {
  return settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
}

/** Whether one call of this provider tool would spend Opengeni credits. */
export function webSearchToolSpendsCredits(
  settings: WebSearchSettings,
  config: WebSearchProviderConfig,
  tool: WebSearchProviderToolName,
): boolean {
  return (
    webSearchCreditBillingActive(settings) &&
    webSearchCallPricing(config, tool === WEB_SEARCH_TOOL_NAME ? "search" : "fetch")
      .providerMicros > 0
  );
}

/** Upstream price for one call before any provider-reported cost. */
export function webSearchCallPricing(
  config: WebSearchProviderConfig,
  operation: "search" | "fetch",
): { providerMicros: number; marginBps: number; explicit: boolean } {
  const endpoint = operation === "search" ? config.search : config.fetch;
  const provider = endpoint?.provider ?? config.search.provider;
  if (config.pricingOverride) {
    return {
      providerMicros:
        operation === "search"
          ? config.pricingOverride.searchMicros
          : config.pricingOverride.fetchMicros,
      marginBps: config.pricingOverride.marginBps ?? 500,
      explicit: true,
    };
  }
  const builtin = DEFAULT_WEB_SEARCH_PRICING[provider];
  // A keyless call (Jina reader, self-hosted SearXNG) costs nothing.
  const free = !endpoint?.apiKey;
  return {
    providerMicros: free ? 0 : operation === "search" ? builtin.searchMicros : builtin.fetchMicros,
    marginBps: builtin.marginBps ?? 500,
    explicit: false,
  };
}

/** Credit cost of a provider cost after margin, rounded up to whole micros. */
export function webSearchCreditMicros(providerMicros: number, marginBps: number): number {
  if (!Number.isSafeInteger(providerMicros) || providerMicros < 0) {
    throw new Error("web search provider cost must be a non-negative safe integer");
  }
  return Number((BigInt(providerMicros) * BigInt(10_000 + marginBps) + 9_999n) / 10_000n);
}
