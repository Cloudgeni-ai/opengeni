#!/usr/bin/env bun
/**
 * Compare a model's hosted web search with Opengeni's provider-agnostic
 * `web_search` / `web_fetch` tools on a few real, dated questions.
 *
 * Both arms use the same Responses model. The hosted arm attaches the
 * provider-executed `web_search` tool; the agnostic arm attaches the two
 * function tools backed by the configured provider adapter (the same adapters
 * and rendering the worker uses). A tool-less judge grades each answer against
 * a reference written when the eval was authored.
 *
 * Usage (Azure OpenAI Responses v1; the base URL ends in /openai/v1):
 *
 *   OPENGENI_AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1 \
 *   OPENGENI_AZURE_OPENAI_API_KEY=... \
 *   OPENGENI_WEB_SEARCH_PROVIDER=tinyfish OPENGENI_WEB_TINYFISH_API_KEY=... \
 *   bun scripts/web-search-eval.ts [--model gpt-5.6-sol] [--arms hosted,agnostic] [--json out.json]
 *
 * `--arms retrieval` needs no model key: it runs only the provider adapters,
 * reporting latency and whether the reference facts appear in the snippets and
 * in the top fetched pages.
 *
 * Every web search setting is read exactly as the worker reads it; the eval
 * measures the first provider of each slot (no failover). Set OPENAI_API_KEY
 * (and optionally OPENAI_BASE_URL) instead of the Azure pair to use OpenAI
 * directly.
 */
import {
  getSettings,
  resolveWebSearchProvider,
  webSearchCallPricing,
  type WebSearchProviderConfig,
} from "@opengeni/config";
import {
  WEB_FETCH_TOOL_DESCRIPTION,
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
} from "@opengeni/runtime/web-search";

type Case = {
  id: string;
  question: string;
  reference: string;
  /** Short search query for the retrieval-only arm. */
  query: string;
  /** Every pattern must appear for retrieval to count as containing the answer. */
  facts: RegExp[];
};

/** References were checked on 2026-10-05; update them when re-running later. */
const CASES: Case[] = [
  {
    id: "world-cup-2026",
    question: "Who won the 2026 FIFA World Cup final, against whom, and what was the score?",
    reference:
      "Spain beat Argentina 1-0 after extra time on 19 July 2026 (Ferran Torres, 106th minute).",
    query: "2026 FIFA World Cup final result",
    facts: [/spain/iu, /argentina/iu],
  },
  {
    id: "kubernetes-latest-minor",
    question:
      "What is the newest Kubernetes minor release as of October 2026, and when was it released?",
    reference: "Kubernetes v1.37 ('Garhwal'), released 26 August 2026.",
    query: "latest Kubernetes release",
    facts: [/1\.37/u],
  },
  {
    id: "bun-latest",
    question:
      "What is the latest stable Bun release as of early October 2026, and its release date?",
    reference: "Bun v1.4.2, released 5 September 2026 (v1.4.0 was 20 August 2026).",
    query: "Bun latest release version",
    facts: [/1\.4\.2/u],
  },
  {
    id: "tavily-pricing",
    question:
      "What does Tavily charge per API credit on pay-as-you-go, and how many credits does one basic search cost?",
    reference: "$0.008 per credit pay-as-you-go; a basic search costs 1 credit (advanced costs 2).",
    query: "Tavily API pay as you go price per credit",
    facts: [/0\.008/u],
  },
  {
    id: "tinyfish-search-pricing",
    question: "Does TinyFish charge for its Search API? Answer with its current pricing.",
    reference:
      "TinyFish Search (and Fetch) is free at any wallet balance; it never draws from the wallet.",
    query: "TinyFish Search API pricing",
    facts: [/tinyfish/iu, /\bfree\b/iu],
  },
  {
    id: "exa-search-pricing",
    question: "What is Exa's list price per 1,000 requests for its default 'auto' search type?",
    reference: "$7 per 1,000 requests for auto/fast search (up to 10 results); contents are extra.",
    query: "Exa search API pricing per 1000 requests",
    facts: [/\$\s?7\b/u],
  },
];

