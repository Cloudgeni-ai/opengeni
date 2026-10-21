#!/usr/bin/env bun
/**
 * Live decision-model comparison on a frozen catalog and query set. No tools execute.
 * DECISION_MODEL_API_KEY=... bun scripts/tool-discovery-decision-eval.ts \
 *   --catalog catalog.json --out results.json --model provider/model \
 *   [--candidates all|40] [--queries queries.json]
 * --backend jev uses OPENGENI_JEV_API_KEY and the existing Jev client instead.
 * Never commits catalogs/results or executes a domain tool.
 */
import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";
import { ToolSearchIndex } from "../packages/runtime/src/tool-discovery-ranking";
import { LazyToolRuntime } from "../packages/runtime/src/lazy-tool-transport";
import {
  decisionCandidate,
  createToolSelector,
  TOOL_SELECTION_PROTOCOL,
} from "../packages/runtime/src/tool-discovery-decision";
import {
  TOOL_DECISION_INSTRUCTIONS,
  toolDecisionRequest,
  parseToolDecision,
} from "./tool-discovery-eval/chat-comparison";
import { configuredEvalDecisionModel } from "./tool-discovery-eval/decision-backend";
import type { DecisionResult, DecisionUsage } from "../packages/decisions/src";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const catalogPath = option("catalog"),
  outputPath = option("out"),
  model = option("model");
if (!catalogPath || !outputPath || !model)
  throw new Error("Required: --catalog, --out and --model");
const backend = option("backend") ?? "openrouter";
const typed =
  backend === "openai-compatible" ? undefined : configuredEvalDecisionModel(backend, model);
const apiKey = process.env.DECISION_MODEL_API_KEY;
const baseUrl = process.env.DECISION_MODEL_BASE_URL;
if (!typed && (!apiKey || !baseUrl))
  throw new Error("Comparison account key and base URL must be configured");
if (typed && (option("provider") || option("reasoning")))
  throw new Error("Typed judgments do not use chat routing or reasoning flags");
const text = await Bun.file(catalogPath).text();
const parsed = JSON.parse(text);
const entries = (Array.isArray(parsed) ? parsed : parsed.tools) as Array<{
  name: string;
  description: string;
  parameters?: unknown;
  inputSchema?: unknown;
  identity?: { serverId?: string };
}>;
const catalogTools = entries.map(
  (t) =>
    ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? t.inputSchema,
      strict: false,
    }) as Tool,
);
const servers = new Map(
  entries.flatMap((t) => (t.identity?.serverId ? [[t.name, t.identity.serverId] as const] : [])),
);
const runtime = new LazyToolRuntime(
  "generic_dispatch",
  new Set(servers.values()),
  undefined,
  new Set(servers.values()),
  new Set(),
  () => servers,
);
runtime.refresh(catalogTools);
const pool = runtime.inspectSearchableTools().map((t) => ({ ...t, type: "function" }) as Tool);
const index = new ToolSearchIndex(pool);
const cases = (await Bun.file(
  option("queries") ?? new URL("./fixtures/tool-discovery-queries.json", import.meta.url),
).json()) as Array<{
  id: string;
  source: string;
  query: string;
  expected: string[];
  multiIntent?: boolean;
}>;
const candidateCount = option("candidates") ?? "40";
if (candidateCount !== "all" && (!/^\d+$/.test(candidateCount) || Number(candidateCount) < 1))
  throw new Error("candidates must be all or a positive integer");
const instruction = TOOL_DECISION_INSTRUCTIONS;
const provider = option("provider");
const effort = option("reasoning") ?? "none";
const metadata = {
  requestVersion: 4,
  backend,
  endpoint: typed?.metadata ?? { baseUrl },
  catalogSha256: createHash("sha256").update(text).digest("hex"),
  deferredTools: pool.length,
  candidates: candidateCount,
  querySha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
  model,
  instruction: typed ? TOOL_SELECTION_PROTOCOL : instruction,
  provider: provider ?? null,
  effort: typed ? null : effort,
};
const existing = (await Bun.file(outputPath).exists())
  ? await Bun.file(outputPath).json()
  : { metadata, rows: [] };
if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata))
  throw new Error("Output belongs to a different experiment");
