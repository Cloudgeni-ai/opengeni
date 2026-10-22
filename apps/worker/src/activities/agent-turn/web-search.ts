import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  webSearchCallPricing,
  webSearchCreditMicros,
  webSearchProviderConfig,
  webSearchToolPlan,
  type WebSearchProviderConfig,
  type WebSearchProviderEndpoint,
  type WebSearchProviderToolName,
  type WebSearchSettings,
} from "@opengeni/config";
import {
  WebSearchBillingRefusedError,
  type WebSearchBilling,
  type WebSearchCallCost,
  type WebSearchCallScope,
} from "@opengeni/core";
import type { Observability } from "@opengeni/observability";
import {
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_FETCH_RETAINED_MAX_CHARS,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WebSearchProviderError,
  WebToolArgumentError,
  createWebFetchProvider,
  createWebSearchProvider,
  parseWebFetchArguments,
  parseWebSearchArguments,
  renderWebPageWindow,
  renderWebSearchResults,
  webFetchInputSchema,
  webSearchInputSchema,
  type WebPage,
} from "@opengeni/runtime/web-search";
import { hostedWebSearchForTurn } from "./tool-policy";

/**
 * Which web search one turn gets: the provider's hosted tool, Opengeni's
 * provider tools, or neither. Tool preparation and agent construction both
 * call this with the same accepted model and settings, so they agree.
 */
export function turnWebSearchPlan(
  resolvedModel: {
    configured: { hostedWebSearch: boolean };
    provider: { kind?: string };
  } | null,
  settings: WebSearchSettings,
  workspaceCreditModelsAllowed: boolean,
) {
  return webSearchToolPlan(settings, {
    hostedWebSearch: hostedWebSearchForTurn(resolvedModel, settings.webSearchEnabled),
    // SuperGrok's native search is added by its transport, not as an agent
    // tool, so provider tools would only duplicate it.
    transportHostedSearch: resolvedModel?.provider.kind === "xai-subscription",
    // A workspace with Opengeni credits off is offered only free providers.
    creditsDisabled: !workspaceCreditModelsAllowed,
  });
}

/** Pages kept per attempt so paging through one page is not billed again. */
const PAGE_CACHE_ENTRIES = 16;

function textResult(text: string, isError: boolean) {
  return { isError, content: [{ type: "text" as const, text }] };
}

type Pricing = ReturnType<typeof webSearchCallPricing>;
type Operation = "search" | "fetch";

function settledCost(
  operationId: string,
  operation: Operation,
  provider: string,
  pricing: Pricing,
  reportedCostMicros: number | undefined,
): WebSearchCallCost {
  // An explicit operator price wins; then the provider's own reported cost;
  // then the built-in list price.
  const basis: WebSearchCallCost["basis"] = pricing.explicit
    ? "configured_price"
    : reportedCostMicros !== undefined
      ? "provider_reported"
      : "list_price";
  const providerMicros =
    basis === "provider_reported" ? reportedCostMicros! : pricing.providerMicros;
  return {
    operationId,
    operation,
    provider,
    providerMicros,
    creditMicros: webSearchCreditMicros(providerMicros, pricing.marginBps),
    marginBps: pricing.marginBps,
    basis,
  };
}

function providerFailure(error: WebSearchProviderError): string {
  return `${error.message}${error.retryable ? ". You may retry shortly." : "."}`;
}

/** Closed outcome set for `opengeni_web_search_calls_total`. */
export type WebSearchCallOutcome =
  | "ok"
  | "provider_error"
  | "provider_retryable"
  | "billing_refused"
  | "error";

type WebSearchObservability = Pick<Observability, "warn" | "incrementCounter" | "observeHistogram">;

const WEB_SEARCH_DURATION_BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 15, 30];

/**
 * One provider call: a counter by fixed outcome plus its latency. Labels are
 * the operation, the configured provider id, and the outcome only, never the
 * query, URL, or session.
 */
function recordWebSearchCall(
  observability: WebSearchObservability,
  operation: Operation,
  provider: string,
  outcome: WebSearchCallOutcome,
  startedAt: number,
): void {
  observability.incrementCounter({
    name: "opengeni_web_search_calls_total",
    help: "Provider web search/fetch calls made by the worker, by operation, provider and outcome.",
    labels: { operation, provider, outcome },
  });
  observability.observeHistogram({
    name: "opengeni_web_search_call_duration_seconds",
    help: "Provider web search/fetch call duration in seconds.",
    buckets: WEB_SEARCH_DURATION_BUCKETS,
    value: (performance.now() - startedAt) / 1000,
    labels: { operation, provider },
  });
}

function providerFailureOutcome(error: WebSearchProviderError): WebSearchCallOutcome {
  return error.retryable ? "provider_retryable" : "provider_error";
}

