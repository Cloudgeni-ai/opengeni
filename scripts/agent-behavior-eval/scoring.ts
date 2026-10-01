import type { CheckResult, ScenarioRunResult, UsageTotals } from "./types";

/** Pure scoring/aggregation for the behavior eval (unit-tested in scoring.test.ts). */

export type ScenarioInfo = { id: string; title: string; intent: string; informational: boolean };

export type ScenarioSummary = {
  scenarioId: string;
  title: string;
  informational: boolean;
  runs: number;
  completed: number;
  skipped: number;
  errors: number;
  passes: number;
  /** Deterministic pass rate over COMPLETED runs; null when none completed. */
  passRate: number | null;
  judgeScores: number[];
  judgeMean: number | null;
  meanLatencyMs: number | null;
  meanToolCalls: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  medianSystemPromptChars: number | null;
  medianPrefixTokens: number | null;
  costUsd: number;
  toolFrequency: Record<string, number>;
  checkPassRates: Record<string, number>;
  skipReasons: string[];
  errorMessages: string[];
};

export type VariantSummary = {
  variant: string;
  scenarios: ScenarioSummary[];
  aggregate: {
    /** Non-informational scenarios with at least one completed run. */
    gatedScenarios: number;
    /** Mean of per-scenario deterministic pass rates over gated scenarios. */
    meanPassRate: number | null;
    /** Mean of per-scenario judge means over gated scenarios. */
    judgeMean: number | null;
    completedRuns: number;
    skippedRuns: number;
    errorRuns: number;
    costUsd: number;
    meanLatencyMs: number | null;
  };
};

export type GateOptions = { judgeMargin: number; maxPassRateDrop: number };
export const DEFAULT_GATE: GateOptions = { judgeMargin: 0.2, maxPassRateDrop: 1 / 3 };

export type VariantComparison = {
  baseline: string;
  candidate: string;
  pass: boolean;
  failures: string[];
  rows: Array<{
    scenarioId: string;
    informational: boolean;
    baselinePassRate: number | null;
    candidatePassRate: number | null;
    passRateDelta: number | null;
    baselineJudge: number | null;
    candidateJudge: number | null;
  }>;
};

export function deterministicPass(checks: CheckResult[]): boolean {
  const gated = checks.filter((check) => !check.informational);
  return gated.every((check) => check.pass);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeScenario(
  scenario: ScenarioInfo,
  results: ScenarioRunResult[],
): ScenarioSummary {
  const completed = results.filter((result) => result.status === "completed");
  const metrics = completed.flatMap((result) => (result.metrics ? [result.metrics] : []));
  const judgeScores = completed.flatMap((result) =>
    result.judge && "score" in result.judge ? [result.judge.score] : [],
  );
  const toolFrequency: Record<string, number> = {};
  for (const metric of metrics) {
    for (const name of metric.toolNames) toolFrequency[name] = (toolFrequency[name] ?? 0) + 1;
  }
  const checkTotals = new Map<string, { pass: number; total: number }>();
  for (const result of completed) {
    for (const check of result.checks) {
      const totals = checkTotals.get(check.id) ?? { pass: 0, total: 0 };
      totals.total += 1;
      if (check.pass) totals.pass += 1;
      checkTotals.set(check.id, totals);
    }
  }
  const passes = completed.filter((result) => result.deterministicPass).length;
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    informational: scenario.informational,
    runs: results.length,
    completed: completed.length,
    skipped: results.filter((result) => result.status === "skipped").length,
    errors: results.filter((result) => result.status === "error").length,
    passes,
    passRate: completed.length === 0 ? null : passes / completed.length,
    judgeScores,
    judgeMean: mean(judgeScores),
    meanLatencyMs: mean(metrics.map((metric) => metric.latencyMs)),
    meanToolCalls: mean(metrics.map((metric) => metric.toolCallCount)),
    meanInputTokens: mean(metrics.map((metric) => metric.usage.inputTokens)),
    meanOutputTokens: mean(metrics.map((metric) => metric.usage.outputTokens)),
    medianSystemPromptChars: median(
      metrics.flatMap((metric) =>
        metric.systemPromptChars === null ? [] : [metric.systemPromptChars],
      ),
    ),
    medianPrefixTokens: median(
      metrics.flatMap((metric) => (metric.prefixTokens === null ? [] : [metric.prefixTokens])),
    ),
    costUsd: metrics.reduce((sum, metric) => sum + (metric.costUsd ?? 0), 0),
    toolFrequency,
    checkPassRates: Object.fromEntries(
      [...checkTotals.entries()].map(([id, totals]) => [id, totals.pass / totals.total]),
    ),
    skipReasons: [
      ...new Set(results.flatMap((result) => (result.skipReason ? [result.skipReason] : []))),
    ],
    errorMessages: [...new Set(results.flatMap((result) => (result.error ? [result.error] : [])))],
  };
}

