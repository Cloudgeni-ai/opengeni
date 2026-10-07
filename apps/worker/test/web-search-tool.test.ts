import { describe, expect, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  WebSearchBillingRefusedError,
  type WebSearchBilling,
  type WebSearchCallCost,
} from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import {
  turnWebSearchPlan,
  webSearchToolDefinitions,
} from "../src/activities/agent-turn/web-search";

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
};

function fakeBilling(refuse = false) {
  const admitted: number[] = [];
  const settled: WebSearchCallCost[] = [];
  const billing = {
    active: true,
    admit: async (_scope: unknown, micros: number) => {
      admitted.push(micros);
      if (refuse && micros > 0)
        throw new WebSearchBillingRefusedError("insufficient_credits", "no credits");
    },
    settle: async (_scope: unknown, cost: WebSearchCallCost) => {
      settled.push(cost);
    },
  } as unknown as WebSearchBilling;
  return { billing, admitted, settled };
}

function providerFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(responses).find((prefix) => url.startsWith(prefix));
    return new Response(JSON.stringify(key ? responses[key] : {}), {
      status: 200,
    });
  }) as typeof fetch;
  return { impl, calls };
}

const context = (operationId = crypto.randomUUID()): AttemptToolExecutionContext =>
  ({
    operationId,
    caller: { kind: "model" },
  }) as unknown as AttemptToolExecutionContext;

const text = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content.map((block) => block.text).join("");

describe("turn web search plan", () => {
  const settings = testSettings({
    webSearchProvider: "exa",
    webSearchApiKey: "exa-key",
  });
  const model = (hostedWebSearch: boolean, kind = "registry") => ({
    configured: { hostedWebSearch },
    provider: { kind },
  });

  test("models with hosted search keep it; others get provider tools", () => {
    expect(turnWebSearchPlan(model(true), settings)).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
    expect(turnWebSearchPlan(model(false), settings)).toEqual({
      hostedWebSearch: false,
      providerTools: ["web_search", "web_fetch"],
    });
    expect(turnWebSearchPlan(model(false), testSettings())).toEqual({
      hostedWebSearch: false,
      providerTools: [],
    });
  });

  test("replace mode never touches SuperGrok's native search", () => {
    const replace = { ...settings, webSearchProviderMode: "replace" };
    expect(turnWebSearchPlan(model(true), replace).providerTools).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(turnWebSearchPlan(model(true, "xai-subscription"), replace)).toEqual({
      hostedWebSearch: true,
      providerTools: [],
    });
  });
});

function quietObservability() {
  return {
    warn: () => undefined,
    incrementCounter: () => undefined,
    observeHistogram: () => undefined,
  };
}

