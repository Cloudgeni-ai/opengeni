import { describe, expect, test } from "bun:test";
import type { WebSearchProviderEndpoint, WebSearchProviderId } from "@opengeni/config";
import {
  WEB_PROVIDER_MAX_RESPONSE_BYTES,
  WebSearchProviderError,
  WebToolArgumentError,
  createWebFetchProvider,
  createWebSearchProvider,
  parseWebFetchArguments,
  parseWebSearchArguments,
  renderWebPageWindow,
  renderWebSearchResults,
} from "../src/web-search";

type Captured = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(response: unknown, status = 200) {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(typeof response === "string" ? response : JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

function endpoint(
  provider: WebSearchProviderId,
  apiKey: string | null = "secret-key",
  baseUrl: string | null = null,
): WebSearchProviderEndpoint {
  return { provider, apiKey, baseUrl };
}

async function search(
  provider: WebSearchProviderId,
  response: unknown,
  options: { apiKey?: string | null; baseUrl?: string | null; maxResults?: number } = {},
) {
  const fake = fakeFetch(response);
  const adapter = createWebSearchProvider({
    endpoint: endpoint(
      provider,
      options.apiKey === undefined ? "secret-key" : options.apiKey,
      options.baseUrl ?? null,
    ),
    fetch: fake.impl,
    timeoutMs: 1_000,
  });
  const result = await adapter.search({
    query: "bun release",
    maxResults: options.maxResults ?? 5,
  });
  return { result, call: fake.calls[0]! };
}

describe("search adapters normalize each provider", () => {
  test("TinyFish", async () => {
    const { result, call } = await search("tinyfish", {
      results: [
        { position: 1, title: "Bun 2", url: "https://bun.sh/blog", snippet: "Bun <b>2</b> is out" },
        { title: "dup", url: "https://bun.sh/blog", snippet: "duplicate" },
        { title: "bad", url: "javascript:alert(1)", snippet: "dropped" },
      ],
    });
    expect(call.url).toBe("https://api.search.tinyfish.ai/?query=bun+release");
    expect(call.headers["x-api-key"]).toBe("secret-key");
    expect(result.results).toEqual([
      { title: "Bun 2", url: "https://bun.sh/blog", snippet: "Bun 2 is out" },
    ]);
  });

  test("Exa reports its own cost", async () => {
    const { result, call } = await search("exa", {
      results: [
        {
          title: "Bun",
          url: "https://bun.sh",
          publishedDate: "2026-09-01",
          highlights: ["one", "two"],
        },
      ],
      costDollars: { total: 0.008 },
    });
    expect(call.url).toBe("https://api.exa.ai/search");
    expect(call.headers["x-api-key"]).toBe("secret-key");
    expect(call.body).toMatchObject({ query: "bun release", numResults: 5, type: "auto" });
    expect(result).toEqual({
      results: [
        { title: "Bun", url: "https://bun.sh", snippet: "one … two", publishedAt: "2026-09-01" },
      ],
      reportedCostMicros: 8_000,
    });
  });

  test("Tavily converts reported credits", async () => {
    const { result, call } = await search("tavily", {
      results: [{ title: "T", url: "https://t.example", content: "c", published_date: "d" }],
      usage: { credits: 1 },
    });
    expect(call.headers.authorization).toBe("Bearer secret-key");
    expect(call.body).toMatchObject({ max_results: 5, include_usage: true });
    expect(result.reportedCostMicros).toBe(8_000);
    expect(result.results[0]).toEqual({
      title: "T",
      url: "https://t.example",
      snippet: "c",
      publishedAt: "d",
    });
  });

  test("Firecrawl v2 and v1 shapes", async () => {
    const v2 = await search("firecrawl", {
      data: { web: [{ title: "F", url: "https://f.example", description: "d" }] },
    });
    expect(v2.call.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(v2.call.body).toEqual({ query: "bun release", limit: 5 });
    expect(v2.result.results).toEqual([{ title: "F", url: "https://f.example", snippet: "d" }]);
    const v1 = await search("firecrawl", {
      data: [{ title: "F", url: "https://f.example", description: "d" }],
    });
    expect(v1.result.results).toHaveLength(1);
  });

  test("Brave strips markup and caps the count", async () => {
    const { result, call } = await search(
      "brave",
      {
        web: {
          results: [
            {
              title: "B",
              url: "https://b.example",
              description: "<strong>bold</strong> &amp; more",
              page_age: "2026-01-01",
            },
            { title: "C", url: "https://c.example", description: "c" },
          ],
        },
      },
      { maxResults: 1 },
    );
    expect(call.url).toBe("https://api.search.brave.com/res/v1/web/search?q=bun+release&count=1");
    expect(call.headers["x-subscription-token"]).toBe("secret-key");
    expect(result.results).toEqual([
      { title: "B", url: "https://b.example", snippet: "bold & more", publishedAt: "2026-01-01" },
    ]);
  });

  test("Jina search asks for no page bodies", async () => {
    const { result, call } = await search("jina", {
      data: [{ title: "J", url: "https://j.example", description: "d", date: "x" }],
    });
    expect(call.url).toBe("https://s.jina.ai/?q=bun+release");
    expect(call.headers["x-respond-with"]).toBe("no-content");
    expect(result.results[0]?.snippet).toBe("d");
  });

  test("SearXNG uses the operator base URL without a key", async () => {
    const { result, call } = await search(
      "searxng",
      { results: [{ title: "S", url: "https://s.example", content: "c" }] },
      { apiKey: null, baseUrl: "http://searxng.example:8080" },
    );
    expect(call.url).toBe("http://searxng.example:8080/search?q=bun+release&format=json");
    expect(call.headers.authorization).toBeUndefined();
    expect(result.results).toHaveLength(1);
  });

  test("long snippets are bounded", async () => {
    const { result } = await search("tinyfish", {
      results: [{ title: "t", url: "https://x.example", snippet: "word ".repeat(500) }],
    });
    expect(result.results[0]!.snippet.length).toBeLessThanOrEqual(400);
  });
});

describe("fetch adapters", () => {
  async function fetchPage(provider: WebSearchProviderId, response: unknown, apiKey = "k") {
    const fake = fakeFetch(response);
    const adapter = createWebFetchProvider({
      endpoint: endpoint(provider, apiKey),
      fetch: fake.impl,
      timeoutMs: 1_000,
    });
    return { page: await adapter.fetch({ url: "https://a.example/x" }), call: fake.calls[0]! };
  }

  test("TinyFish, Exa, Tavily, Firecrawl and Jina return readable text", async () => {
    const tinyfish = await fetchPage("tinyfish", {
      results: [
        { url: "https://a.example/x", final_url: "https://a.example/y", title: "A", text: "# A" },
      ],
    });
    expect(tinyfish.call.body).toEqual({ urls: ["https://a.example/x"], format: "markdown" });
    expect(tinyfish.page).toEqual({
      url: "https://a.example/x",
      finalUrl: "https://a.example/y",
      title: "A",
      content: "# A",
    });
    const exa = await fetchPage("exa", {
      results: [{ url: "https://a.example/x", title: "A", text: "body" }],
      costDollars: { total: 0.001 },
    });
    expect(exa.call.url).toBe("https://api.exa.ai/contents");
    expect(exa.page.reportedCostMicros).toBe(1_000);
    const tavily = await fetchPage("tavily", {
      results: [{ url: "https://a.example/x", raw_content: "raw" }],
      usage: { credits: 0.2 },
    });
    expect(tavily.call.url).toBe("https://api.tavily.com/extract");
    expect(tavily.page.content).toBe("raw");
    expect(tavily.page.reportedCostMicros).toBe(1_600);
    const firecrawl = await fetchPage("firecrawl", {
      data: { markdown: "md", metadata: { title: "F", sourceURL: "https://a.example/x" } },
    });
    expect(firecrawl.call.body).toMatchObject({
      url: "https://a.example/x",
      formats: ["markdown"],
    });
    expect(firecrawl.page).toEqual({ url: "https://a.example/x", title: "F", content: "md" });
    const jina = await fetchPage("jina", { data: { title: "J", content: "text" } }, "");
    expect(jina.call.url).toBe("https://r.jina.ai/https://a.example/x");
    expect(jina.call.headers.authorization).toBeUndefined();
    expect(jina.page.content).toBe("text");
  });

  test("per-URL failures and empty pages are provider errors", async () => {
    await expect(
      fetchPage("tinyfish", { results: [], errors: [{ url: "x", error: "timeout" }] }),
    ).rejects.toThrow("Could not fetch the page: timeout");
    await expect(
      fetchPage("exa", {
        results: [],
        statuses: [{ status: "error", error: { tag: "CRAWL_NOT_FOUND" } }],
      }),
    ).rejects.toThrow("CRAWL_NOT_FOUND");
    await expect(fetchPage("jina", { data: { content: "  " } })).rejects.toThrow(
      "The page has no readable text",
    );
  });

  test("search-only providers cannot fetch", () => {
    expect(() => createWebFetchProvider({ endpoint: endpoint("brave"), timeoutMs: 1_000 })).toThrow(
      "brave cannot fetch pages",
    );
  });
});

describe("provider HTTP failures", () => {
  test("errors carry status and detail but never the key", async () => {
    const fake = fakeFetch({ error: "invalid api key secret-key? no" }, 401);
    const adapter = createWebSearchProvider({
      endpoint: endpoint("exa", "abc"),
      fetch: fake.impl,
      timeoutMs: 1_000,
    });
    const error = await adapter.search({ query: "q", maxResults: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebSearchProviderError);
    expect((error as WebSearchProviderError).status).toBe(401);
    expect((error as WebSearchProviderError).retryable).toBe(false);
    expect((error as Error).message).not.toContain("abc");
  });

  test("rate limits are retryable and timeouts are reported", async () => {
    const limited = createWebSearchProvider({
      endpoint: endpoint("brave"),
      fetch: fakeFetch("slow down", 429).impl,
      timeoutMs: 1_000,
    });
    const error = await limited.search({ query: "q", maxResults: 1 }).catch((e: unknown) => e);
    expect((error as WebSearchProviderError).retryable).toBe(true);
    const hanging = createWebSearchProvider({
      endpoint: endpoint("brave"),
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        )) as typeof fetch,
      timeoutMs: 20,
    });
    await expect(hanging.search({ query: "q", maxResults: 1 })).rejects.toThrow(
      "Provider did not answer within 0 seconds",
    );
  });

  test("oversized responses are refused", async () => {
    const big = createWebSearchProvider({
      endpoint: endpoint("tinyfish"),
      fetch: (async () =>
        new Response("x".repeat(WEB_PROVIDER_MAX_RESPONSE_BYTES + 1))) as unknown as typeof fetch,
      timeoutMs: 1_000,
    });
    await expect(big.search({ query: "q", maxResults: 1 })).rejects.toThrow("too large");
  });
});

describe("tool arguments and rendering", () => {
  test("search arguments", () => {
    expect(parseWebSearchArguments({ query: "  a   b " })).toEqual({ query: "a b", maxResults: 5 });
    expect(parseWebSearchArguments({ query: "a", maxResults: 10 }).maxResults).toBe(10);
    for (const args of [{}, { query: "" }, { query: "a", maxResults: 11 }, { query: "a", x: 1 }]) {
      expect(() => parseWebSearchArguments(args)).toThrow(WebToolArgumentError);
    }
  });

  test("fetch refuses private, credentialed and non-web URLs", () => {
    expect(parseWebFetchArguments({ url: "https://example.com/a#frag" })).toEqual({
      url: "https://example.com/a",
      offset: 0,
      maxChars: 20_000,
    });
    for (const url of [
      "file:///etc/passwd",
      "http://localhost:8000",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1",
      "http://[::1]/",
      "http://metadata/",
      "http://db.internal/",
      "https://user:pass@example.com",
      "not a url",
    ]) {
      expect(() => parseWebFetchArguments({ url })).toThrow(WebToolArgumentError);
    }
    expect(parseWebFetchArguments({ url: "http://8.8.8.8/" }).url).toBe("http://8.8.8.8/");
  });

  test("search results render compactly", () => {
    expect(renderWebSearchResults("q", [])).toBe("No web results for: q");
    expect(
      renderWebSearchResults("q", [
        { title: "T", url: "https://t.example", snippet: "s", publishedAt: "2026" },
      ]),
    ).toBe("Web results for: q\n\n1. T\n   https://t.example\n   Published: 2026\n   s");
  });

  test("page windows page through long content", () => {
    const page = { url: "https://a.example", title: "A", content: "0123456789" };
    expect(renderWebPageWindow(page, { offset: 0, maxChars: 4 })).toBe(
      "Title: A\nURL: https://a.example\nCharacters 0-4 of 10\nnextOffset: 4\n\n0123",
    );
    expect(renderWebPageWindow(page, { offset: 8, maxChars: 4 })).toBe(
      "Title: A\nURL: https://a.example\nCharacters 8-10 of 10\n\n89",
    );
  });
});
