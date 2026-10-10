import { z } from "zod";

/**
 * Provider-agnostic web search: the deployment-funded `web_search` and
 * `web_fetch` agent tools.
 *
 * Hosted search (the provider-executed `web_search` tool of the model's own
 * API) follows the model catalog. Provider search is a separate,
 * deployment-configured HTTP provider that Opengeni calls from the worker.
 * Search and page reading are separate slots; each slot holds an ordered
 * list of providers, and a call moves to the next provider when one fails.
 * By default the provider tools are offered only where the turn has no
 * hosted search (`OPENGENI_WEB_SEARCH_PREFER=native`).
 *
 * Adding a provider means one catalog entry here plus one adapter in
 * `@opengeni/runtime/web-search`.
 */

export const WEB_SEARCH_PROVIDER_IDS = [
  "tinyfish",
  "parallel",
  "perplexity",
  "exa",
  "tavily",
  "firecrawl",
  "brave",
  "jina",
  "searxng",
] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** Used when `OPENGENI_WEB_SEARCH_PROVIDER` is unset: free with an account key. */
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = "tinyfish";

/** Model-visible names of the provider tools. */
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export type WebSearchProviderToolName = typeof WEB_SEARCH_TOOL_NAME | typeof WEB_FETCH_TOOL_NAME;

/**
 * `native` (default): offer provider tools only to turns without hosted
 * search. `provider`: offer them to every turn and withhold the SDK-hosted
 * `web_search` tool. SuperGrok keeps its transport-level native search either
 * way because Opengeni does not attach it as an agent tool.
 */
export const WebSearchPreference = z.enum(["native", "provider"]);
export type WebSearchPreference = z.infer<typeof WebSearchPreference>;

/** One operation (search or page fetch) a provider offers. */
export type WebSearchProviderOperation = {
  /** Pay-as-you-go list price of one successful call, in USD micros. */
  listPriceMicros: number;
  /** The operation needs an API key; keyless calls are billed as free. */
  keyRequired: boolean;
  /** Default API base URL; null when the operator must supply one. */
  defaultBaseUrl: string | null;
};

export type WebSearchProviderCatalogEntry = {
  id: WebSearchProviderId;
  label: string;
  search: WebSearchProviderOperation | null;
  fetch: WebSearchProviderOperation | null;
  /** Where the list price comes from (checked 2026-10). */
  pricingUrl: string;
};

/**
 * Every supported provider with its capabilities, default endpoints and
 * list prices. A provider response that reports its own dollar cost (Exa
 * `costDollars`, Tavily `usage.credits`) bills that cost instead, and
 * `OPENGENI_WEB_SEARCH_PRICING_JSON` overrides both.
 */
export const WEB_SEARCH_PROVIDER_CATALOG: Readonly<
  Record<WebSearchProviderId, WebSearchProviderCatalogEntry>