export function summarizeVariant(
  variant: string,
  scenarios: ScenarioInfo[],
  results: ScenarioRunResult[],
): VariantSummary {
  const summaries = scenarios
    .map((scenario) =>
      summarizeScenario(
        scenario,
        results.filter((result) => result.variant === variant && result.scenarioId === scenario.id),
      ),
    )
    .filter((summary) => summary.runs > 0);
  const gated = summaries.filter((summary) => !summary.informational && summary.passRate !== null);
  const variantResults = results.filter((result) => result.variant === variant);
  const latencies = variantResults.flatMap((result) =>
    result.status === "completed" && result.metrics ? [result.metrics.latencyMs] : [],
  );
  return {
    variant,
    scenarios: summaries,
    aggregate: {
      gatedScenarios: gated.length,
      meanPassRate: mean(gated.map((summary) => summary.passRate!)),
      judgeMean: mean(
        gated.flatMap((summary) => (summary.judgeMean === null ? [] : [summary.judgeMean])),
      ),
      completedRuns: variantResults.filter((result) => result.status === "completed").length,
      skippedRuns: variantResults.filter((result) => result.status === "skipped").length,
      errorRuns: variantResults.filter((result) => result.status === "error").length,
      costUsd: summaries.reduce((sum, summary) => sum + summary.costUsd, 0),
      meanLatencyMs: mean(latencies),
    },
  };
}

/**
 * Release evaluation gate: the candidate's judge mean must be at
 * least baseline − judgeMargin, and no gated scenario's deterministic pass rate
 * may drop by more than maxPassRateDrop. Scenarios that did not complete in
 * both variants are reported but not gated.
 */
export function compareVariants(
  baseline: VariantSummary,
  candidate: VariantSummary,
  options: GateOptions = DEFAULT_GATE,
): VariantComparison {
  const failures: string[] = [];
  const epsilon = 1e-9;
  const baselineJudge = baseline.aggregate.judgeMean;
  const candidateJudge = candidate.aggregate.judgeMean;
  if (
    baselineJudge !== null &&
    candidateJudge !== null &&
    candidateJudge + epsilon < baselineJudge - options.judgeMargin
  ) {
    failures.push(
      `judge mean ${candidateJudge.toFixed(2)} < baseline ${baselineJudge.toFixed(2)} − ${options.judgeMargin}`,
    );
  }
  const ids = [
    ...new Set([...baseline.scenarios, ...candidate.scenarios].map((s) => s.scenarioId)),
  ];
  const rows = ids.map((scenarioId) => {
    const before = baseline.scenarios.find((summary) => summary.scenarioId === scenarioId);
    const after = candidate.scenarios.find((summary) => summary.scenarioId === scenarioId);
    const informational = (before ?? after)!.informational;
    const baselinePassRate = before?.passRate ?? null;
    const candidatePassRate = after?.passRate ?? null;
    const passRateDelta =
      baselinePassRate === null || candidatePassRate === null
        ? null
        : candidatePassRate - baselinePassRate;
    if (
      !informational &&
      passRateDelta !== null &&
      -passRateDelta > options.maxPassRateDrop + epsilon
    ) {
      failures.push(
        `${scenarioId}: pass rate ${formatRate(candidatePassRate)} dropped more than ${formatRate(options.maxPassRateDrop)} from ${formatRate(baselinePassRate)}`,
      );
    }
    return {
      scenarioId,
      informational,
      baselinePassRate,
      candidatePassRate,
      passRateDelta,
      baselineJudge: before?.judgeMean ?? null,
      candidateJudge: after?.judgeMean ?? null,
    };
  });
  return {
    baseline: baseline.variant,
    candidate: candidate.variant,
    pass: failures.length === 0,
    failures,
    rows,
  };
}

export type ModelPrice = {
  inputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number | undefined;
  cacheWriteMicrosPerMillionTokens?: number | undefined;
  outputMicrosPerMillionTokens: number;
};

/** Approximate provider cost (USD, list price, no margin) for summed usage. */
export function estimateCostUsd(usage: UsageTotals, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheWriteTokens, usage.inputTokens - cached);
  const uncached = Math.max(0, usage.inputTokens - cached - cacheWrite);
  const micros =
    (uncached * price.inputMicrosPerMillionTokens +
      cached * (price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) +
      cacheWrite * (price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens) +
      usage.outputTokens * price.outputMicrosPerMillionTokens) /
    1_000_000;
  return micros / 1_000_000;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatNumber(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toFixed(digits);
}

