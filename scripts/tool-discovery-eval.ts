#!/usr/bin/env bun
/**
 * Offline retrieval + disclosure eval over a real catalog, never replicated padding.
 * bun scripts/tool-discovery-eval.ts --catalog catalog.json [--queries queries.json]
 * Accepts an array or {tools:[...]}, with parameters/inputSchema. No tools execute.
 * Raw catalogs/history can contain private data: keep them out of version control.
 */
import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { LazyToolRuntime } from "../packages/runtime/src/lazy-tool-transport";
import { legacySearchTools } from "./tool-discovery-eval/legacy-ranking";

export type QueryCase = {
  id: string;
  source: string;
  query: string;
  expected: string[];
  multiIntent?: boolean;
};
type CatalogTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  identity?: { serverId?: string };
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const catalogPath = option("catalog");
if (!catalogPath) throw new Error("Usage: --catalog catalog.json [--queries queries.json]");
const catalogText = await Bun.file(catalogPath).text();
const parsed = JSON.parse(catalogText) as CatalogTool[] | { tools: CatalogTool[] };
const entries = Array.isArray(parsed) ? parsed : parsed.tools;
const catalogTools = entries.map(
  (t) =>
    ({
      type: "function",
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? t.inputSchema ?? { type: "object", properties: {} },
      strict: false,
    }) as Tool,
);
if (new Set(entries.map((t) => t.name)).size !== catalogTools.length)
  throw new Error("Duplicate catalog identities");
const cases = (await Bun.file(
  option("queries") ?? new URL("./fixtures/tool-discovery-queries.json", import.meta.url),
).json()) as QueryCase[];
const serverIds = new Map(
  entries.flatMap((entry) =>
    entry.identity?.serverId ? [[entry.name, entry.identity.serverId] as const] : [],
  ),
);
const servers = new Set(serverIds.values());
const runtime = new LazyToolRuntime(
  "generic_dispatch",
  servers,
  undefined,
  servers,
  new Set(),
  () => serverIds,
);
runtime.refresh(catalogTools);
const searchable = new Set(runtime.inspectSearchableTools().map((tool) => tool.name));
const tools = catalogTools.filter((tool) => searchable.has((tool as Tool & { name: string }).name));
const name = (t: Tool) => (t as Tool & { name: string }).name;
// Deterministic BPE counts, not API-billed usage or model-specific wrapper tokens.
const tokens = (s: string) => encode(s).length;
const fullOutput = (ts: Tool[]) => JSON.stringify({ tools: ts });
const percentile = (xs: number[], fraction: number) =>
  [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * fraction) - 1)] ?? 0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rows = cases.map((c) => {
  const missing = c.expected.filter((n) => !searchable.has(n));
  if (missing.length) return { id: c.id, source: c.source, missing };
  const before = legacySearchTools(tools, { query: c.query });
  const started = performance.now();
  const after = runtime.matches({ query: c.query });
  const searchMs = performance.now() - started;
  const metrics = (hits: Tool[], output: string) => {
    const names = hits.map(name);
    return {
      top1: c.expected.includes(names[0] ?? ""),
      top3: names.slice(0, 3).some((n) => c.expected.includes(n)),
      recall3: c.expected.filter((n) => names.slice(0, 3).includes(n)).length / c.expected.length,
      resultTokens: tokens(output),
      wronglyIncluded: names.filter((n) => !c.expected.includes(n)).length,
      top: names.slice(0, 3),
    };
  };
  return {
    id: c.id,
    source: c.source,
    query: c.query,
    expected: c.expected,
    multiIntent: c.multiIntent ?? false,
    before: metrics(before, fullOutput(before)),
    after: metrics(after, runtime.genericSearchOutput({ query: c.query })),
    searchMs,
  };
});
const measured = rows.filter((r) => "before" in r && r.before && r.after);
const list = runtime.controlTools.find((t) => t.type === "function" && t.name === "tool_list");
if (!list || list.type !== "function") throw new Error("Missing directory tool");
const directoryPages: number[] = [];
let cursor: string | null = null;
let groupCount = 0;
do {
  const output = String(
    await list.invoke(
      {} as never,
      JSON.stringify({
        view: "groups",
        ...(cursor ? { cursor } : {}),
      }),
    ),
  );
  const page = JSON.parse(output);
  if (page.error) throw new Error(`Directory error: ${page.error}`);
  directoryPages.push(tokens(output));
  groupCount = page.total;
  cursor = page.nextCursor;
} while (cursor);
const summary = (source?: string) => {
  const selected = measured.filter((r) => !source || r.source === source);
  return Object.fromEntries(
    (["before", "after"] as const).map((arm) => {
      const ms = selected.map((r) => r[arm]!);
      return [
        arm,
        {
          queries: ms.length,
          top1: mean(ms.map((m) => Number(m.top1))),
          top3: mean(ms.map((m) => Number(m.top3))),
          recall3: mean(ms.map((m) => m.recall3)),
          meanWronglyIncluded: mean(ms.map((m) => m.wronglyIncluded)),
          meanResultTokens: mean(ms.map((m) => m.resultTokens)),
          p95ResultTokens: percentile(
            ms.map((m) => m.resultTokens),
            0.95,
          ),
        },
      ];
    }),
  );
};
console.log(
  JSON.stringify(
    {
      baselineRevision: "cbb55f394",
      catalogSha256: createHash("sha256").update(catalogText).digest("hex"),
      catalogTools: catalogTools.length,
      deferredTools: tools.length,
      directory: {
        groups: groupCount,
        pages: directoryPages.length,
        firstPageTokens: directoryPages[0],
        totalTokens: directoryPages.reduce((sum, count) => sum + count, 0),
      },
      tokenMethod: "o200k_base BPE of compact JSON; excludes provider wrappers, not billed usage",
      scope:
        "Retrieval-only: discovery-call counts require paired agent trajectories, not inferred from rank",
      summary: summary(),
      bySource: { history: summary("history"), synthetic: summary("synthetic") },
      p95SearchMs: percentile(
        measured.map((r) => r.searchMs!),
        0.95,
      ),
      skipped: rows.filter((r) => "missing" in r),
      rows: measured,
    },
    null,
    2,
  ),
);