> = {
  tinyfish: {
    id: "tinyfish",
    label: "TinyFish",
    // Search and Fetch are free at any wallet balance, within account rate limits.
    search: {
      listPriceMicros: 0,
      keyRequired: true,
      defaultBaseUrl: "https://api.search.tinyfish.ai",
    },
    fetch: {
      listPriceMicros: 0,
      keyRequired: true,
      defaultBaseUrl: "https://api.fetch.tinyfish.ai",
    },
    pricingUrl: "https://www.tinyfish.ai/pricing",
  },
  parallel: {
    id: "parallel",
    label: "Parallel",
    // Search in `fast` mode $1/1k requests; Extract $1/1k URLs.
    search: {
      listPriceMicros: 1_000,
      keyRequired: true,
      defaultBaseUrl: "https://api.parallel.ai",
    },
    fetch: { listPriceMicros: 1_000, keyRequired: true, defaultBaseUrl: "https://api.parallel.ai" },
    pricingUrl: "https://parallel.ai/pricing",
  },
  perplexity: {
    id: "perplexity",
    label: "Perplexity",
    // Search API with `search_type: "fast"`: $1/1k requests.
    search: {
      listPriceMicros: 1_000,
      keyRequired: true,
      defaultBaseUrl: "https://api.perplexity.ai",
    },
    fetch: null,
    pricingUrl: "https://docs.perplexity.ai/getting-started/pricing",
  },
  exa: {
    id: "exa",
    label: "Exa",
    // Auto search $7/1k + highlights $1/1k; contents text $1/1k pages.
    search: { listPriceMicros: 8_000, keyRequired: true, defaultBaseUrl: "https://api.exa.ai" },
    fetch: { listPriceMicros: 1_000, keyRequired: true, defaultBaseUrl: "https://api.exa.ai" },
    pricingUrl: "https://exa.ai/pricing",
  },
  tavily: {
    id: "tavily",
    label: "Tavily",
    // Basic search 1 credit, basic extract 1 credit per 5 URLs; $0.008/credit.
    search: { listPriceMicros: 8_000, keyRequired: true, defaultBaseUrl: "https://api.tavily.com" },
    fetch: { listPriceMicros: 1_600, keyRequired: true, defaultBaseUrl: "https://api.tavily.com" },
    pricingUrl: "https://docs.tavily.com/documentation/api-credits",
  },
  firecrawl: {
    id: "firecrawl",
    label: "Firecrawl",
    // 2 credits per 10 results, 1 credit per scrape, at Hobby-plan credit cost.
    search: {
      listPriceMicros: 6_400,
      keyRequired: true,
      defaultBaseUrl: "https://api.firecrawl.dev",
    },
    fetch: {
      listPriceMicros: 3_200,
      keyRequired: true,
      defaultBaseUrl: "https://api.firecrawl.dev",
    },
    pricingUrl: "https://www.firecrawl.dev/pricing",
  },
  brave: {
    id: "brave",
    label: "Brave Search",
    // $5 per 1k requests.
    search: {
      listPriceMicros: 5_000,
      keyRequired: true,
      defaultBaseUrl: "https://api.search.brave.com",
    },
    fetch: null,
    pricingUrl: "https://brave.com/search/api/",
  },
  jina: {
    id: "jina",
    label: "Jina",
    // At least 10k tokens per search at $0.05/1M; the reader works keyless at
    // a low per-IP rate and can be self-hosted (set its base URL).
    search: { listPriceMicros: 500, keyRequired: true, defaultBaseUrl: "https://s.jina.ai" },
    fetch: { listPriceMicros: 250, keyRequired: false, defaultBaseUrl: "https://r.jina.ai" },
    pricingUrl: "https://jina.ai/reader/",
  },
  searxng: {
    id: "searxng",
    label: "SearXNG",
    // Self-hosted metasearch; needs the operator's base URL.
    search: { listPriceMicros: 0, keyRequired: false, defaultBaseUrl: null },
    fetch: null,
    pricingUrl: "https://docs.searxng.org/",
  },
};

function envProviderName(id: WebSearchProviderId): string {
  return id.toUpperCase();
}

/** Per-provider API key variable, e.g. `OPENGENI_WEB_TINYFISH_API_KEY`. */
export function webSearchProviderApiKeyEnv(id: WebSearchProviderId): string {
  return `OPENGENI_WEB_${envProviderName(id)}_API_KEY`;
}

/** Per-provider base URL variable, e.g. `OPENGENI_WEB_SEARXNG_BASE_URL`. */
export function webSearchProviderBaseUrlEnv(id: WebSearchProviderId): string {
  return `OPENGENI_WEB_${envProviderName(id)}_BASE_URL`;
}

/** Every environment variable that configures provider web search. */
export function webSearchEnvironmentVariables(): string[] {
  return [
    "OPENGENI_WEB_SEARCH_PROVIDER",
    "OPENGENI_WEB_FETCH_PROVIDER",
    "OPENGENI_WEB_SEARCH_PREFER",
    "OPENGENI_WEB_SEARCH_PRICING_JSON",
    "OPENGENI_WEB_SEARCH_REQUEST_TIMEOUT_MS",
    ...WEB_SEARCH_PROVIDER_IDS.flatMap((id) => [
      webSearchProviderApiKeyEnv(id),
      webSearchProviderBaseUrlEnv(id),
    ]),
    // Earlier single-provider names, still honoured.
    "OPENGENI_WEB_SEARCH_API_KEY",
    "OPENGENI_WEB_SEARCH_BASE_URL",
    "OPENGENI_WEB_FETCH_API_KEY",
    "OPENGENI_WEB_FETCH_BASE_URL",
    "OPENGENI_WEB_SEARCH_PROVIDER_MODE",
  ];
}