function escapeCell(text: string): string {
  return text.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export type MarkdownInput = {
  title: string;
  meta: Record<string, string>;
  scenarios: ScenarioInfo[];
  variants: VariantSummary[];
  comparisons: VariantComparison[];
  results: ScenarioRunResult[];
};

export function renderMarkdown(input: MarkdownInput): string {
  const lines: string[] = [`# ${input.title}`, ""];
  for (const [key, value] of Object.entries(input.meta)) lines.push(`- **${key}:** ${value}`);
  lines.push("");
  for (const variant of input.variants) {
    const aggregate = variant.aggregate;
    lines.push(`## Variant \`${variant.variant}\``, "");
    lines.push(
      `Gated scenarios: ${aggregate.gatedScenarios} · mean deterministic pass rate: ${formatRate(aggregate.meanPassRate)} · judge mean: ${formatNumber(aggregate.judgeMean, 2)} · runs completed/skipped/error: ${aggregate.completedRuns}/${aggregate.skippedRuns}/${aggregate.errorRuns} · mean latency: ${formatNumber(aggregate.meanLatencyMs === null ? null : aggregate.meanLatencyMs / 1000, 1)} s · approx. agent cost: $${aggregate.costUsd.toFixed(4)}`,
      "",
    );
    lines.push(
      "| Scenario | Pass rate | Judge | Runs (ok/skip/err) | Latency s | Tool calls | In tok | Out tok | Sys prompt chars | Prefix tok | Tools called |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const summary of variant.scenarios) {
      const tools = Object.entries(summary.toolFrequency)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}×${count}`)
        .join(", ");
      lines.push(
        `| ${summary.scenarioId}${summary.informational ? " (info)" : ""} | ${formatRate(summary.passRate)} | ${formatNumber(summary.judgeMean, 2)} | ${summary.completed}/${summary.skipped}/${summary.errors} | ${formatNumber(summary.meanLatencyMs === null ? null : summary.meanLatencyMs / 1000, 1)} | ${formatNumber(summary.meanToolCalls, 1)} | ${formatNumber(summary.meanInputTokens)} | ${formatNumber(summary.meanOutputTokens)} | ${formatNumber(summary.medianSystemPromptChars)} | ${formatNumber(summary.medianPrefixTokens)} | ${escapeCell(tools || "—")} |`,
      );
    }
    lines.push("");
    const notes = variant.scenarios.filter(
      (summary) => summary.skipReasons.length > 0 || summary.errorMessages.length > 0,
    );
    if (notes.length > 0) {
      lines.push("Skips and errors:", "");
      for (const summary of notes) {
        for (const reason of summary.skipReasons)
          lines.push(`- ${summary.scenarioId}: skipped — ${reason}`);
        for (const error of summary.errorMessages)
          lines.push(`- ${summary.scenarioId}: error — ${escapeCell(error.slice(0, 300))}`);
      }
      lines.push("");
    }
    lines.push("Per-check pass rates:", "");
    for (const summary of variant.scenarios) {
      const checks = Object.entries(summary.checkPassRates)
        .map(([id, rate]) => `${id} ${formatRate(rate)}`)
        .join(", ");
      if (checks) lines.push(`- ${summary.scenarioId}: ${checks}`);
    }
    lines.push("");
  }
  for (const comparison of input.comparisons) {
    lines.push(
      `## Gate: \`${comparison.candidate}\` vs \`${comparison.baseline}\` — ${comparison.pass ? "PASS" : "FAIL"}`,
      "",
    );
    for (const failure of comparison.failures) lines.push(`- ${failure}`);
    if (comparison.failures.length > 0) lines.push("");
    lines.push(
      "| Scenario | Baseline pass | Candidate pass | Δ | Baseline judge | Candidate judge |",
      "|---|---|---|---|---|---|",
    );
    for (const row of comparison.rows) {
      lines.push(
        `| ${row.scenarioId}${row.informational ? " (info)" : ""} | ${formatRate(row.baselinePassRate)} | ${formatRate(row.candidatePassRate)} | ${row.passRateDelta === null ? "—" : `${row.passRateDelta >= 0 ? "+" : ""}${Math.round(row.passRateDelta * 100)} pp`} | ${formatNumber(row.baselineJudge, 2)} | ${formatNumber(row.candidateJudge, 2)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Runs", "");
  lines.push(
    "| Scenario | Variant | # | Status | Pass | Judge | Failed checks | Final answer (start) |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const result of input.results) {
    const failed = result.checks
      .filter((check) => !check.pass && !check.informational)
      .map((check) => check.id)
      .join(", ");
    const judge = result.judge
      ? "score" in result.judge
        ? String(result.judge.score)
        : "err"
      : "—";
    const answer =
      result.transcript?.sessions.at(-1)?.turnOutputs.at(-1) ??
      result.skipReason ??
      result.error ??
      "";
    lines.push(
      `| ${result.scenarioId} | ${result.variant} | ${result.repeat} | ${result.status} | ${result.status === "completed" ? (result.deterministicPass ? "yes" : "no") : "—"} | ${judge} | ${escapeCell(failed || "—")} | ${escapeCell(answer.slice(0, 140))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
