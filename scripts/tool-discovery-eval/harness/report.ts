import { scoreSearch, summarize, wilson, RECALL_DEPTHS, type Summary } from "./metrics";
import type { Catalog, SearchRecord } from "./types";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
/** A share with its 95% confidence interval, e.g. "96.0% (93–98)". */
const share = (value: number, count: number) => {
  const [low, high] = wilson(value, count);
  return `${percent(value)} (${Math.round(low * 100)}–${Math.round(high * 100)})`;
};
const ms = (value: number) => `${Math.round(value)} ms`;
const usd = (value: number) => (value === 0 ? "$0" : `$${value.toFixed(5)}`);
const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function readable(catalog: Catalog, toolName: string) {
  const tool = catalog.tools.find((t) => t.name === toolName);
  return tool?.published ?? toolName.replace(/^mcp_[0-9a-f]+__/, "");
}

function summaryTable(rows: [string, Summary][]) {
  const lines = [
    "| Strategy | Searches | First pick right | Right tool loaded | Right tool loaded or shown | Wrong tools loaded per search | Tokens to agent, mean / p95 | Latency, mean / p95 / p99 | Cost per search | Fallbacks |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, s] of rows)
    lines.push(
      `| ${cell(name)} | ${s.searches}${s.errors ? ` (${s.errors} errors)` : ""} | ${share(s.firstPick, s.scored)} | ${percent(s.loadedRight)} | ${share(s.visible, s.scored)} | ${s.offLabelLoaded.toFixed(2)} | ${Math.round(s.meanAgentTokens)} / ${s.p95AgentTokens} | ${ms(s.meanLatencyMs)} / ${ms(s.p95LatencyMs)} / ${ms(s.p99LatencyMs)} | ${usd(s.meanCostUsd)} | ${s.fallbacks} |`,
    );
  return lines.join("\n");
}

function recallTable(rows: [string, Summary][]) {
  const withRecall = rows.filter(([, s]) => s.recallAt);
  if (!withRecall.length) return "";
  return [
    "",
    "### First stage: right tool within the top K candidates",
    "",
    `| Strategy | ${RECALL_DEPTHS.map((k) => `K=${k}`).join(" | ")} |`,
    `| --- | ${RECALL_DEPTHS.map(() => "---:").join(" | ")} |`,
    ...withRecall.map(
      ([name, s]) =>
        `| ${cell(name)} | ${RECALL_DEPTHS.map((k) => percent(s.recallAt![k]!)).join(" | ")} |`,
    ),
  ].join("\n");
}

export function markdownReport(
  catalog: Catalog,
  records: readonly SearchRecord[],
  strategies: readonly { name: string; description: string }[],
  meta: Record<string, unknown>,
) {
  const byStrategy = strategies.map(
    (s) => [s.name, summarize(records.filter((r) => r.strategy === s.name))] as [string, Summary],
  );
  // Slices worth a table: tags on at least five searches, at most 40 of them.
  const tagCounts = new Map<string, number>();
  for (const record of records.filter((r) => r.strategy === strategies[0]?.name))
    for (const tag of record.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const tags = [...tagCounts]
    .filter(([, count]) => count >= 5)
    .map(([tag]) => tag)
    .sort()
    .slice(0, 40);
  const out: string[] = [
    "# Tool search evaluation",
    "",
    ...Object.entries(meta).map(
      ([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    ),
    "",
    "## Results",
    "",
    summaryTable(byStrategy),
    recallTable(byStrategy),
    "",
    "What the columns mean: **first pick right**, the first tool the agent receives is an acceptable one; **loaded or shown**, the agent receives or sees by name an acceptable tool, so it needs at most one more call; **wrong tools loaded**, schemas the agent receives that are not acceptable.",
  ];
  for (const tag of tags) {
    out.push(
      "",
      `### Only scenarios tagged ${tag}`,
      "",
      summaryTable(
        strategies.map(
          (s) =>
            [
              s.name,
              summarize(records.filter((r) => r.strategy === s.name && r.tags.includes(tag))),
            ] as [string, Summary],
        ),
      ),
    );
  }
  out.push("", "## Strategies", "", ...strategies.map((s) => `- **${s.name}**: ${s.description}`));
  out.push("", "## Searches that went wrong", "");
  for (const strategy of strategies) {
    const misses = records.filter((r) => {
      if (r.strategy !== strategy.name) return false;
      const score = scoreSearch(r);
      return !score || !score.firstPick;
    });
    out.push(
      `### ${strategy.name}: ${misses.length} of ${records.filter((r) => r.strategy === strategy.name).length}`,
      "",
    );
    for (const r of misses.slice(0, 60)) {
      const score = scoreSearch(r);
      const loaded = r.trace?.loaded.map((n) => readable(catalog, n)).join(", ") || "nothing";
      const shown = r.trace?.shown.map((n) => readable(catalog, n)).join(", ") || "nothing";
      const top = r.trace?.stages
        .find((stage) => stage.name === "candidates")
        ?.candidates?.slice(0, 8)
        .map((c) => readable(catalog, c.name))
        .join(", ");
      out.push(
        `- **${r.scenario}**: "${clip(r.query, 220)}"`,
        `  - Acceptable: ${r.acceptable.map((n) => readable(catalog, n)).join(", ")}`,
        r.error
          ? `  - Error: ${clip(r.error, 300)}`
          : `  - Loaded: ${loaded}. Shown: ${shown}.${score?.visible ? " (Right tool visible.)" : " (Right tool not visible.)"}`,
        ...(top
          ? [
              `  - First-stage top 8: ${top}. Right tool's rank: ${score?.candidateRank ?? "not ranked"}.`,
            ]
          : []),
        ...(r.trace?.fallback ? [`  - Fallback: ${r.trace.fallback}`] : []),
      );
    }
    if (misses.length > 60) out.push(`- …and ${misses.length - 60} more in results.json.`);
    out.push("");
  }
  return out.join("\n");
}
