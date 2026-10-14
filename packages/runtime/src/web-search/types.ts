import type { WebSearchProviderId } from "@opengeni/config";

/** One normalized search hit. Every adapter maps its own field names here. */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  /** Provider-reported publication or crawl date, verbatim. */
  publishedAt?: string;
};

export type WebSearchResponse = {
  results: WebSearchResult[];
  /** Exact upstream cost when the provider reports one (USD micros). */
  reportedCostMicros?: number;
};

/** One fetched page as readable text (Markdown where the provider offers it). */
export type WebPage = {
  url: string;
  finalUrl?: string;
  title?: string;
  content: string;
  reportedCostMicros?: number;
};

export type WebProviderCallOptions = {
  signal?: AbortSignal | undefined;
};

export type WebSearchRequest = {
  query: string;
  maxResults: number;
};

/** A search backend. Adapters stay stateless apart from their credentials. */
export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  search(request: WebSearchRequest, options?: WebProviderCallOptions): Promise<WebSearchResponse>;
}

/** A page reader backend. */
export interface WebFetchProvider {
  readonly id: WebSearchProviderId;
  fetch(request: { url: string }, options?: WebProviderCallOptions): Promise<WebPage>;
}

/**
 * A provider call failed. The message is bounded and never contains the API
 * key; `status` is the upstream HTTP status when there was one.
 */
export class WebSearchProviderError extends Error {
  readonly provider: WebSearchProviderId;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(
    provider: WebSearchProviderId,
    message: string,
    options: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "WebSearchProviderError";
    this.provider = provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}
