import {
  TAVILY_CREDIT_MICROS,
  type WebSearchProviderEndpoint,
  type WebSearchProviderId,
} from "@opengeni/config";
import {
  dollarsToMicros,
  optionalString,
  plainText,
  providerJson,
  type ProviderHttp,
} from "./http";
import {
  WebSearchProviderError,
  type WebFetchProvider,
  type WebPage,
  type WebProviderCallOptions,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from "./types";

/** Longest snippet kept per result, before the model sees it. */
export const WEB_SEARCH_SNIPPET_MAX_CHARS = 400;
const TITLE_MAX_CHARS = 200;

export const DEFAULT_WEB_PROVIDER_BASE_URLS: Readonly<
  Record<WebSearchProviderId, { search: string | null; fetch: string | null }>
> = {
  tinyfish: { search: "https://api.search.tinyfish.ai", fetch: "https://api.fetch.tinyfish.ai" },
  exa: { search: "https://api.exa.ai", fetch: "https://api.exa.ai" },
  tavily: { search: "https://api.tavily.com", fetch: "https://api.tavily.com" },
  firecrawl: { search: "https://api.firecrawl.dev", fetch: "https://api.firecrawl.dev" },
  brave: { search: "https://api.search.brave.com", fetch: null },
  jina: { search: "https://s.jina.ai", fetch: "https://r.jina.ai" },
  searxng: { search: null, fetch: null },
};

type AdapterInput = {
  endpoint: WebSearchProviderEndpoint;
  fetch?: typeof fetch;
  timeoutMs: number;
};

function http(input: AdapterInput): ProviderHttp {
  return {
    provider: input.endpoint.provider,
    fetch: input.fetch ?? fetch,
    timeoutMs: input.timeoutMs,
  };
}

function baseUrl(input: AdapterInput, operation: "search" | "fetch"): string {
  const base =
    input.endpoint.baseUrl ?? DEFAULT_WEB_PROVIDER_BASE_URLS[input.endpoint.provider][operation];
  if (!base) {
    throw new WebSearchProviderError(
      input.endpoint.provider,
      `${input.endpoint.provider} has no ${operation} endpoint configured`,
    );
  }
  return base.replace(/\/+$/u, "");
}

function requireKey(input: AdapterInput): string {
  if (!input.endpoint.apiKey) {
    throw new WebSearchProviderError(input.endpoint.provider, "Provider API key is not configured");
  }
  return input.endpoint.apiKey;
}

function result(raw: {
  title: unknown;
  url: unknown;
  snippet: unknown;
  publishedAt?: unknown;
}): WebSearchResult | null {
  const url = optionalString(raw.url);
  if (!url || !/^https?:\/\//iu.test(url)) return null;
  const publishedAt = optionalString(raw.publishedAt);
  return {
    title: plainText(raw.title, TITLE_MAX_CHARS) || url,
    url,
    snippet: plainText(raw.snippet, WEB_SEARCH_SNIPPET_MAX_CHARS),
    ...(publishedAt ? { publishedAt: publishedAt.slice(0, 40) } : {}),
  };
}

function results(
  raw: unknown,
  map: (item: Record<string, unknown>) => Parameters<typeof result>[0],
  maxResults: number,
): WebSearchResult[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const mapped = result(map(item as Record<string, unknown>));
    if (!mapped || seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    out.push(mapped);
    if (out.length >= maxResults) break;
  }
  return out;
}

function page(
  provider: WebSearchProviderId,
  requestedUrl: string,
  raw: { content: unknown; title?: unknown; finalUrl?: unknown; reportedCostMicros?: number },
): WebPage {
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (!content) {
    throw new WebSearchProviderError(provider, "The page has no readable text");
  }
  const title = optionalString(raw.title);
  const finalUrl = optionalString(raw.finalUrl);
  return {
    url: requestedUrl,
    content,
    ...(title ? { title: plainText(title, TITLE_MAX_CHARS) } : {}),
    ...(finalUrl && finalUrl !== requestedUrl ? { finalUrl } : {}),
    ...(raw.reportedCostMicros !== undefined ? { reportedCostMicros: raw.reportedCostMicros } : {}),
  };
}

const json = { "content-type": "application/json", accept: "application/json" };

// ---------------------------------------------------------------- TinyFish

function tinyfishSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "tinyfish",
    async search(request, options) {
      const url = new URL(baseUrl(input, "search"));
      url.searchParams.set("query", request.query);
      const body = await providerJson<{ results?: unknown }>(
        http(input),
        url.toString(),
        { method: "GET", headers: { "x-api-key": requireKey(input), accept: "application/json" } },
        options?.signal,
      );
      return {
        results: results(
          body.results,
          (item) => ({ title: item.title, url: item.url, snippet: item.snippet }),
          request.maxResults,
        ),
      };
    },
  };
}