export type WebSearchProviderCredentials = Partial<
  Record<string, { apiKey?: string | undefined; baseUrl?: string | undefined }>
>;

export const WebSearchProviderCredentialsSchema = z
  .record(
    z.string(),
    z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() }).strict(),
  )
  .default({});

/** Per-provider keys and base URLs from the environment. */
export function webSearchProviderCredentialsFromEnv(
  source: Record<string, string | undefined>,
): WebSearchProviderCredentials {
  const credentials: WebSearchProviderCredentials = {};
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    const apiKey = source[webSearchProviderApiKeyEnv(id)]?.trim();
    const baseUrl = source[webSearchProviderBaseUrlEnv(id)]?.trim();
    if (apiKey || baseUrl) {
      credentials[id] = { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
    }
  }
  return credentials;
}

/**
 * Upstream price of one call in integer USD micros, plus the Opengeni
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

const DEFAULT_MARGIN_BPS = 500;

/** Tavily's pay-as-you-go price of one credit, used for reported usage. */
export const TAVILY_CREDIT_MICROS = 8_000;

export type WebSearchProviderEndpoint = {
  provider: WebSearchProviderId;
  apiKey: string | null;
  baseUrl: string | null;
};

export type WebSearchProviderConfig = {
  preference: WebSearchPreference;
  /** Search providers in failover order; never empty. */
  search: WebSearchProviderEndpoint[];
  /** Page readers in failover order; empty when pages cannot be fetched. */
  fetch: WebSearchProviderEndpoint[];
  /** Explicit operator prices by provider, overriding list prices. */
  pricingOverrides: Partial<Record<WebSearchProviderId, WebSearchPricing>>;
  timeoutMs: number;
};