/** A provider rejected the key or the account is out of quota. */
const CREDENTIAL_COOLDOWN_MS = 10 * 60_000;
/** A provider rate-limited, timed out, or failed on its side. */
const TRANSIENT_COOLDOWN_MS = 60_000;

/**
 * Process-wide provider health for failover ordering. A provider that just
 * failed in a way that will repeat (rate limit, outage, rejected key) moves
 * behind the healthy providers of its slot until its cooldown passes. It is
 * never skipped: when every provider is cooling down they are tried in their
 * configured order.
 */
export class WebProviderHealth {
  private readonly coolingUntil = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  order<T extends { endpoint: WebSearchProviderEndpoint }>(
    operation: Operation,
    candidates: readonly T[],
  ): T[] {
    const now = this.now();
    const cooling = (candidate: T) =>
      (this.coolingUntil.get(`${operation}:${candidate.endpoint.provider}`) ?? 0) > now;
    return [
      ...candidates.filter((candidate) => !cooling(candidate)),
      ...candidates.filter(cooling),
    ];
  }

  failed(operation: Operation, provider: string, error: WebSearchProviderError): void {
    const status = error.status;
    const cooldown =
      status === 401 || status === 402 || status === 403
        ? CREDENTIAL_COOLDOWN_MS
        : error.retryable
          ? TRANSIENT_COOLDOWN_MS
          : 0;
    if (cooldown > 0) this.coolingUntil.set(`${operation}:${provider}`, this.now() + cooldown);
  }

  succeeded(operation: Operation, provider: string): void {
    this.coolingUntil.delete(`${operation}:${provider}`);
  }
}

const sharedProviderHealth = new WebProviderHealth();

type Candidate<Adapter> = {
  endpoint: WebSearchProviderEndpoint;
  adapter: Adapter;
  pricing: Pricing;
};

type CallOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Try a slot's providers in order until one answers. Each paid provider is
 * admitted for its own price just before it is called, and only the provider
 * that answered is settled. A provider failure (not a cancelled turn, not a
 * bug) moves to the next provider; the model sees an error only when every
 * provider failed or was refused.
 */
async function callWithFailover<Adapter, T>(input: {
  operation: Operation;
  candidates: readonly Candidate<Adapter>[];
  health: WebProviderHealth;
  scope: WebSearchCallScope;
  billing: WebSearchBilling;
  observability: WebSearchObservability;
  operationId: string;
  signal: AbortSignal | undefined;
  call: (adapter: Adapter) => Promise<T>;
  reportedCostMicros: (value: T) => number | undefined;
  settle: (cost: WebSearchCallCost) => Promise<void>;
}): Promise<CallOutcome<T>> {
  const ordered = input.health.order(input.operation, input.candidates);
  const label = input.operation === "search" ? "Web search" : "Web fetch";
  let lastFailure: WebSearchProviderError | null = null;
  let refusal: WebSearchBillingRefusedError | null = null;
  for (const [index, candidate] of ordered.entries()) {
    const provider = candidate.endpoint.provider;
    try {
      await input.billing.admit(input.scope, candidate.pricing.providerMicros);
    } catch (error) {
      if (!(error instanceof WebSearchBillingRefusedError)) throw error;
      recordWebSearchCall(
        input.observability,
        input.operation,
        provider,
        "billing_refused",
        performance.now(),
      );
      refusal ??= error;
      continue;
    }
    const startedAt = performance.now();
    try {
      const value = await input.call(candidate.adapter);
      recordWebSearchCall(input.observability, input.operation, provider, "ok", startedAt);
      input.health.succeeded(input.operation, provider);
      await input.settle(
        settledCost(
          input.operationId,
          input.operation,
          provider,
          candidate.pricing,
          input.reportedCostMicros(value),
        ),
      );
      return { ok: true, value };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (!(error instanceof WebSearchProviderError)) {
        recordWebSearchCall(input.observability, input.operation, provider, "error", startedAt);
        throw error;
      }
      recordWebSearchCall(
        input.observability,
        input.operation,
        provider,
        providerFailureOutcome(error),
        startedAt,
      );
      input.health.failed(input.operation, provider, error);
      input.observability.warn("web search provider call failed", {
        operation: input.operation,
        provider,
        status: error.status ?? undefined,
        retryable: error.retryable,
        failover: index < ordered.length - 1,
        error: error.message,
      });
      lastFailure = error;
    }
  }
  if (lastFailure)
    return { ok: false, message: `${label} failed: ${providerFailure(lastFailure)}` };
  return { ok: false, message: refusal?.message ?? `${label} is not available.` };
}

/**
 * The `web_search` and `web_fetch` attempt tools for one turn. The caller
 * decides which names the turn gets ({@link webSearchToolPlan}); this only
 * builds them. Provider keys stay in the worker and never reach a sandbox.
 */