function tinyfishFetch(input: AdapterInput): WebFetchProvider {
  return {
    id: "tinyfish",
    async fetch(request, options) {
      const body = await providerJson<{
        results?: Array<Record<string, unknown>>;
        errors?: Array<Record<string, unknown>>;
      }>(
        http(input),
        baseUrl(input, "fetch"),
        {
          method: "POST",
          headers: { ...json, "x-api-key": requireKey(input) },
          body: JSON.stringify({ urls: [request.url], format: "markdown" }),
        },
        options?.signal,
      );
      const hit = body.results?.[0];
      if (!hit) {
        const reason = optionalString(body.errors?.[0]?.error) ?? "fetch failed";
        throw new WebSearchProviderError("tinyfish", `Could not fetch the page: ${reason}`);
      }
      return page("tinyfish", request.url, {
        content: hit.text,
        title: hit.title,
        finalUrl: hit.final_url,
      });
    },
  };
}

// --------------------------------------------------------------------- Exa

function exaSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "exa",
    async search(request, options) {
      const body = await providerJson<{ results?: unknown; costDollars?: { total?: unknown } }>(
        http(input),
        `${baseUrl(input, "search")}/search`,
        {
          method: "POST",
          headers: { ...json, "x-api-key": requireKey(input) },
          body: JSON.stringify({
            query: request.query,
            numResults: request.maxResults,
            type: "auto",
            contents: { highlights: { maxCharacters: WEB_SEARCH_SNIPPET_MAX_CHARS } },
          }),
        },
        options?.signal,
      );
      const reported = dollarsToMicros(body.costDollars?.total);
      return {
        results: results(
          body.results,
          (item) => ({
            title: item.title,
            url: item.url,
            snippet: Array.isArray(item.highlights)
              ? item.highlights.filter((value) => typeof value === "string").join(" … ")
              : (item.summary ?? item.text),
            publishedAt: item.publishedDate,
          }),
          request.maxResults,
        ),
        ...(reported !== undefined ? { reportedCostMicros: reported } : {}),
      };
    },
  };
}

function exaFetch(input: AdapterInput): WebFetchProvider {
  return {
    id: "exa",
    async fetch(request, options) {
      const body = await providerJson<{
        results?: Array<Record<string, unknown>>;
        statuses?: Array<{ status?: unknown; error?: { tag?: unknown } }>;
        costDollars?: { total?: unknown };
      }>(
        http(input),
        `${baseUrl(input, "fetch")}/contents`,
        {
          method: "POST",
          headers: { ...json, "x-api-key": requireKey(input) },
          body: JSON.stringify({ urls: [request.url], text: true }),
        },
        options?.signal,
      );
      const hit = body.results?.[0];
      const status = body.statuses?.[0];
      if (!hit || status?.status === "error") {
        const reason = optionalString(status?.error?.tag) ?? "fetch failed";
        throw new WebSearchProviderError("exa", `Could not fetch the page: ${reason}`);
      }
      const reported = dollarsToMicros(body.costDollars?.total);
      return page("exa", request.url, {
        content: hit.text,
        title: hit.title,
        finalUrl: hit.url,
        ...(reported !== undefined ? { reportedCostMicros: reported } : {}),
      });
    },
  };
}

// ------------------------------------------------------------------ Tavily

