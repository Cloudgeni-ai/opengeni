#!/usr/bin/env bun
/**
 * Tool search evaluation harness. Replays a real exported catalog against a
 * scenario set and compares search strategies side by side. No tool executes.
 *
 *   bun scripts/tool-discovery-eval/run.ts --catalog catalog.json \
 *     [--scenarios scenarios.jsonl] --out results-dir \
 *     [--strategies runtime-generic,runtime-native,runtime-codex,runtime-selector,runtime-selector-codex,keywords,card-keywords,embeddings,fused,two-stage,whole-catalog]
 *
 * See README.md for formats, providers and options. Catalogs, scenarios and
 * results from private deployments stay out of version control.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LazyToolRuntime } from "../../packages/runtime/src/lazy-tool-transport";
import { CARD_VERSION, toolContentHash, writeCards, type TaskCard } from "./harness/cards";
import { loadCatalog } from "./harness/catalog";
import { summarize } from "./harness/metrics";
import {
  Budget,
  ChatClient,
  decisionModelFromEnv,
  EmbeddingClient,
  endpointFromEnv,
  rateLimitWait,
  ResponseCache,
} from "./harness/providers";
import { markdownReport } from "./harness/report";
import { loadScenarios } from "./harness/scenarios";
import {
  cardKeywordRanker,
  decisionToolSelector,
  embeddingRanker,
  fusedRanker,
  lexicalRanker,
  rankOnlyStrategy,
  runtimeStrategy,
  selectorStrategy,
  type Ranker,
} from "./harness/strategies";
import type { SearchRecord, Strategy } from "./harness/types";

const args = process.argv.slice(2);
function option(flag: string): string | undefined {
  const index = args.indexOf(`--${flag}`);
  return index < 0 ? undefined : args[index + 1];
}
const flag = (name: string) => args.includes(`--${name}`);
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const catalogPath = option("catalog");
const outDir = option("out");
if (!catalogPath || !outDir) {
  console.error("Required: --catalog <catalog.json> --out <results directory>. See README.md.");
  process.exit(2);
}
const scenarioPath =
  option("scenarios") ??
  new URL("../fixtures/tool-discovery-queries.json", import.meta.url).pathname;
const strategyNames = list(option("strategies") ?? "runtime-generic,runtime-native,keywords");
const ks = list(option("k") ?? "50").map(Number);
const withTask = flag("with-task");
const selectorEffort = option("selector-effort");
const concurrency = Number(option("concurrency") ?? 4);
const repeat = Number(option("repeat") ?? 1);
const budget = new Budget(Number(option("budget-usd") ?? 2));
const cache = new ResponseCache(
  flag("no-cache")
    ? undefined
    : (option("cache-dir") ?? join(homedir(), ".cache", "opengeni-tool-eval")),
);

const catalog = await loadCatalog(catalogPath);
const { scenarios, problems } = await loadScenarios(scenarioPath, catalog);
if (problems.length) {
  console.error(`Scenario problems (fix or remove these cases):\n${problems.join("\n")}`);
  if (!flag("skip-problems")) process.exit(2);
}

// The searchable pool is whatever the runtime defers: its definition, not a copy of it.
const poolRuntime = runtimeForPool();
function runtimeForPool() {
  const servers = new Map(
    catalog.tools.flatMap((tool) => (tool.server ? [[tool.name, tool.server] as const] : [])),
  );
  const ids = new Set(servers.values());
  const runtime = new LazyToolRuntime(
    "generic_dispatch",
    ids,
    undefined,
    ids,
    new Set(),
    () => servers,
  );
  runtime.refresh(catalog.functionTools);
  return runtime;
}
const searchable = new Set(poolRuntime.inspectSearchableTools().map((tool) => tool.name));
const deferred = catalog.tools.filter((tool) => searchable.has(tool.name) && !tool.eager);
const deferredFunctions = catalog.functionTools.filter((tool) =>
  deferred.some((d) => d.name === (tool as { name?: string }).name),
);

const selectorEndpoint = endpointFromEnv("TOOL_EVAL_SELECTOR");
const selectorModels = list(option("selector-models"));
const selectors = selectorEndpoint
  ? (selectorModels.length ? selectorModels : [selectorEndpoint.model]).map(
      (model) => new ChatClient({ ...selectorEndpoint, model }, cache, budget),
    )
  : [];
// The runtime's own selector: typed decision models, as a deployment configures them.
const decisionModels = (
  await Promise.all(
    (list(option("decision-models")).length ? list(option("decision-models")) : [undefined]).map(
      (model) => decisionModelFromEnv("TOOL_EVAL_DECISION", cache, budget, model),
    ),
  )
).filter((model) => model !== undefined);
const embeddingEndpoint = endpointFromEnv("TOOL_EVAL_EMBEDDING");
const embeddings = embeddingEndpoint
  ? new EmbeddingClient(
      embeddingEndpoint,
      cache,
      budget,
      process.env.TOOL_EVAL_EMBEDDING_DIMENSIONS
        ? Number(process.env.TOOL_EVAL_EMBEDDING_DIMENSIONS)
        : undefined,
    )
  : undefined;

// Task cards: read from --cards, write any missing ones when a card writer is configured.
let cards: Map<string, TaskCard> | undefined;
const cardsPath = option("cards");
if (cardsPath) {
  const file = Bun.file(cardsPath);
  const stored = (await file.exists())
    ? ((await file.json()) as {
        version: number;
        cards: Record<string, { hash: string; card: TaskCard }>;
      })
    : { version: CARD_VERSION, cards: {} };
  const current = stored.version === CARD_VERSION ? stored.cards : {};
  cards = new Map();
  const missing = deferred.filter((tool) => current[tool.name]?.hash !== toolContentHash(tool));
  for (const tool of deferred)
    if (current[tool.name]?.hash === toolContentHash(tool))
      cards.set(tool.name, current[tool.name]!.card);
  if (missing.length) {
    const writerEndpoint = endpointFromEnv("TOOL_EVAL_CARDS") ?? selectorEndpoint;
    if (!writerEndpoint)
      throw new Error(`${missing.length} tools lack cards and no card writer is configured`);
    console.error(`Writing ${missing.length} task cards with ${writerEndpoint.model}…`);
    const written = await writeCards(missing, new ChatClient(writerEndpoint, cache, budget), {
      ...(process.env.TOOL_EVAL_CARDS_REASONING
        ? { reasoningEffort: process.env.TOOL_EVAL_CARDS_REASONING }
        : {}),
    });
    for (const [toolName, card] of written.cards) cards.set(toolName, card);
    console.error(`Cards written for $${written.costUsd.toFixed(4)}.`);
    await Bun.write(
      cardsPath,
      JSON.stringify(
        {
          version: CARD_VERSION,
          writer: written.writer,
          cards: Object.fromEntries(
            deferred
              .filter((tool) => cards!.has(tool.name))
              .map((tool) => [
                tool.name,
                { hash: toolContentHash(tool), card: cards!.get(tool.name)! },
              ]),
          ),
        },
        null,
        2,
      ),
    );
  }
}

// Stage 1 rankers, built once.
const keywords = lexicalRanker(deferredFunctions);
const cardKeywords = cards ? cardKeywordRanker(cards) : undefined;
const embedded = embeddings
  ? await embeddingRanker(deferred, embeddings, cards, { withTask })
  : undefined;
const fused: Ranker = fusedRanker([
  keywords,
  ...(cardKeywords ? [cardKeywords] : []),
  ...(embedded ? [embedded] : []),
]);
const need = (value: unknown, what: string) => {
  if (!value) throw new Error(`Strategy needs ${what}; see README.md`);
};

const strategies: { strategy: Strategy; sequential: boolean }[] = [];
for (const name of strategyNames) {
  const route = (suffix: string) =>
    suffix === "native"
      ? "openai_native"
      : suffix === "codex"
        ? "codex_native"
        : "generic_dispatch";
  if (name === "runtime-generic" || name === "runtime-native" || name === "runtime-codex")
    strategies.push({
      strategy: runtimeStrategy(catalog, route(name.slice("runtime-".length))),
      sequential: false,
    });
  else if (name === "runtime-selector" || name === "runtime-selector-codex") {
    need(decisionModels.length, "TOOL_EVAL_DECISION_* settings");
    for (const decision of decisionModels)
      strategies.push({
        strategy: runtimeStrategy(
          catalog,
          route(name === "runtime-selector" ? "generic" : "codex"),
          {
            label: decision.label,
            create: () => decisionToolSelector(decision.model, decision.label),
          },
        ),
        sequential: false,
      });
  } else if (name === "keywords")
    strategies.push({ strategy: rankOnlyStrategy(catalog, keywords), sequential: false });
  else if (name === "card-keywords") {
    need(cardKeywords, "--cards");
    strategies.push({ strategy: rankOnlyStrategy(catalog, cardKeywords!), sequential: false });
  } else if (name === "embeddings") {
    need(embedded, "TOOL_EVAL_EMBEDDING_* settings");
    strategies.push({ strategy: rankOnlyStrategy(catalog, embedded!), sequential: false });
  } else if (name === "fused")
    strategies.push({ strategy: rankOnlyStrategy(catalog, fused), sequential: false });
  else if (name === "two-stage" || name === "two-stage-keywords") {
    need(selectors.length, "TOOL_EVAL_SELECTOR_* settings");
    const ranker = name === "two-stage" ? fused : keywords;
    for (const chat of selectors)
      for (const k of ks)
        strategies.push({
          strategy: selectorStrategy(catalog, deferred, ranker, chat, cards, {
            k,
            withTask,
            alternativesWhenUnsureOnly: !flag("always-alternatives"),
            ...(selectorEffort ? { reasoningEffort: selectorEffort } : {}),
          }),
          sequential: false,
        });
  } else if (name === "whole-catalog") {
    need(selectors.length, "TOOL_EVAL_SELECTOR_* settings");
    for (const chat of selectors)
      strategies.push({
        strategy: selectorStrategy(catalog, deferred, undefined, chat, cards, {
          k: deferred.length,
          withTask,
          alternativesWhenUnsureOnly: !flag("always-alternatives"),
          ...(selectorEffort ? { reasoningEffort: selectorEffort } : {}),
        }),
        sequential: false,
      });
  } else throw new Error(`Unknown strategy ${name}`);
}

// A scenario's queries are one turn, in order; repeats replay the whole turn.
const turns = scenarios.flatMap((scenario) => Array.from({ length: repeat }, () => scenario));
const searchCount = turns.reduce((sum, scenario) => sum + scenario.queries.length, 0);
const records: SearchRecord[] = [];
for (const { strategy, sequential } of strategies) {
  const queue = [...turns];
  const worker = async () => {
    for (let scenario = queue.shift(); scenario; scenario = queue.shift()) {
      const turn = strategy.turn?.() ?? strategy;
      for (const query of scenario.queries) {
        const record: SearchRecord = {
          scenario: scenario.id,
          tags: scenario.tags,
          query,
          ...(scenario.task ? { task: scenario.task } : {}),
          acceptable: scenario.acceptable,
          strategy: strategy.name,
        };
        try {
          const waited = { ms: 0 };
          record.trace = await rateLimitWait.run(waited, () =>
            turn.search({ query, ...(scenario.task ? { task: scenario.task } : {}) }),
          );
          // Waiting out the eval's own rate limits is not search latency.
          record.trace.latencyMs -= waited.ms;
          if (waited.ms)
            for (const stage of record.trace.stages)
              if (stage.latencyMs !== undefined && stage.latencyMs >= waited.ms)
                stage.latencyMs -= waited.ms;
        } catch (error) {
          record.error = (error as Error).message;
          if (record.error.includes("budget")) throw error;
        }
        records.push(record);
      }
    }
  };
  await Promise.all(Array.from({ length: sequential ? 1 : concurrency }, worker));
  const summary = summarize(records.filter((r) => r.strategy === strategy.name));
  console.error(
    `${strategy.name}: first pick ${(summary.firstPick * 100).toFixed(1)}%, loaded or shown ${(summary.visible * 100).toFixed(1)}%`,
  );
}

await mkdir(outDir, { recursive: true });
const meta = {
  catalog: `${catalogPath} (sha256 ${catalog.sha256.slice(0, 12)}, ${catalog.tools.length} tools, ${deferred.length} searchable)`,
  scenarios: `${scenarioPath} (${scenarios.length} scenarios, ${searchCount} searches per strategy)`,
  ...(decisionModels.length
    ? { decisionModels: decisionModels.map((model) => model.label).join(", ") }
    : {}),
  ...(cards ? { cards: `${cards.size} task cards, version ${CARD_VERSION}` } : {}),
  ...(embeddings ? { embeddings: embeddings.label } : {}),
  ...(withTask ? { task: "the user's request is given to strategies that use it" } : {}),
  newSpendingUsd: Number(budget.spentUsd.toFixed(4)),
  ranAt: new Date().toISOString(),
};
await Bun.write(
  join(outDir, "results.json"),
  JSON.stringify(
    {
      meta,
      summaries: Object.fromEntries(
        strategies.map(({ strategy }) => [
          strategy.name,
          summarize(records.filter((r) => r.strategy === strategy.name)),
        ]),
      ),
      records,
    },
    null,
    2,
  ),
);
await Bun.write(
  join(outDir, "report.md"),
  markdownReport(
    catalog,
    records,
    strategies.map(({ strategy }) => strategy),
    meta,
  ),
);
console.error(
  `Wrote ${join(outDir, "report.md")} and results.json. New spending: $${budget.spentUsd.toFixed(4)}.`,
);
