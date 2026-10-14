/**
 * Provider-agnostic web search and page fetch for agent tools.
 *
 * Adapters normalize each provider's API to {@link WebSearchProvider} and
 * {@link WebFetchProvider}. Adding a provider means one search adapter (and
 * optionally one fetch adapter) plus its traits and list price in
 * `@opengeni/config` (`web-search.ts`). Rendering keeps model-visible output
 * compact: titles, URLs, dates and short snippets for search; a bounded window
 * of readable text for fetch.
 */
import { isIP } from "node:net";
import type { WebSearchResult, WebPage } from "./types";

export * from "./types";
export {
  createWebFetchProvider,
  createWebSearchProvider,
  DEFAULT_WEB_PROVIDER_BASE_URLS,
  WEB_SEARCH_SNIPPET_MAX_CHARS,
} from "./providers";
export { WEB_PROVIDER_MAX_RESPONSE_BYTES } from "./http";

export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_QUERY_MAX_CHARS = 400;
export const WEB_FETCH_DEFAULT_CHARS = 20_000;
export const WEB_FETCH_MAX_CHARS = 50_000;
/** Longest page text retained for paging; later text is reported as cut. */
export const WEB_FETCH_RETAINED_MAX_CHARS = 1_000_000;

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web for current information. Returns titles, URLs, dates and short snippets. Use web_fetch on a returned URL to read the page. Use these tools instead of curl or wget for web lookups.";
export const WEB_FETCH_TOOL_DESCRIPTION =
  "Read one public web page (http or https URL) as plain text or Markdown, without starting a sandbox. Long pages are returned in windows: call again with the returned nextOffset to continue. Repeated reads of the same URL in this turn are served from cache.";

export const webSearchInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: WEB_SEARCH_QUERY_MAX_CHARS,
      description: "What to search for, as you would type it into a search engine.",
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: WEB_SEARCH_MAX_RESULTS,
      description: `Number of results (default ${WEB_SEARCH_DEFAULT_RESULTS}).`,
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

export const webFetchInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, maxLength: 4096, description: "Absolute http(s) URL." },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Character offset to start from (default 0). Use nextOffset from a prior call.",
    },
    maxChars: {
      type: "integer",
      minimum: 1_000,
      maximum: WEB_FETCH_MAX_CHARS,
      description: `Characters to return (default ${WEB_FETCH_DEFAULT_CHARS}).`,
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

export class WebToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebToolArgumentError";
  }
}

function integerArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WebToolArgumentError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new WebToolArgumentError(`Unknown argument: ${unknown.join(", ")}`);
  }
}

export function parseWebSearchArguments(args: Record<string, unknown>): {
  query: string;
  maxResults: number;
} {
  rejectUnknown(args, ["query", "maxResults"]);
  const query = typeof args.query === "string" ? args.query.replace(/\s+/gu, " ").trim() : "";
  if (!query) throw new WebToolArgumentError("query is required");
  if (query.length > WEB_SEARCH_QUERY_MAX_CHARS) {
    throw new WebToolArgumentError(
      `query must be at most ${WEB_SEARCH_QUERY_MAX_CHARS} characters`,
    );
  }
  return {
    query,
    maxResults: integerArg(
      args,
      "maxResults",
      WEB_SEARCH_DEFAULT_RESULTS,
      1,
      WEB_SEARCH_MAX_RESULTS,
    ),
  };
}

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function privateAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = host.toLowerCase();
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:")
    );
  }
  return false;
}

/**
 * Validate a model-supplied URL before handing it to a fetch provider. The
 * provider (not this worker) makes the request, but private and credentialed
 * URLs are refused anyway: they are never public pages and a self-hosted
 * reader may sit inside a private network.
 */
export function parseWebFetchArguments(args: Record<string, unknown>): {
  url: string;
  offset: number;
  maxChars: number;
} {
  rejectUnknown(args, ["url", "offset", "maxChars"]);
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebToolArgumentError("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebToolArgumentError("url must use http or https");
  }
  if (url.username || url.password) {
    throw new WebToolArgumentError("url must not contain credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const blocked = isIP(host)
    ? privateAddress(host)
    : !host.includes(".") ||
      host === "localhost" ||
      PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (blocked) throw new WebToolArgumentError("url must be a public web address");
  url.hash = "";
  return {
    url: url.toString(),
    offset: integerArg(args, "offset", 0, 0, WEB_FETCH_RETAINED_MAX_CHARS),
    maxChars: integerArg(args, "maxChars", WEB_FETCH_DEFAULT_CHARS, 1_000, WEB_FETCH_MAX_CHARS),
  };
}

/** Compact model-visible search results. */
export function renderWebSearchResults(query: string, results: readonly WebSearchResult[]): string {
  if (results.length === 0) return `No web results for: ${query}`;
  const lines = [`Web results for: ${query}`];
  results.forEach((result, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.publishedAt) lines.push(`   Published: ${result.publishedAt}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  });
  return lines.join("\n");
}

/** One bounded window of a fetched page, with paging facts. */
export function renderWebPageWindow(
  page: WebPage,
  window: { offset: number; maxChars: number },
): string {
  const retained = page.content.slice(0, WEB_FETCH_RETAINED_MAX_CHARS);
  const total = retained.length;
  const start = Math.min(window.offset, total);
  const end = Math.min(total, start + window.maxChars);
  const header = [
    ...(page.title ? [`Title: ${page.title}`] : []),
    `URL: ${page.finalUrl ?? page.url}`,
    `Characters ${start}-${end} of ${total}${page.content.length > total ? " (page cut at the retention limit)" : ""}`,
  ];
  if (end < total) header.push(`nextOffset: ${end}`);
  return `${header.join("\n")}\n\n${retained.slice(start, end)}`;
}