export type WebSearchSettings = {
  webSearchEnabled: boolean;
  webSearchProvider?: string | undefined;
  webFetchProvider?: string | undefined;
  webSearchPrefer?: string | undefined;
  /** Per-provider keys and base URLs (`OPENGENI_WEB_<PROVIDER>_API_KEY` / `_BASE_URL`). */
  webSearchProviderCredentials?: WebSearchProviderCredentials | undefined;
  /** Earlier single-provider settings: apply to the first provider of their slot. */
  webSearchApiKey?: string | undefined;
  webSearchBaseUrl?: string | undefined;
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

function normalizedBaseUrl(value: string | undefined, name: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error) {
    throw new Error(`${name} must be an absolute http(s) URL`, { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not embed credentials`);
  return url.toString().replace(/\/+$/u, "");
}

function providerList(raw: string, variable: string, operation: "search" | "fetch") {
  const ids: WebSearchProviderId[] = [];
  for (const part of raw.split(",")) {
    const normalized = part.trim().toLowerCase();
    if (!normalized) continue;
    const capable = WEB_SEARCH_PROVIDER_IDS.filter(
      (id) => WEB_SEARCH_PROVIDER_CATALOG[id][operation],
    );
    if (!(capable as readonly string[]).includes(normalized)) {
      throw new Error(
        `${variable} must be none or a comma-separated list of ${capable.join(", ")}`,
      );
    }
    if (!ids.includes(normalized as WebSearchProviderId))
      ids.push(normalized as WebSearchProviderId);
  }
  if (ids.length === 0) throw new Error(`${variable} names no provider`);
  return ids;
}

function preference(settings: WebSearchSettings): WebSearchPreference {
  const prefer = settings.webSearchPrefer?.trim().toLowerCase();
  if (prefer) {
    const parsed = WebSearchPreference.safeParse(prefer);
    if (!parsed.success) throw new Error("OPENGENI_WEB_SEARCH_PREFER must be native or provider");
    return parsed.data;
  }
  const legacy = settings.webSearchProviderMode?.trim().toLowerCase();
  if (!legacy || legacy === "fallback") return "native";
  if (legacy === "replace") return "provider";
  throw new Error("OPENGENI_WEB_SEARCH_PROVIDER_MODE must be fallback or replace");
}

function pricingOverrides(raw: string | undefined): WebSearchProviderConfig["pricingOverrides"] {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error("OPENGENI_WEB_SEARCH_PRICING_JSON must be valid JSON", { cause: error });
  }
  const describe = (error: z.ZodError) =>
    `OPENGENI_WEB_SEARCH_PRICING_JSON is invalid: ${error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}`;
  // One flat price applies to every configured provider.
  if (parsed && typeof parsed === "object" && "searchMicros" in parsed) {
    const flat = WebSearchPricingSchema.safeParse(parsed);
    if (!flat.success) throw new Error(describe(flat.error));
    return Object.fromEntries(WEB_SEARCH_PROVIDER_IDS.map((id) => [id, flat.data]));
  }
  const byProvider = z
    .record(z.string(), WebSearchPricingSchema)
    .superRefine((value, context) => {
      for (const key of Object.keys(value)) {
        if (!(WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(key)) {
          context.addIssue({ code: "custom", path: [key], message: "unknown provider" });
        }
      }
    })
    .safeParse(parsed);
  if (!byProvider.success) throw new Error(describe(byProvider.error));
  return byProvider.data as WebSearchProviderConfig["pricingOverrides"];
}

/**
 * Resolve the deployment's provider search. `off` applies when
 * `OPENGENI_WEB_SEARCH_ENABLED=false` (the server-wide web search switch),
 * when the provider is `none`, and when the provider is left at its default
 * (TinyFish) without that provider's key. `invalid` means an operator named
 * providers but the configuration cannot work; the tools stay unoffered and
 * the worker logs the reason.
 */
export function resolveWebSearchProvider(settings: WebSearchSettings): WebSearchProviderResolution {
  const named = settings.webSearchProvider?.trim() ?? "";
  if (!settings.webSearchEnabled || named.toLowerCase() === "none") return { status: "off" };
  const credentials = settings.webSearchProviderCredentials ?? {};
  if (named === "") {
    // The default provider turns on only once its own key is set.
    if (!usableSecret(credentials[DEFAULT_WEB_SEARCH_PROVIDER]?.apiKey)) return { status: "off" };
  }
  try {
    const searchIds = providerList(
      named || DEFAULT_WEB_SEARCH_PROVIDER,
      "OPENGENI_WEB_SEARCH_PROVIDER",
      "search",
    );
    const endpoint = (
      id: WebSearchProviderId,
      operation: "search" | "fetch",
      legacy: { apiKey: string | undefined; baseUrl: string | undefined; name: string } | null,
      sameProvider: WebSearchProviderEndpoint | undefined,
    ): WebSearchProviderEndpoint => {
      const own = credentials[id];
      const apiKey =
        usableSecret(own?.apiKey) ??
        (legacy ? usableSecret(legacy.apiKey) : null) ??
        sameProvider?.apiKey ??
        null;
      const baseUrl =
        normalizedBaseUrl(own?.baseUrl, webSearchProviderBaseUrlEnv(id)) ??
        (legacy ? normalizedBaseUrl(legacy.baseUrl, `${legacy.name}_BASE_URL`) : null) ??
        sameProvider?.baseUrl ??
        null;
      const spec = WEB_SEARCH_PROVIDER_CATALOG[id][operation]!;
      if (spec.keyRequired && !apiKey) {
        throw new Error(`${id} ${operation} needs ${webSearchProviderApiKeyEnv(id)}`);
      }
      if (!spec.defaultBaseUrl && !baseUrl) {
        throw new Error(`${id} ${operation} needs ${webSearchProviderBaseUrlEnv(id)}`);
      }
      return { provider: id, apiKey, baseUrl };
    };
    const search = searchIds.map((id, index) =>
      endpoint(
        id,
        "search",
        index === 0 && named
          ? {
              apiKey: settings.webSearchApiKey,
              baseUrl: settings.webSearchBaseUrl,
              name: "OPENGENI_WEB_SEARCH",
            }
          : null,
        undefined,
      ),
    );

    const fetchNamed = settings.webFetchProvider?.trim() ?? "";
    let fetch: WebSearchProviderEndpoint[];
    if (fetchNamed === "") {
      // Search providers that can also read pages do so, in the same order.
      fetch = search.flatMap((entry) =>
        WEB_SEARCH_PROVIDER_CATALOG[entry.provider].fetch ? [entry] : [],
      );
    } else if (fetchNamed.toLowerCase() === "none") {
      fetch = [];
    } else {
      fetch = providerList(fetchNamed, "OPENGENI_WEB_FETCH_PROVIDER", "fetch").map((id, index) =>
        endpoint(
          id,
          "fetch",
          index === 0
            ? {
                apiKey: settings.webFetchApiKey,
                baseUrl: settings.webFetchBaseUrl,
                name: "OPENGENI_WEB_FETCH",
              }
            : null,
          search.find((entry) => entry.provider === id),
        ),
      );
    }
    return {
      status: "configured",
      config: {
        preference: preference(settings),
        search,
        fetch,
        pricingOverrides: pricingOverrides(settings.webSearchPricingJson),
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
     * The workspace turned Opengeni credits off: a provider tool is offered
     * only when one of its providers is free (admission still refuses paid
     * calls if the switch flips mid-turn).
     */
    creditsDisabled?: boolean;
  },
): { hostedWebSearch: boolean; providerTools: WebSearchProviderToolName[] } {
  const config = webSearchProviderConfig(settings);
  if (!config || turn.transportHostedSearch) {
    return { hostedWebSearch: turn.hostedWebSearch, providerTools: [] };
  }
  if (config.preference === "native" && turn.hostedWebSearch) {
    return { hostedWebSearch: true, providerTools: [] };
  }
  const offered: WebSearchProviderToolName[] =
    config.fetch.length > 0 ? [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME] : [WEB_SEARCH_TOOL_NAME];
  const providerTools = turn.creditsDisabled
    ? offered.filter((tool) => !webSearchToolSpendsCredits(settings, config, tool))
    : offered;
  return {
    // `provider` withholds hosted search only in favour of a provider tool the
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

/** Whether every provider of this tool would spend Opengeni credits per call. */
export function webSearchToolSpendsCredits(
  settings: WebSearchSettings,
  config: WebSearchProviderConfig,
  tool: WebSearchProviderToolName,
): boolean {
  const operation = tool === WEB_SEARCH_TOOL_NAME ? "search" : "fetch";
  return (
    webSearchCreditBillingActive(settings) &&
    config[operation].every(
      (endpoint) => webSearchCallPricing(config, endpoint, operation).providerMicros > 0,
    )
  );
}

/** Upstream price for one call to one provider, before any provider-reported cost. */
export function webSearchCallPricing(
  config: Pick<WebSearchProviderConfig, "pricingOverrides">,
  endpoint: WebSearchProviderEndpoint,
  operation: "search" | "fetch",
): { providerMicros: number; marginBps: number; explicit: boolean } {
  const override = config.pricingOverrides[endpoint.provider];
  if (override) {
    return {
      providerMicros: operation === "search" ? override.searchMicros : override.fetchMicros,
      marginBps: override.marginBps ?? DEFAULT_MARGIN_BPS,
      explicit: true,
    };
  }
  const spec = WEB_SEARCH_PROVIDER_CATALOG[endpoint.provider][operation];
  // A keyless call (Jina reader, self-hosted SearXNG) costs nothing.
  return {
    providerMicros: spec && endpoint.apiKey ? spec.listPriceMicros : 0,
    marginBps: DEFAULT_MARGIN_BPS,
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