const rows = existing.rows as Array<Record<string, unknown>>;
for (const c of cases) {
  if (rows.some((row) => row.id === c.id)) continue;
  const candidates = (
    candidateCount === "all" ? pool : index.rank(c.query, Number(candidateCount))
  ) as Array<
    Tool & {
      name: string;
      description: string;
      parameters: { properties?: Record<string, unknown> };
    }
  >;
  const started = performance.now();
  const input = {
    query: c.query,
    candidates: candidates.map(decisionCandidate),
  };
  let selected: readonly string[] = [],
    invalid = false;
  let measurement: Record<string, unknown>;
  if (typed && !input.candidates.length) {
    measurement = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: "not-called-empty-shortlist",
      model: null,
      provider: null,
      requests: 0,
      candidateScores: [],
    };
  } else if (typed) {
    let usage: DecisionUsage | undefined;
    let receipt: DecisionResult | undefined;
    try {
      selected = await createToolSelector(typed.model, {
        onUsage: (event) => {
          usage = event;
        },
        onResult: (result) => {
          receipt = result;
        },
      })(input);
    } catch (error) {
      // Without a receipt, usage is unknown: stop and resume rather than invent a
      // zero-cost failed result. Invalid scored responses retain their usage.
      if (!usage) throw error;
      invalid = true;
    }
    if (!usage) throw new Error("Decision model returned no usage receipt");
    measurement = {
      ...usage,
      candidateScores: input.candidates.map((candidate, id) => ({
        name: candidate.name,
        answer: receipt?.answers[String(id)] ?? null,
      })),
    };
  } else {
    const request = toolDecisionRequest(input);
    const format = request.outputFormat as {
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };
    const response = await fetch(`${baseUrl!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        reasoning: { effort },
        ...(provider ? { provider: { order: [provider], allow_fallbacks: false } } : {}),
        messages: request.messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: format.name, schema: format.schema, strict: format.strict },
        },
      }),
    });
    if (!response.ok)
      throw new Error(
        `Decision model HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    const result = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number; cost?: number };
      model: string;
      provider?: string;
    };
    try {
      selected = parseToolDecision(
        result.choices[0]!.message.content,
        candidates.map(decisionCandidate),
      );
    } catch {
      invalid = true;
    }
    measurement = {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
      costUsd: result.usage.cost ?? null,
      costSource: "provider-reported",
      model: result.model,
      provider: result.provider,
    };
  }
  const row = {
    id: c.id,
    source: c.source,
    query: c.query,
    expected: c.expected,
    candidateCount: candidates.length,
    candidateRecall:
      c.expected.filter((n) => candidates.some((t) => t.name === n)).length / c.expected.length,
    top1: c.expected.includes(selected[0] ?? ""),
    top3: selected.slice(0, 3).some((t) => c.expected.includes(t)),
    wronglyIncluded: selected.filter((t) => !c.expected.includes(t)).length,
    selected,
    invalid,
    ms: performance.now() - started,
    ...measurement,
  };
  rows.push(row);
  await Bun.write(outputPath, JSON.stringify({ metadata, rows }, null, 2));
  console.log(
    JSON.stringify({
      id: c.id,
      top1: row.top1,
      top3: row.top3,
      selected: selected.length,
      wronglyIncluded: row.wronglyIncluded,
      ms: row.ms,
      costUsd: measurement.costUsd,
    }),
  );
}
const mean = (key: string) => rows.reduce((sum, row) => sum + Number(row[key]), 0) / rows.length;
const sortedLatency = rows.map((r) => Number(r.ms)).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      queries: rows.length,
      top1: mean("top1"),
      top3: mean("top3"),
      meanWronglyIncluded: mean("wronglyIncluded"),
      meanMs: mean("ms"),
      p95Ms: sortedLatency[Math.ceil(rows.length * 0.95) - 1],
      costSources: [...new Set(rows.map((row) => row.costSource))],
      meanCostUsd: rows.every((r) => typeof r.costUsd === "number") ? mean("costUsd") : null,
      totalCostUsd: rows.every((r) => typeof r.costUsd === "number")
        ? rows.reduce((s, r) => s + Number(r.costUsd), 0)
        : null,
    },
    null,
    2,
  ),
);
