import { z } from "zod";
import {
  sideFeatureRouteAllowed,
  type SideFeatureResidencySettings,
  type SideFeatureTarget,
} from "./side-feature-residency";

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
 * hosted search (`OPENGENI_WEB_SEARCH_PREFER=native`), except on turns whose
 * model Opengeni pays for while credit billing is active: those always get
 * the billed provider tools instead of hosted search.
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
 * way because Opengeni does not attach it as an agent tool. A credit-billed
 * turn while billing is active behaves as `provider` either way, so its
 * searches go through Opengeni's metered provider tools.
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

/**
 * List price of one search run by a model provider's own hosted search tool,
 * in USD micros: OpenAI `web_search` is $10 per 1,000 calls and Anthropic
 * `web_search` $10 per 1,000 searches (checked 2026-10). The search content
 * the model reads is billed as model tokens with the response.
 */
export const HOSTED_WEB_SEARCH_LIST_PRICE_MICROS = 10_000;

/**
 * Credit charge for the hosted searches one model response reported: the
 * list price per search plus the web-search margin (default +5%).
 */
export function hostedWebSearchCharge(
  settings: Pick<WebSearchSettings, "creditMarginBpsOverride">,
  requests: number,
): { providerMicros: number; creditMicros: number; marginBps: number } {
  if (!Number.isSafeInteger(requests) || requests < 0) {
    throw new Error("hosted web search request count must be a non-negative safe integer");
  }
  const marginBps = settings.creditMarginBpsOverride ?? DEFAULT_MARGIN_BPS;
  const providerMicros = requests * HOSTED_WEB_SEARCH_LIST_PRICE_MICROS;
  return {
    providerMicros,
    creditMicros: webSearchCreditMicros(providerMicros, marginBps),
    marginBps,
  };
}

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
  /** Deployment-wide margin override for provider-rate credit billing. */
  creditMarginBpsOverride?: number | undefined;
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
  creditMarginBpsOverride?: number | undefined;
} & SideFeatureResidencySettings;

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
        ...(settings.creditMarginBpsOverride !== undefined
          ? { creditMarginBpsOverride: settings.creditMarginBpsOverride }
          : {}),
        timeoutMs: settings.webSearchRequestTimeoutMs ?? 20_000,
      },
    };
  } catch (error) {
    return { status: "invalid", reason: (error as Error).message };
  }
}

/**
 * The configured provider, or null when off or invalid. Under EU-only
 * inference only providers whose residency record is EU remain, in their
 * configured order, so failover never leaves the EU; with no EU search
 * provider the provider tools are off.
 */
export function webSearchProviderConfig(
  settings: WebSearchSettings,
): WebSearchProviderConfig | null {
  const resolution = resolveWebSearchProvider(settings);
  if (resolution.status !== "configured") return null;
  if (settings.requiredModelGeography !== "eu") return resolution.config;
  const allowed = (operation: "search" | "fetch") => (endpoint: WebSearchProviderEndpoint) =>
    sideFeatureRouteAllowed(settings, webSearchEndpointTarget(endpoint, operation));
  const search = resolution.config.search.filter(allowed("search"));
  if (search.length === 0) return null;
  return { ...resolution.config, search, fetch: resolution.config.fetch.filter(allowed("fetch")) };
}

/**
 * The route a search provider sends over, with the endpoint it calls: its
 * configured base URL, else the provider's default host for the operation.
 */
export function webSearchEndpointTarget(
  endpoint: WebSearchProviderEndpoint,
  operation: "search" | "fetch",
): SideFeatureTarget {
  return {
    route: `web_search.${endpoint.provider}`,
    endpoint:
      endpoint.baseUrl ??
      WEB_SEARCH_PROVIDER_CATALOG[endpoint.provider][operation]?.defaultBaseUrl ??
      null,
  };
}

/** Hosted provider search runs on the provider's search backend: never EU. */
export function hostedWebSearchAllowed(settings: SideFeatureResidencySettings): boolean {
  return sideFeatureRouteAllowed(settings, "web_search.hosted");
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
    /**
     * Paid hosted tools would run on Opengeni's bill this turn
     * ({@link paidHostedToolsChargeCredits}). The provider tools then replace
     * hosted search whenever the turn gets them, as with `provider`; searches
     * go through Opengeni's per-call admission and metering. Without a
     * provider tool hosted search stays, and model settlement charges the
     * searches the provider reports.
     */
    hostedToolsBillCredits?: boolean;
  },
): { hostedWebSearch: boolean; providerTools: WebSearchProviderToolName[] } {
  if (!hostedWebSearchAllowed(settings)) {
    // EU-only: hosted search (including SuperGrok's transport search) is
    // never offered; only EU provider tools may be.
    turn = { ...turn, hostedWebSearch: false, transportHostedSearch: false };
  }
  const config = webSearchProviderConfig(settings);
  if (!config || turn.transportHostedSearch) {
    return { hostedWebSearch: turn.hostedWebSearch, providerTools: [] };
  }
  const preferProvider = config.preference === "provider" || turn.hostedToolsBillCredits === true;
  if (!preferProvider && turn.hostedWebSearch) {
    return { hostedWebSearch: true, providerTools: [] };
  }
  const offered: WebSearchProviderToolName[] =
    config.fetch.length > 0 ? [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME] : [WEB_SEARCH_TOOL_NAME];
  const providerTools = turn.creditsDisabled
    ? offered.filter((tool) => !webSearchToolSpendsCredits(settings, config, tool))
    : offered;
  return {
    // Hosted search is withheld only in favour of a provider tool the turn
    // actually gets.
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

/**
 * THE single check point where the paid-hosted-tool charges start. True
 * when the model of a response or turn is billed in Opengeni credits (cost
 * class `credits`) and credit billing is active. Every new charge depends on
 * it: Opengeni's billed `web_search`/`web_fetch` replacing hosted search, the
 * list-price charge for hosted searches a response reports, and the priced
 * Gateway image tool replacing OpenAI hosted image generation on the
 * deployment key. Turns on the user's own keys or subscriptions, free models
 * and billing-off deployments are false and keep their hosted tools free.
 *
 * Legacy billing accounts (the host account that must see no new charges)
 * are to be exempted here, and only here.
 */
export function paidHostedToolsChargeCredits(
  settings: Pick<WebSearchSettings, "billingMode" | "usageLimitsMode">,
  input: { accountId: string; chargesOpenGeniCredits: boolean },
): boolean {
  // Legacy billing account exemption goes here (`isLegacyBillingAccount`).
  return input.chargesOpenGeniCredits && webSearchCreditBillingActive(settings);
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
  config: Pick<WebSearchProviderConfig, "pricingOverrides" | "creditMarginBpsOverride">,
  endpoint: WebSearchProviderEndpoint,
  operation: "search" | "fetch",
): { providerMicros: number; marginBps: number; explicit: boolean } {
  const override = config.pricingOverrides[endpoint.provider];
  if (override) {
    return {
      providerMicros: operation === "search" ? override.searchMicros : override.fetchMicros,
      marginBps: config.creditMarginBpsOverride ?? override.marginBps ?? DEFAULT_MARGIN_BPS,
      explicit: true,
    };
  }
  const spec = WEB_SEARCH_PROVIDER_CATALOG[endpoint.provider][operation];
  // A keyless call (Jina reader, self-hosted SearXNG) costs nothing.
  return {
    providerMicros: spec && endpoint.apiKey ? spec.listPriceMicros : 0,
    marginBps: config.creditMarginBpsOverride ?? DEFAULT_MARGIN_BPS,
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
