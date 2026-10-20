#!/usr/bin/env bun
/**
 * Paired live discovery trajectories, stopping at the first requested domain call.
 * Never executes a domain tool. This is not production traffic or task-success proof.
 * --catalog --queries --out --model --decision-model; provider credentials in env.
 */
import OpenAI from "openai";
import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import type { ReasoningEffort } from "@opengeni/contracts";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { LazyToolRuntime } from "../packages/runtime/src/lazy-tool-transport";
import { createToolDecisionModel } from "../packages/runtime/src/tool-discovery-decision";
import { legacySearchTools } from "./tool-discovery-eval/legacy-ranking";

function option(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const catalog = option("catalog"),
  queries = option("queries"),
  out = option("out"),
  model = option("model"),
  decisionModel = option("decision-model");
const apiKey = process.env.DECISION_MODEL_API_KEY,
  baseURL = process.env.DECISION_MODEL_BASE_URL;
if (!catalog || !queries || !out || !model || !decisionModel || !apiKey || !baseURL)
  throw new Error("Missing eval paths, model IDs or provider environment");
const raw = await Bun.file(catalog).json();
const entries = Array.isArray(raw) ? raw : raw.tools;
const tools = entries.map(
  (t: { name: string; description: string; parameters?: unknown; inputSchema?: unknown }) =>
    ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? t.inputSchema,
      strict: false,
    }) as Tool,
);
const mapping = new Map<string, string>(
  entries.flatMap((t: { name: string; identity?: { serverId?: string } }) =>
    t.identity?.serverId ? [[t.name, t.identity.serverId]] : [],
  ),
);
const makeRuntime = (decision?: ReturnType<typeof createToolDecisionModel>) => {
  const r = new LazyToolRuntime(
    "generic_dispatch",
    new Set(mapping.values()),
    undefined,
    new Set(mapping.values()),
    new Set(),
    () => mapping,
    false,
    false,
    undefined,
    undefined,
    undefined,
    decision,
  );
  r.refresh(tools);
  return r;
};
const baseline = makeRuntime();
const pool = baseline.inspectSearchableTools().map((t) => ({ ...t, type: "function" }) as Tool);
const cases = (
  (await Bun.file(queries).json()) as Array<{ id: string; query: string; expected: string[] }>
).filter((_, i) => i % 3 === 0);
let decisionReceipts: Array<{ provider?: string; costUsd?: number }> = [];
const client = new OpenAI({
  apiKey,
  baseURL,
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok) {
      const result = (await response.clone().json()) as {
        provider?: string;
        usage?: { cost?: number };
      };
      decisionReceipts.push({ provider: result.provider, costUsd: result.usage?.cost });
    }
    return response;
  },
});
const effort = option("decision-reasoning") ?? "none";
if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort))
  throw new Error("Unsupported decision reasoning effort");
const provider = {
  id: "eval",
  api: "chat",
  kind: "api-key",
  baseUrl: baseURL,
} as ResolvedModelProvider;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadata = {
  version: 3,
  catalogSha256: hash(raw),
  queriesSha256: hash(cases),
  model,
  decisionModel,
  decisionReasoning: effort,
  implementation: option("implementation") ?? "working-tree",
};
const prior = (await Bun.file(out).exists()) ? await Bun.file(out).json() : undefined;
if (prior && JSON.stringify(prior.metadata) !== JSON.stringify(metadata))
  throw new Error("Output belongs to a different experiment");