// Model list prices for the cost estimate (USD per 1M tokens). Hosted search
// on OpenAI/Azure also charges per tool call.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6-luna": { input: 0.4, cached: 0.04, output: 2.5 },
};
const HOSTED_SEARCH_USD_PER_CALL = 0.01;
const MAX_TOOL_ROUNDS = 8;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const model = arg("model") ?? process.env.OPENGENI_EVAL_MODEL ?? "gpt-5.6-sol";
const arms = (arg("arms") ?? "hosted,agnostic").split(",").map((value) => value.trim());
const jsonOut = arg("json");

function endpoint(): { url: string; headers: Record<string, string> } {
  const azureBase = process.env.OPENGENI_AZURE_OPENAI_BASE_URL;
  const azureKey = process.env.OPENGENI_AZURE_OPENAI_API_KEY;
  if (azureBase && azureKey) {
    return {
      url: `${azureBase.replace(/\/+$/u, "")}/responses`,
      headers: { "api-key": azureKey, "content-type": "application/json" },
    };
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Set the Azure pair or OPENAI_API_KEY");
  return {
    url: `${(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/u, "")}/responses`,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  };
}

type Usage = { input_tokens: number; output_tokens: number; cached: number };
type OutputItem = Record<string, unknown> & { type: string };

async function respond(body: Record<string, unknown>): Promise<{
  id: string;
  output: OutputItem[];
  usage: Usage;
}> {
  const { url, headers } = endpoint();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, ...body }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Responses API ${response.status}: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text) as {
    id: string;
    output: OutputItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  return {
    id: parsed.id,
    output: parsed.output,
    usage: {
      input_tokens: parsed.usage?.input_tokens ?? 0,
      output_tokens: parsed.usage?.output_tokens ?? 0,
      cached: parsed.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
  };
}

function finalText(output: OutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content as Array<{ type: string; text?: string }>) ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function modelUsd(usage: Usage): number {
  const price = PRICES[model] ?? PRICES["gpt-5.6-sol"]!;
  return (
    ((usage.input_tokens - usage.cached) * price.input +
      usage.cached * price.cached +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

const INSTRUCTIONS =
  "Answer the question using current information from the web. Be concise: two or three sentences, then list the URLs you relied on.";

type ArmResult = {
  arm: string;
  answer: string;
  seconds: number;
  toolCalls: number;
  usage: Usage;
  modelUsd: number;
  searchUsd: number;
  error?: string;
};

async function hostedArm(question: string): Promise<ArmResult> {
  const started = performance.now();
  const response = await respond({
    instructions: INSTRUCTIONS,
    input: question,
    tools: [{ type: "web_search" }],
    reasoning: { effort: "medium" },
  });
  const calls = response.output.filter((item) => item.type === "web_search_call").length;
  return {
    arm: "hosted",
    answer: finalText(response.output),
    seconds: (performance.now() - started) / 1000,
    toolCalls: calls,
    usage: response.usage,
    modelUsd: modelUsd(response.usage),
    searchUsd: calls * HOSTED_SEARCH_USD_PER_CALL,
  };
}

async function agnosticArm(question: string, config: WebSearchProviderConfig): Promise<ArmResult> {
  const search = createWebSearchProvider({
    endpoint: config.search[0]!,
    timeoutMs: config.timeoutMs,
  });
  const reader = config.fetch[0]
    ? createWebFetchProvider({ endpoint: config.fetch[0], timeoutMs: config.timeoutMs })
    : null;
  const tools = [
    {
      type: "function",
      name: "web_search",
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      parameters: webSearchInputSchema,
      strict: false,
    },
    ...(reader
      ? [
          {
            type: "function",
            name: "web_fetch",
            description: WEB_FETCH_TOOL_DESCRIPTION,
            parameters: webFetchInputSchema,
            strict: false,
          },
        ]
      : []),
  ];
  const started = performance.now();
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cached: 0 };
  let toolCalls = 0;
  let searchMicros = 0;
  let previous: string | undefined;
  let input: unknown = question;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const response = await respond({
      instructions: INSTRUCTIONS,
      input,
      tools,
      reasoning: { effort: "medium" },
      ...(previous ? { previous_response_id: previous } : {}),
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cached += response.usage.cached;
    previous = response.id;
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      return {
        arm: `agnostic:${config.search[0]!.provider}${config.fetch[0] && config.fetch[0].provider !== config.search[0]!.provider ? `+${config.fetch[0].provider}` : ""}`,
        answer: finalText(response.output),
        seconds: (performance.now() - started) / 1000,
        toolCalls,
        usage,
        modelUsd: modelUsd(usage),
        searchUsd: searchMicros / 1_000_000,
      };
    }
    const outputs: unknown[] = [];
    for (const call of calls) {
      toolCalls += 1;
      const args = JSON.parse(String(call.arguments ?? "{}")) as Record<string, unknown>;
      let output: string;
      try {
        if (call.name === "web_search") {
          const request = parseWebSearchArguments(args);
          const result = await search.search(request);
          searchMicros +=
            result.reportedCostMicros ??
            webSearchCallPricing(config, config.search[0]!, "search").providerMicros;
          output = renderWebSearchResults(request.query, result.results);
        } else if (call.name === "web_fetch" && reader) {
          const request = parseWebFetchArguments(args);
          const page = await reader.fetch({ url: request.url });
          searchMicros +=
            page.reportedCostMicros ??
            webSearchCallPricing(config, config.fetch[0]!, "fetch").providerMicros;
          output = renderWebPageWindow(page, request);
        } else {
          output = `Unknown tool ${String(call.name)}`;
        }
      } catch (error) {
        if (!(error instanceof WebSearchProviderError || error instanceof WebToolArgumentError))
          throw error;
        output = `Error: ${error.message}`;
      }
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    input = outputs;
  }
  throw new Error("unreachable");
}

async function retrievalArm(item: Case, config: WebSearchProviderConfig) {
  const search = createWebSearchProvider({
    endpoint: config.search[0]!,
    timeoutMs: config.timeoutMs,
  });
  const reader = config.fetch[0]
    ? createWebFetchProvider({ endpoint: config.fetch[0], timeoutMs: config.timeoutMs })
    : null;
  const contains = (text: string) => item.facts.every((fact) => fact.test(text));
  const started = performance.now();
  const result = await search.search({ query: item.query, maxResults: 5 });
  const searchSeconds = (performance.now() - started) / 1000;
  const rendered = renderWebSearchResults(item.query, result.results);
  let fetchSeconds = 0;
  let fetched = 0;
  let inPages = false;
  if (reader) {
    for (const hit of result.results.slice(0, 3)) {
      const pageStarted = performance.now();
      try {
        const page = await reader.fetch({ url: hit.url });
        fetched += 1;
        if (contains(page.content)) inPages = true;
      } catch {
        // Counted as not fetched.
      }
      fetchSeconds += (performance.now() - pageStarted) / 1000;
    }
  }
  return {
    case: item.id,
    results: result.results.length,
    inSnippets: contains(rendered),
    inTopPages: inPages,
    searchSeconds: Number(searchSeconds.toFixed(2)),
    pagesFetched: fetched,
    meanFetchSeconds: fetched ? Number((fetchSeconds / Math.max(1, fetched)).toFixed(2)) : 0,
    renderedChars: rendered.length,
    top: result.results.slice(0, 3).map((hit) => hit.url),
  };
}

async function judge(item: Case, answer: string): Promise<{ score: number; reason: string }> {
  if (!answer) return { score: 0, reason: "empty answer" };
  const response = await respond({
    instructions:
      'You grade answers against a reference. Reply with JSON only: {"score":0|1|2,"reason":"..."}. 2 = matches the reference on every key fact; 1 = partly correct or missing a key fact; 0 = wrong, refused, or unsupported. Do not use outside knowledge.',
    input: `Question: ${item.question}\nReference: ${item.reference}\nAnswer: ${answer}`,
    reasoning: { effort: "low" },
  });
  const text = finalText(response.output);
  const match = /\{[\s\S]*\}/u.exec(text);
  try {
    const parsed = JSON.parse(match?.[0] ?? text) as { score: number; reason: string };
    return { score: Number(parsed.score), reason: String(parsed.reason) };
  } catch {
    return { score: 0, reason: `unparseable judge reply: ${text.slice(0, 120)}` };
  }
}

async function main() {
  const resolution = resolveWebSearchProvider({
    ...getSettings({ OPENGENI_ENV: "test", ...process.env }),
    webSearchEnabled: true,
  });
  if (arms.includes("agnostic") && resolution.status !== "configured") {
    throw new Error(
      resolution.status === "invalid"
        ? resolution.reason
        : "Set OPENGENI_WEB_SEARCH_PROVIDER (and its key) for the agnostic arm",
    );
  }
  if (arms.includes("retrieval")) {
    if (resolution.status !== "configured")
      throw new Error("retrieval needs a configured provider");
    const retrieval = [];
    for (const item of CASES) retrieval.push(await retrievalArm(item, resolution.config));
    console.table(retrieval.map(({ top: _top, ...row }) => row));
    for (const row of retrieval) console.log(`${row.case}: ${row.top.join("  ")}`);
    if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ retrieval }, null, 2));
    return;
  }
  const rows: Array<{ case: string } & ArmResult & { score: number; reason: string }> = [];
  for (const item of CASES) {
    for (const arm of arms) {
      let result: ArmResult;
      try {
        result =
          arm === "hosted"
            ? await hostedArm(item.question)
            : await agnosticArm(
                item.question,
                (resolution as { config: WebSearchProviderConfig }).config,
              );
      } catch (error) {
        result = {
          arm,
          answer: "",
          seconds: 0,
          toolCalls: 0,
          usage: { input_tokens: 0, output_tokens: 0, cached: 0 },
          modelUsd: 0,
          searchUsd: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const grade = result.error
        ? { score: 0, reason: result.error }
        : await judge(item, result.answer);
      rows.push({ case: item.id, ...result, ...grade });
      console.error(
        `${item.id.padEnd(26)} ${result.arm.padEnd(22)} score=${grade.score} ${result.seconds.toFixed(1)}s tools=${result.toolCalls} in=${result.usage.input_tokens} out=${result.usage.output_tokens} $${(result.modelUsd + result.searchUsd).toFixed(4)}`,
      );
    }
  }
  const summary = [...new Set(rows.map((row) => row.arm))].map((arm) => {
    const mine = rows.filter((row) => row.arm === arm);
    const sum = (pick: (row: (typeof mine)[number]) => number) =>
      mine.reduce((total, row) => total + pick(row), 0);
    return {
      arm,
      cases: mine.length,
      score: `${sum((row) => row.score)}/${mine.length * 2}`,
      meanSeconds: Number((sum((row) => row.seconds) / mine.length).toFixed(1)),
      meanToolCalls: Number((sum((row) => row.toolCalls) / mine.length).toFixed(1)),
      meanInputTokens: Math.round(sum((row) => row.usage.input_tokens) / mine.length),
      modelUsd: Number(sum((row) => row.modelUsd).toFixed(4)),
      searchUsd: Number(sum((row) => row.searchUsd).toFixed(4)),
    };
  });
  console.table(summary);
  for (const row of rows) {
    console.log(`\n[${row.case} / ${row.arm}] score ${row.score}: ${row.reason}\n${row.answer}`);
  }
  if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ model, summary, rows }, null, 2));
}

await main();