function tavilyCredits(usage: unknown): number | undefined {
  const credits = (usage as { credits?: unknown } | undefined)?.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits >= 0
    ? Math.ceil(credits * TAVILY_CREDIT_MICROS)
    : undefined;
}

function tavilySearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "tavily",
    async search(request, options) {
      const body = await providerJson<{ results?: unknown; usage?: unknown }>(
        http(input),
        `${baseUrl(input, "search")}/search`,
        {
          method: "POST",
          headers: { ...json, authorization: `Bearer ${requireKey(input)}` },
          body: JSON.stringify({
            query: request.query,
            max_results: request.maxResults,
            search_depth: "basic",
            include_usage: true,
          }),
        },
        options?.signal,
      );
      const reported = tavilyCredits(body.usage);
      return {
        results: results(
          body.results,
          (item) => ({
            title: item.title,
            url: item.url,
            snippet: item.content,
            publishedAt: item.published_date,
          }),
          request.maxResults,
        ),
        ...(reported !== undefined ? { reportedCostMicros: reported } : {}),
      };
    },
  };
}

function tavilyFetch(input: AdapterInput): WebFetchProvider {
  return {
    id: "tavily",
    async fetch(request, options) {
      const body = await providerJson<{
        results?: Array<Record<string, unknown>>;
        failed_results?: Array<Record<string, unknown>>;
        usage?: unknown;
      }>(
        http(input),
        `${baseUrl(input, "fetch")}/extract`,
        {
          method: "POST",
          headers: { ...json, authorization: `Bearer ${requireKey(input)}` },
          body: JSON.stringify({ urls: [request.url], format: "markdown", include_usage: true }),
        },
        options?.signal,
      );
      const hit = body.results?.[0];
      if (!hit) {
        const reason = optionalString(body.failed_results?.[0]?.error) ?? "fetch failed";
        throw new WebSearchProviderError("tavily", `Could not fetch the page: ${reason}`);
      }
      const reported = tavilyCredits(body.usage);
      return page("tavily", request.url, {
        content: hit.raw_content,
        title: hit.title,
        finalUrl: hit.url,
        ...(reported !== undefined ? { reportedCostMicros: reported } : {}),
      });
    },
  };
}

// --------------------------------------------------------------- Firecrawl

function firecrawlSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "firecrawl",
    async search(request, options) {
      const body = await providerJson<{ data?: unknown }>(
        http(input),
        `${baseUrl(input, "search")}/v2/search`,
        {
          method: "POST",
          headers: { ...json, authorization: `Bearer ${requireKey(input)}` },
          body: JSON.stringify({ query: request.query, limit: request.maxResults }),
        },
        options?.signal,
      );
      // v2 groups results by source ({ web: [...] }); v1 returned an array.
      const data = body.data;
      const web = Array.isArray(data) ? data : (data as { web?: unknown } | undefined)?.web;
      return {
        results: results(
          web,
          (item) => ({ title: item.title, url: item.url, snippet: item.description }),
          request.maxResults,
        ),
      };
    },
  };
}

function firecrawlFetch(input: AdapterInput): WebFetchProvider {
  return {
    id: "firecrawl",
    async fetch(request, options) {
      const body = await providerJson<{
        data?: { markdown?: unknown; metadata?: Record<string, unknown> };
      }>(
        http(input),
        `${baseUrl(input, "fetch")}/v2/scrape`,
        {
          method: "POST",
          headers: { ...json, authorization: `Bearer ${requireKey(input)}` },
          body: JSON.stringify({ url: request.url, formats: ["markdown"], onlyMainContent: true }),
        },
        options?.signal,
      );
      return page("firecrawl", request.url, {
        content: body.data?.markdown,
        title: body.data?.metadata?.title,
        finalUrl: body.data?.metadata?.url ?? body.data?.metadata?.sourceURL,
      });
    },
  };
}

// ------------------------------------------------------------------- Brave

function braveSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "brave",
    async search(request, options) {
      const url = new URL(`${baseUrl(input, "search")}/res/v1/web/search`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.maxResults));
      const body = await providerJson<{ web?: { results?: unknown } }>(
        http(input),
        url.toString(),
        {
          method: "GET",
          headers: { accept: "application/json", "x-subscription-token": requireKey(input) },
        },
        options?.signal,
      );
      return {
        results: results(
          body.web?.results,
          (item) => ({
            title: item.title,
            url: item.url,
            snippet: [
              item.description,
              ...(Array.isArray(item.extra_snippets) ? item.extra_snippets.slice(0, 1) : []),
            ]
              .filter((value) => typeof value === "string")
              .join(" "),
            publishedAt: item.page_age ?? item.age,
          }),
          request.maxResults,
        ),
      };
    },
  };
}

// -------------------------------------------------------------------- Jina

function jinaSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "jina",
    async search(request, options) {
      const url = new URL(`${baseUrl(input, "search")}/`);
      url.searchParams.set("q", request.query);
      const body = await providerJson<{ data?: unknown }>(
        http(input),
        url.toString(),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${requireKey(input)}`,
            // Titles, URLs and descriptions only; page bodies come from web_fetch.
            "x-respond-with": "no-content",
          },
        },
        options?.signal,
      );
      return {
        results: results(
          body.data,
          (item) => ({
            title: item.title,
            url: item.url,
            snippet: item.description ?? item.content,
            publishedAt: item.date,
          }),
          request.maxResults,
        ),
      };
    },
  };
}

function jinaFetch(input: AdapterInput): WebFetchProvider {
  return {
    id: "jina",
    async fetch(request, options) {
      const headers: Record<string, string> = { accept: "application/json" };
      // The reader works keyless at a low per-IP rate; a key raises the limit.
      if (input.endpoint.apiKey) headers.authorization = `Bearer ${input.endpoint.apiKey}`;
      const body = await providerJson<{ data?: Record<string, unknown> }>(
        http(input),
        `${baseUrl(input, "fetch")}/${request.url}`,
        { method: "GET", headers },
        options?.signal,
      );
      return page("jina", request.url, {
        content: body.data?.content,
        title: body.data?.title,
        finalUrl: body.data?.url,
      });
    },
  };
}

// ----------------------------------------------------------------- SearXNG

function searxngSearch(input: AdapterInput): WebSearchProvider {
  return {
    id: "searxng",
    async search(request, options) {
      const url = new URL(`${baseUrl(input, "search")}/search`);
      url.searchParams.set("q", request.query);
      url.searchParams.set("format", "json");
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.endpoint.apiKey) headers.authorization = `Bearer ${input.endpoint.apiKey}`;
      const body = await providerJson<{ results?: unknown }>(
        http(input),
        url.toString(),
        { method: "GET", headers },
        options?.signal,
      );
      return {
        results: results(
          body.results,
          (item) => ({
            title: item.title,
            url: item.url,
            snippet: item.content,
            publishedAt: item.publishedDate,
          }),
          request.maxResults,
        ),
      };
    },
  };
}

const SEARCH_ADAPTERS: Readonly<
  Record<WebSearchProviderId, (input: AdapterInput) => WebSearchProvider>
> = {
  tinyfish: tinyfishSearch,
  exa: exaSearch,
  tavily: tavilySearch,
  firecrawl: firecrawlSearch,
  brave: braveSearch,
  jina: jinaSearch,
  searxng: searxngSearch,
};

const FETCH_ADAPTERS: Readonly<
  Partial<Record<WebSearchProviderId, (input: AdapterInput) => WebFetchProvider>>
> = {
  tinyfish: tinyfishFetch,
  exa: exaFetch,
  tavily: tavilyFetch,
  firecrawl: firecrawlFetch,
  jina: jinaFetch,
};

export function createWebSearchProvider(input: AdapterInput): WebSearchProvider {
  return SEARCH_ADAPTERS[input.endpoint.provider](input);
}

export function createWebFetchProvider(input: AdapterInput): WebFetchProvider {
  const adapter = FETCH_ADAPTERS[input.endpoint.provider];
  if (!adapter) {
    throw new Error(`${input.endpoint.provider} cannot fetch pages`);
  }
  return adapter(input);
}

export type { WebSearchRequest, WebSearchResponse, WebProviderCallOptions };
