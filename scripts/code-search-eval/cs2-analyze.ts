#!/usr/bin/env bun
/**
 * Paired analysis of the code_grep experiment arms (agent-run.ts outputs). Per arm: localization
 * quality with repository-clustered bootstrap CIs, frontier tokens, sequential model calls, wall
 * time, judge tokens and cost, and tool adoption; then paired differences against the baseline arm on
 * the tasks every compared arm completed cleanly.
 *
 *   bun cs2-analyze.ts --contextbench full.jsonl --baseline a --arm a=out/a --arm d=out/d \
 *     [--judge-usage judge.jsonl] [--exclude ids.txt]
 *
 * judge.jsonl holds one {session, tokens, costUsd, requests} line per session (from usage events).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { contextBenchTask, readJsonl, type ContextBenchRow } from "./harness/datasets";
import { clusterBootstrap, pairedDifference, percentile, type Interval } from "./harness/metrics";
import { scoreRuns, type ScoredRun } from "./harness/report";
import type { ArmRun } from "./harness/types";

const { values } = parseArgs({
  options: {
    contextbench: { type: "string" },
    baseline: { type: "string", default: "a" },
    arm: { type: "string", multiple: true },
    "judge-usage": { type: "string" },
    exclude: { type: "string" },
  },
});

type Attempt = {
  taskId: string;
  session?: string;
  status?: string;
  error?: string;
  calls?: { explore: number; total: number };
  codeGrep?: { calls: number; patterns: number; outputChars: number; judgeFailed: number; stoppedEarly: number; errors: number };
  purposes?: Record<string, number>;
};

const lines = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T)
    : [];

const tasks = (await readJsonl<ContextBenchRow>(values.contextbench!)).map(contextBenchTask);
const judge = new Map(
  (values["judge-usage"] ? lines<{ session: string; tokens: number; costUsd: number | null; requests: number }>(values["judge-usage"]) : []).map((j) => [j.session, j]),
);
const excluded = new Set(
  values.exclude ? readFileSync(values.exclude, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [],
);

type Row = ScoredRun & { attempt: Attempt; dirty: string | null };
const arms = new Map<string, Row[]>();
for (const spec of values.arm ?? []) {
  const [label, dir] = spec.split("=") as [string, string];
  // The last record per task wins (a clean rerun replaces an earlier dirty attempt).
  const runs = new Map<string, ArmRun>();
  for (const r of lines<ArmRun>(join(dir, "runs.jsonl"))) if (!r.arm.endsWith("-viewed")) runs.set(r.taskId, r);
  const attempts = new Map<string, Attempt>();
  for (const a of lines<Attempt>(join(dir, "attempts.jsonl"))) attempts.set(a.taskId, a);
  const scored = scoreRuns(tasks, [...runs.values()].map((r) => ({ ...r, arm: label })));
  arms.set(
    label,
    scored.map((s) => {
      const attempt = attempts.get(s.taskId) ?? { taskId: s.taskId };
      const dirty =
        s.error ? `error: ${s.error}` :
        attempt.codeGrep?.judgeFailed ? "judge failed" :
        attempt.codeGrep?.errors ? "tool error" :
        excluded.has(s.taskId) ? "excluded" : null;
      return { ...s, attempt, dirty };
    }),
  );
}

const pct = (i: Interval) => `${(100 * i.mean).toFixed(1)} [${(100 * i.low).toFixed(1)}, ${(100 * i.high).toFixed(1)}]`;
const num = (i: Interval, d = 0) => `${i.mean.toFixed(d)} [${i.low.toFixed(d)}, ${i.high.toFixed(d)}]`;
const ci = (rows: Row[], f: (r: Row) => number) => clusterBootstrap(rows.map((r) => ({ cluster: r.repo, value: f(r) })));

const uncached = (r: Row) => r.usage.inputTokens - r.usage.cachedInputTokens;
const mainCalls = (r: Row) => r.attempt.purposes?.main ?? r.usage.modelCalls;
const judgeTokens = (r: Row) => (r.attempt.session ? (judge.get(r.attempt.session)?.tokens ?? 0) : 0);
const judgeCost = (r: Row) => (r.attempt.session ? (judge.get(r.attempt.session)?.costUsd ?? 0) : 0);
const shellExplore = (r: Row) => Math.max(0, (r.attempt.calls?.explore ?? 0) - (r.attempt.codeGrep?.calls ?? 0));

// Paired set: tasks clean in every arm.
const labels = [...arms.keys()];
const clean = new Set(
  tasks.map((t) => t.id).filter((id) => labels.every((l) => arms.get(l)!.some((r) => r.taskId === id && !r.dirty))),
);
const out: string[] = ["# code_grep experiment", ""];
out.push(`Paired clean tasks: ${clean.size}`, "");
out.push("| Arm | n run | dirty | File recall | Line recall | Line precision | Uncached in | Cached in | Output | Main calls | Wall p50 s | Wall p95 s | Judge tok/task | Judge $/task | code_grep calls/task | Shell searches/task | Adoption |");
out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [label, rows] of arms) {
  const p = rows.filter((r) => clean.has(r.taskId));
  const grepCalls = p.reduce((s, r) => s + (r.attempt.codeGrep?.calls ?? 0), 0);
  const shell = p.reduce((s, r) => s + shellExplore(r), 0);
  const wall = p.map((r) => r.latencyMs / 1000);
  out.push(
    `| ${label} | ${rows.length} | ${rows.filter((r) => r.dirty).length} | ${pct(ci(p, (r) => r.score.fileRecall))} | ${pct(ci(p, (r) => r.score.lineRecall))} | ${pct(ci(p, (r) => r.score.linePrecision))} | ${num(ci(p, uncached))} | ${num(ci(p, (r) => r.usage.cachedInputTokens))} | ${num(ci(p, (r) => r.usage.outputTokens))} | ${num(ci(p, mainCalls), 1)} | ${percentile(wall, 0.5).toFixed(0)} | ${percentile(wall, 0.95).toFixed(0)} | ${num(ci(p, judgeTokens))} | ${ci(p, judgeCost).mean.toFixed(5)} | ${(grepCalls / (p.length || 1)).toFixed(2)} | ${(shell / (p.length || 1)).toFixed(2)} | ${grepCalls + shell ? ((100 * grepCalls) / (grepCalls + shell)).toFixed(0) : "-"}% |`,
  );
}
const base = values.baseline!;
if (arms.has(base)) {
  out.push("", `## Paired differences against ${base} (arm minus ${base}), repository-clustered 95% CIs`, "");
  out.push("| Arm | File recall pp | Line recall pp | Uncached input tok | Cached input tok | Output tok | Main calls | Wall s |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const keyed = (label: string, f: (r: Row) => number) =>
    new Map(arms.get(label)!.filter((r) => clean.has(r.taskId)).map((r) => [r.taskId, { cluster: r.repo, value: f(r) }]));
  for (const label of labels.filter((l) => l !== base)) {
    const d = (f: (r: Row) => number) => pairedDifference(keyed(base, f), keyed(label, f));
    out.push(
      `| ${label} | ${pct(d((r) => r.score.fileRecall))} | ${pct(d((r) => r.score.lineRecall))} | ${num(d(uncached))} | ${num(d((r) => r.usage.cachedInputTokens))} | ${num(d((r) => r.usage.outputTokens))} | ${num(d(mainCalls), 2)} | ${num(d((r) => r.latencyMs / 1000), 1)} |`,
    );
  }
}
for (const [label, rows] of arms) {
  const dirty = rows.filter((r) => r.dirty);
  if (dirty.length) out.push("", `Dirty in ${label}: ${dirty.map((r) => `${r.taskId} (${r.dirty})`).join("; ")}`);
}
console.log(out.join("\n"));