const rows = prior?.rows ?? [];
const baselinePath = option("reuse-baseline");
if (!prior && baselinePath) {
  const source = await Bun.file(baselinePath).json();
  if (source.model !== model) throw new Error("Baseline used a different agent model");
  for (const c of cases) {
    const row = source.rows.find(
      (r: { id: string; arm: string; query: string }) =>
        r.id === c.id && r.arm === "before" && r.query === c.query,
    );
    if (!row) throw new Error(`Baseline lacks case ${c.id}`);
    rows.push({
      ...row,
      expected: c.expected,
      correct: c.expected.includes(row.firstTool),
      decisionModelCostUsd: row.decisionCalls === 0 ? 0 : row.decisionModelCostUsd,
    });
  }
}
for (const c of cases)
  for (const arm of ["before", "after"] as const) {
    if (rows.some((r: { id: string; arm: string }) => r.id === c.id && r.arm === arm)) continue;
    let decisionCalls = 0,
      decisionInputTokens = 0,
      decisionOutputTokens = 0;
    decisionReceipts = [];
    const choose = createToolDecisionModel(
      { client, provider, modelId: decisionModel },
      {
        reasoningEffort: effort as ReasoningEffort,
        onUsage: async (usage) => {
          decisionCalls++;
          decisionInputTokens += usage.usage.inputTokens ?? 0;
          decisionOutputTokens += usage.usage.outputTokens ?? 0;
        },
      },
    );
    const runtime = makeRuntime(decisionModel === "none" ? undefined : choose);
    const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list")!;
    const wireTools = runtime.controlTools
      .filter(
        (
          t,
        ): t is Tool & {
          type: "function";
          name: string;
          description: string;
          parameters: Record<string, unknown>;
        } => t.type === "function",
      )
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description:
            t.name === "tool_search" && arm === "before"
              ? "Search currently authorized tools by capability. Returns matching complete input schemas. Pass exact names with an empty query to load known tools."
              : t.description,
          parameters: t.parameters,
          strict: false,
        },
      }));
    const messages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content:
          "You are evaluating tool discovery. Find the tool that directly performs the requested capability. All domain tools are deferred. Use tool_search or tool_list; do not guess tools that have not been disclosed. Once you have the best tool's COMPLETE input schema, call tool_invoke with its exact name and arguments:{}; the evaluator intercepts it and never executes it. Do not ask for task arguments or execute anything else. If no tool fits, say so. A compact candidate is not a complete schema.",
      },
      { role: "user", content: c.query },
    ];
    let discoveryCalls = 0,
      resultTokens = 0,
      mainModelCostUsd = 0,
      firstTool: string | null = null,
      outcome = "no_tool";
    const trace: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const started = performance.now();
    while (true) {
      const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, reasoning: { effort: "none" }, messages, tools: wireTools }),
      });
      if (!response.ok) throw new Error(`Agent model HTTP ${response.status}`);
      const result = (await response.json()) as {
        choices: Array<{
          message: {
            role: string;
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage: { cost?: number };
      };
      mainModelCostUsd += result.usage.cost ?? 0;
      const message = result.choices[0]!.message;
      messages.push(message);
      if (!message.tool_calls?.length) break;
      let stop = false;
      for (const call of message.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        trace.push({ name: call.function.name, arguments: args });
        if (
          call.function.name === "tool_invoke" ||
          !["tool_search", "tool_list"].includes(call.function.name)
        ) {
          firstTool = call.function.name === "tool_invoke" ? args.name : call.function.name;
          outcome = "first_call";
          stop = true;
          break;
        }
        const identity = JSON.stringify([call.function.name, args]);
        if (seen.has(identity)) {
          outcome = "repeated_discovery";
          stop = true;
          break;
        }
        seen.add(identity);
        discoveryCalls++;
        let output: string,
          definitions: Record<string, unknown>[] = [];
        if (call.function.name === "tool_search") {
          if (arm === "before") output = JSON.stringify({ tools: legacySearchTools(pool, args) });
          else {
            const prepared = await runtime.prepareSearch(args);
            output = prepared.output;
            definitions = prepared.tools ?? [];
          }
        } else {
          if (list.type !== "function") throw new Error("Missing tool_list");
          output = String(await list.invoke({} as never, JSON.stringify(args)));
        }
        resultTokens += encode(output).length;
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
        if (definitions.length) {
          const text = `These tools are now available. Call through tool_invoke with the exact name. Definitions:\n${JSON.stringify({ tools: definitions })}`;
          resultTokens += encode(text).length;
          messages.push({
            role: "user",
            content: `Machine-origin tool declaration, not a new human request. ${text}`,
          });
        }
      }
      if (stop) break;
    }
    const row = {
      id: c.id,
      arm,
      query: c.query,
      expected: c.expected,
      firstTool,
      correct: firstTool !== null && c.expected.includes(firstTool),
      outcome,
      discoveryCalls,
      resultTokens,
      decisionCalls,
      decisionInputTokens,
      decisionOutputTokens,
      mainModelCostUsd,
      decisionModelCostUsd: decisionReceipts.every((r) => typeof r.costUsd === "number")
        ? decisionReceipts.reduce((sum, r) => sum + r.costUsd!, 0)
        : null,
      decisionProviders: [...new Set(decisionReceipts.map((r) => r.provider).filter(Boolean))],
      ms: performance.now() - started,
      trace,
    };
    rows.push(row);
    await Bun.write(
      out,
      JSON.stringify(
        {
          metadata,
          model,
          decisionModel,
          scope:
            "Live simulated discovery only; stops before domain execution; every third frozen case",
          rows,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        id: c.id,
        arm,
        correct: row.correct,
        discoveryCalls,
        resultTokens,
        ms: row.ms,
      }),
    );
  }
console.log(
  JSON.stringify(
    Object.fromEntries(
      ["before", "after"].map((arm) => {
        const selected = rows.filter((r: { arm: string }) => r.arm === arm);
        const mean = (key: string) =>
          selected.reduce((s: number, r: Record<string, unknown>) => s + Number(r[key]), 0) /
          selected.length;
        return [
          arm,
          {
            queries: selected.length,
            correct: mean("correct"),
            discoveryCalls: mean("discoveryCalls"),
            meanResultTokens: mean("resultTokens"),
            meanMs: mean("ms"),
            meanMainModelCostUsd: mean("mainModelCostUsd"),
            meanDecisionModelCostUsd: selected.every(
              (r) => typeof r.decisionModelCostUsd === "number",
            )
              ? mean("decisionModelCostUsd")
              : null,
          },
        ];
      }),
    ),
    null,
    2,
  ),
);
