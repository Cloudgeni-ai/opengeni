import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  webSearchCallPricing,
  webSearchCreditMicros,
  webSearchProviderConfig,
  webSearchToolPlan,
  type WebSearchProviderConfig,
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
  resolvedModel: { configured: { hostedWebSearch: boolean }; provider: { kind?: string } } | null,
  settings: WebSearchSettings,
) {
  return webSearchToolPlan(settings, {
    hostedWebSearch: hostedWebSearchForTurn(resolvedModel, settings.webSearchEnabled),
    // SuperGrok's native search is added by its transport, not as an agent
    // tool, so provider tools would only duplicate it.
    transportHostedSearch: resolvedModel?.provider.kind === "xai-subscription",
  });
}

/** Pages kept per attempt so paging through one page is not billed again. */
const PAGE_CACHE_ENTRIES = 16;

function textResult(text: string, isError: boolean) {
  return { isError, content: [{ type: "text" as const, text }] };
}

type Pricing = ReturnType<typeof webSearchCallPricing>;

function settledCost(
  operationId: string,
  operation: "search" | "fetch",
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
  observability: Pick<Observability, "warn">;
  fetch?: typeof fetch;
}): AttemptToolDefinition[] {
  const config: WebSearchProviderConfig | null = webSearchProviderConfig(input.settings);
  if (!config || input.tools.length === 0) return [];
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
  const definitions: AttemptToolDefinition[] = [];

  if (input.tools.includes(WEB_SEARCH_TOOL_NAME)) {
    const provider = createWebSearchProvider({ ...adapterInput, endpoint: config.search });
    const pricing = webSearchCallPricing(config, "search");
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
          await input.billing.admit(input.scope, pricing.providerMicros);
        } catch (error) {
          if (
            error instanceof WebToolArgumentError ||
            error instanceof WebSearchBillingRefusedError
          )
            return textResult(error.message, true);
          throw error;
        }
        try {
          const response = await provider.search(request, { signal: context.signal });
          await settle(
            settledCost(
              context.operationId,
              "search",
              config.search.provider,
              pricing,
              response.reportedCostMicros,
            ),
          );
          return textResult(renderWebSearchResults(request.query, response.results), false);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          if (error instanceof WebSearchProviderError) {
            return textResult(`Web search failed: ${providerFailure(error)}`, true);
          }
          throw error;
        }
      },
    });
  }

  if (input.tools.includes(WEB_FETCH_TOOL_NAME) && config.fetch) {
    const fetchEndpoint = config.fetch;
    const provider = createWebFetchProvider({ ...adapterInput, endpoint: fetchEndpoint });
    const pricing = webSearchCallPricing(config, "fetch");
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
        try {
          await input.billing.admit(input.scope, pricing.providerMicros);
        } catch (error) {
          if (error instanceof WebSearchBillingRefusedError) return textResult(error.message, true);
          throw error;
        }
        try {
          const page = await provider.fetch({ url: request.url }, { signal: context.signal });
          await settle(
            settledCost(
              context.operationId,
              "fetch",
              fetchEndpoint.provider,
              pricing,
              page.reportedCostMicros,
            ),
          );
          if (pages.size >= PAGE_CACHE_ENTRIES) {
            pages.delete(pages.keys().next().value!);
          }
          // Bound per-attempt memory; one extra character keeps the cut visible.
          pages.set(request.url, {
            ...page,
            content: page.content.slice(0, WEB_FETCH_RETAINED_MAX_CHARS + 1),
          });
          return textResult(renderWebPageWindow(page, request), false);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          if (error instanceof WebSearchProviderError) {
            return textResult(`Web fetch failed: ${providerFailure(error)}`, true);
          }
          throw error;
        }
      },
    });
  }
  return definitions;
}
