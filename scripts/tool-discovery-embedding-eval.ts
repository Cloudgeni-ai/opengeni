#!/usr/bin/env bun
/** Optional offline embedding comparison; not a production dependency. See eval README. */
import type { Tool } from "@openai/agents";
import { LazyToolRuntime } from "../packages/runtime/src/lazy-tool-transport";
import { ToolSearchIndex } from "../packages/runtime/src/tool-discovery-ranking";
function option(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const modulePath = process.env.TOOL_DISCOVERY_EMBEDDING_MODULE;
if (!modulePath)
  throw new Error(
    "Set TOOL_DISCOVERY_EMBEDDING_MODULE to the pinned Transformers.js module; not installed by the application",
  );
const catalog = option("catalog"),
  queries = option("queries"),
  out = option("out"),
  cache = option("cache");
if (!catalog || !queries || !out || !cache)
  throw new Error("Required: --catalog --queries --out --cache");
const { env, pipeline } = await import(modulePath);
env.cacheDir = cache;
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
const runtime = new LazyToolRuntime(
  "generic_dispatch",
  new Set(mapping.values()),
  undefined,
  new Set(mapping.values()),
  new Set(),
  () => mapping,
);
runtime.refresh(tools);
const pool = runtime.inspectSearchableTools();
const index = new ToolSearchIndex(pool.map((t) => ({ ...t, type: "function" }) as Tool));
const cases = (await Bun.file(queries).json()) as Array<{
  id: string;
  query: string;
  expected: string[];
}>;
const start = performance.now();
const model = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
const vectors: number[][] = [];
for (const t of pool) {
  const output = await model(
    `${t.name.replace(/^mcp_[a-f0-9]+__/, "").replace(/_/g, " ")}: ${t.description}`,
    { pooling: "cls", normalize: true },
  );
  vectors.push([...output.data]);
}
const indexMs = performance.now() - start;
const rows = [];
for (const c of cases) {
  const started = performance.now();
  const query = await model(`Represent this sentence for searching relevant passages: ${c.query}`, {
    pooling: "cls",
    normalize: true,
  });
  const dense = vectors
    .map((v, i) => ({
      name: pool[i]!.name,
      score: v.reduce((s, x, j) => s + x * query.data[j], 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => t.name);
  const lexical = index.rank(c.query, pool.length).map((t) => (t as Tool & { name: string }).name);
  const hybrid = pool
    .map((t) => ({
      name: t.name,
      score:
        (lexical.includes(t.name) ? 1 / (10 + lexical.indexOf(t.name) + 1) : 0) +
        1 / (10 + dense.indexOf(t.name) + 1),
    }))
    .sort((a, b) => b.score - a.score)
    .map((t) => t.name);
  const metrics = (names: string[]) => ({
    top1: c.expected.includes(names[0] ?? ""),
    top3: names.slice(0, 3).some((n) => c.expected.includes(n)),
    names,
  });
  rows.push({
    id: c.id,
    query: c.query,
    expected: c.expected,
    dense: metrics(dense),
    hybrid: metrics(hybrid),
    ms: performance.now() - started,
  });
}
const summary = Object.fromEntries(
  (["dense", "hybrid"] as const).map((arm) => [
    arm,
    {
      top1: rows.filter((r) => r[arm].top1).length / rows.length,
      top3: rows.filter((r) => r[arm].top3).length / rows.length,
    },
  ]),
);
await Bun.write(
  out,
  JSON.stringify(
    {
      model: "Xenova/bge-small-en-v1.5",
      dtype: "q8",
      rrfK: 10,
      deferredTools: pool.length,
      indexMs,
      meanQueryMs: rows.reduce((s, r) => s + r.ms, 0) / rows.length,
      summary,
      rows,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    indexMs,
    summary,
    meanQueryMs: rows.reduce((s, r) => s + r.ms, 0) / rows.length,
  }),
);