function recordingObservability() {
  const counters: Array<{ name: string; labels?: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  return {
    counters,
    warnings,
    observability: {
      warn: (message: string) => void warnings.push(message),
      incrementCounter: (input: { name: string; labels?: Record<string, unknown> }) =>
        void counters.push({ name: input.name, labels: input.labels }),
      observeHistogram: () => undefined,
    },
  };
}

describe("web_search and web_fetch attempt tools", () => {
  const settings = testSettings({
    webSearchProvider: "exa",
    webSearchApiKey: "exa-key",
  });

  test("nothing is built for an unconfigured deployment or an empty plan", () => {
    const { billing } = fakeBilling();
    const observability = quietObservability();
    expect(
      webSearchToolDefinitions({
        settings: testSettings(),
        tools: ["web_search"],
        scope,
        billing,
        observability,
      }),
    ).toEqual([]);
    expect(
      webSearchToolDefinitions({
        settings,
        tools: [],
        scope,
        billing,
        observability,
      }),
    ).toEqual([]);
  });

  test("search returns compact results and settles the provider-reported cost", async () => {
    const { billing, admitted, settled } = fakeBilling();
    const fake = providerFetch({
      "https://api.exa.ai/search": {
        results: [
          {
            title: "Bun 2",
            url: "https://bun.sh",
            highlights: ["Released today"],
          },
        ],
        costDollars: { total: 0.009 },
      },
    });
    const [search] = webSearchToolDefinitions({
      settings,
      tools: ["web_search"],
      scope,
      billing,
      observability: quietObservability(),
      fetch: fake.impl,
    });
    expect(search!.modelName).toBe("web_search");
    expect(search!.approval).toBe("none");
    const operationId = crypto.randomUUID();
    const result = await search!.execute({ query: "bun 2 release" }, context(operationId));
    expect(text(result)).toBe(
      "Web results for: bun 2 release\n\n1. Bun 2\n   https://bun.sh\n   Released today",
    );
    expect(admitted).toEqual([8_000]);
    expect(settled).toEqual([
      {
        operationId,
        operation: "search",
        provider: "exa",
        providerMicros: 9_000,
        creditMicros: 9_450,
        marginBps: 500,
        basis: "provider_reported",
      },
    ]);
  });

  test("fetch pages through one page without fetching or billing it again", async () => {
    const { billing, settled } = fakeBilling();
    const fake = providerFetch({
      "https://api.exa.ai/contents": {
        results: [
          {
            url: "https://a.example/doc",
            title: "Doc",
            text: "x".repeat(30_000),
          },
        ],
      },
    });
    const [fetchTool] = webSearchToolDefinitions({
      settings,
      tools: ["web_fetch"],
      scope,
      billing,
      observability: quietObservability(),
      fetch: fake.impl,
    });
    expect(fetchTool!.modelName).toBe("web_fetch");
    const first = text(await fetchTool!.execute({ url: "https://a.example/doc" }, context()));
    expect(first).toContain("Characters 0-20000 of 30000");
    expect(first).toContain("nextOffset: 20000");
    const second = text(
      await fetchTool!.execute({ url: "https://a.example/doc", offset: 20_000 }, context()),
    );
    expect(second).toContain("Characters 20000-30000 of 30000");
    expect(fake.calls).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      operation: "fetch",
      basis: "list_price",
      creditMicros: 1_050,
    });
  });

  test("refusals and bad input are tool errors with no provider call", async () => {
    const { billing } = fakeBilling(true);
    const fake = providerFetch({});
    const [search, fetchTool] = webSearchToolDefinitions({
      settings,
      tools: ["web_search", "web_fetch"],
      scope,
      billing,
      observability: quietObservability(),
      fetch: fake.impl,
    });
    const refused = await search!.execute({ query: "q" }, context());
    expect(refused).toMatchObject({ isError: true });
    expect(text(refused)).toBe("no credits");
    const privateUrl = await fetchTool!.execute({ url: "http://169.254.169.254/" }, context());
    expect(text(privateUrl)).toBe("url must be a public web address");
    expect(fake.calls).toEqual([]);
  });

  test("provider failures are reported to the model, not thrown", async () => {
    const { billing, settled } = fakeBilling();
    const recorded = recordingObservability();
    const [search] = webSearchToolDefinitions({
      settings,
      tools: ["web_search"],
      scope,
      billing,
      observability: recorded.observability,
      fetch: (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch,
    });
    const result = await search!.execute({ query: "q" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe(
      "Web search failed: Provider returned HTTP 503: busy. You may retry shortly.",
    );
    expect(settled).toEqual([]);
    expect(recorded.counters).toEqual([
      {
        name: "opengeni_web_search_calls_total",
        labels: {
          operation: "search",
          provider: "exa",
          outcome: "provider_retryable",
        },
      },
    ]);
    expect(recorded.warnings).toEqual(["web search provider call failed"]);
  });

  test("a successful call is counted with a fixed outcome label", async () => {
    const { billing } = fakeBilling();
    const recorded = recordingObservability();
    const [search] = webSearchToolDefinitions({
      settings,
      tools: ["web_search"],
      scope,
      billing,
      observability: recorded.observability,
      fetch: providerFetch({ "https://api.exa.ai/search": { results: [] } }).impl,
    });
    await search!.execute({ query: "q" }, context());
    expect(recorded.counters).toEqual([
      {
        name: "opengeni_web_search_calls_total",
        labels: { operation: "search", provider: "exa", outcome: "ok" },
      },
    ]);
  });

  test("a failed settlement keeps the result and is logged", async () => {
    const warnings: string[] = [];
    const billing = {
      active: true,
      admit: async () => undefined,
      settle: async () => {
        throw new Error("db down");
      },
    } as unknown as WebSearchBilling;
    const [search] = webSearchToolDefinitions({
      settings,
      tools: ["web_search"],
      scope,
      billing,
      observability: {
        ...quietObservability(),
        warn: (message: string) => void warnings.push(message),
      },
      fetch: providerFetch({ "https://api.exa.ai/search": { results: [] } }).impl,
    });
    const result = await search!.execute({ query: "q" }, context());
    expect(text(result)).toBe("No web results for: q");
    expect(warnings).toEqual(["web search usage settlement failed"]);
  });
});