export function webSearchToolDefinitions(input: {
  settings: WebSearchSettings;
  tools: readonly WebSearchProviderToolName[];
  scope: WebSearchCallScope;
  billing: WebSearchBilling;
  observability: WebSearchObservability;
  fetch?: typeof fetch;
  health?: WebProviderHealth;
}): AttemptToolDefinition[] {
  const config: WebSearchProviderConfig | null = webSearchProviderConfig(input.settings);
  if (!config || input.tools.length === 0) return [];
  const health = input.health ?? sharedProviderHealth;
  const adapterInput = {
    timeoutMs: config.timeoutMs,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
  const settle = async (cost: WebSearchCallCost) => {
    try {
      await input.billing.settle(input.scope, cost);
    } catch (error) {
      // The provider already answered. Keep the model's result; the missing
      // receipt is an operator-visible accounting fault, never a tool failure.
      input.observability.warn("web search usage settlement failed", {
        operation: cost.operation,
        provider: cost.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const shared = {
    health,
    scope: input.scope,
    billing: input.billing,
    observability: input.observability,
    settle,
  };
  const definitions: AttemptToolDefinition[] = [];

  if (input.tools.includes(WEB_SEARCH_TOOL_NAME) && config.search.length > 0) {
    const candidates = config.search.map((endpoint) => ({
      endpoint,
      adapter: createWebSearchProvider({ ...adapterInput, endpoint }),
      pricing: webSearchCallPricing(config, endpoint, "search"),
    }));
    definitions.push({
      identity: { serverId: "opengeni", toolName: WEB_SEARCH_TOOL_NAME },
      modelName: WEB_SEARCH_TOOL_NAME,
      codemodePath: ["opengeni", WEB_SEARCH_TOOL_NAME],
      title: "Search the web",
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      inputSchema: webSearchInputSchema as unknown as AttemptToolDefinition["inputSchema"],
      annotations: {
        title: "Search the web",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      source: "opengeni",
      approval: "none",
      execute: async (args, context) => {
        let request: ReturnType<typeof parseWebSearchArguments>;
        try {
          request = parseWebSearchArguments(args);
        } catch (error) {
          if (error instanceof WebToolArgumentError) return textResult(error.message, true);
          throw error;
        }
        const outcome = await callWithFailover({
          ...shared,
          operation: "search",
          candidates,
          operationId: context.operationId,
          signal: context.signal,
          call: (adapter) => adapter.search(request, { signal: context.signal }),
          reportedCostMicros: (response) => response.reportedCostMicros,
        });
        return outcome.ok
          ? textResult(renderWebSearchResults(request.query, outcome.value.results), false)
          : textResult(outcome.message, true);
      },
    });
  }

  if (input.tools.includes(WEB_FETCH_TOOL_NAME) && config.fetch.length > 0) {
    const candidates = config.fetch.map((endpoint) => ({
      endpoint,
      adapter: createWebFetchProvider({ ...adapterInput, endpoint }),
      pricing: webSearchCallPricing(config, endpoint, "fetch"),
    }));
    const pages = new Map<string, WebPage>();
    definitions.push({
      identity: { serverId: "opengeni", toolName: WEB_FETCH_TOOL_NAME },
      modelName: WEB_FETCH_TOOL_NAME,
      codemodePath: ["opengeni", WEB_FETCH_TOOL_NAME],
      title: "Read a web page",
      description: WEB_FETCH_TOOL_DESCRIPTION,
      inputSchema: webFetchInputSchema as unknown as AttemptToolDefinition["inputSchema"],
      annotations: {
        title: "Read a web page",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      source: "opengeni",
      approval: "none",
      execute: async (args, context) => {
        let request: ReturnType<typeof parseWebFetchArguments>;
        try {
          request = parseWebFetchArguments(args);
        } catch (error) {
          if (error instanceof WebToolArgumentError) return textResult(error.message, true);
          throw error;
        }
        const cached = pages.get(request.url);
        if (cached) return textResult(renderWebPageWindow(cached, request), false);
        const outcome = await callWithFailover({
          ...shared,
          operation: "fetch",
          candidates,
          operationId: context.operationId,
          signal: context.signal,
          call: (adapter) => adapter.fetch({ url: request.url }, { signal: context.signal }),
          reportedCostMicros: (page) => page.reportedCostMicros,
        });
        if (!outcome.ok) return textResult(outcome.message, true);
        const page = outcome.value;
        if (pages.size >= PAGE_CACHE_ENTRIES) {
          pages.delete(pages.keys().next().value!);
        }
        // Bound per-attempt memory; one extra character keeps the cut visible.
        pages.set(request.url, {
          ...page,
          content: page.content.slice(0, WEB_FETCH_RETAINED_MAX_CHARS + 1),
        });
        return textResult(renderWebPageWindow(page, request), false);
      },
    });
  }
  return definitions;
}
