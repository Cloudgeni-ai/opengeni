import {
  clusterBootstrap,
  pairedDifference,
  percentile,
  scoreTask,
  type Interval,
  type TaskScore,
} from "./metrics";
import type { ArmRun, Task } from "./types";

export type ScoredRun = ArmRun & {
  score: TaskScore;
  repo: string;
  language: string;
};

export function scoreRuns(tasks: Task[], runs: ArmRun[]): ScoredRun[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return runs.flatMap((run) => {
    const task = byId.get(run.taskId);
    // A failed run scores as an empty prediction, so errors count against the arm.
    return task
      ? [
          {
            ...run,
            score: scoreTask(task, run.prediction),
            repo: task.repo,
            language: task.language,
          },
        ]
      : [];
  });
}

const pct = (i: Interval) =>
  `${(100 * i.mean).toFixed(1)} [${(100 * i.low).toFixed(1)}, ${(100 * i.high).toFixed(1)}]`;

type Metric = (s: ScoredRun) => number;
const METRICS: [string, Metric][] = [
  ["Acc@5", (s) => s.score.allAt[5] ?? 0],
  ["File recall", (s) => s.score.fileRecall],
  ["File precision", (s) => s.score.filePrecision],
  ["Recall@5", (s) => s.score.recallAt[5] ?? 0],
  ["MRR", (s) => s.score.mrr],
  ["Line recall", (s) => s.score.lineRecall],
  ["Line precision", (s) => s.score.linePrecision],
];

export function renderReport(scored: ScoredRun[], baseline?: string): string {
  const arms = [...new Set(scored.map((s) => s.arm))];
  const lines = [
    "# Code search evaluation",
    "",
    "Means with repository-clustered bootstrap 95% intervals.",
    "",
  ];
  lines.push(
    `| Arm | n | ${METRICS.map(([m]) => m).join(" | ")} | p50 s | p95 s | Cash $/task | API-eq $/task | Errors |`,
  );
  lines.push(
    `| --- | --- | ${METRICS.map(() => "---").join(" | ")} | --- | --- | --- | --- | --- |`,
  );
  for (const arm of arms) {
    const rows = scored.filter((s) => s.arm === arm);
    const ci = (f: Metric) =>
      pct(
        clusterBootstrap(rows.map((s) => ({ cluster: s.repo, value: f(s) }))),
      );
    const latency = rows.map((r) => r.latencyMs / 1000);
    const mean = (f: (s: ScoredRun) => number) =>
      rows.reduce((t, s) => t + f(s), 0) / (rows.length || 1);
    lines.push(
      `| ${arm} | ${rows.length} | ${METRICS.map(([, f]) => ci(f)).join(" | ")} | ${percentile(latency, 0.5).toFixed(1)} | ${percentile(latency, 0.95).toFixed(1)} | ${mean((s) => s.usage.cashUsd).toFixed(4)} | ${mean((s) => s.usage.apiEquivalentUsd).toFixed(4)} | ${rows.filter((r) => r.error).length} |`,
    );
  }
  if (baseline && arms.includes(baseline)) {
    lines.push(
      "",
      `## Paired differences against ${baseline} (percentage points)`,
      "",
      "| Arm | File recall | Line recall | Line precision |",
      "| --- | --- | --- | --- |",
    );
    const keyed = (arm: string, f: Metric) =>
      new Map(
        scored
          .filter((s) => s.arm === arm)
          .map((s) => [s.taskId, { cluster: s.repo, value: f(s) }]),
      );
    for (const arm of arms.filter((a) => a !== baseline)) {
      const cells = [METRICS[1]![1], METRICS[5]![1], METRICS[6]![1]].map((f) =>
        pct(pairedDifference(keyed(baseline, f), keyed(arm, f))),
      );
      lines.push(`| ${arm} | ${cells.join(" | ")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Keep only files scored at or above the cut (spans of dropped files go too); best-scored file kept if none pass. */
export function thresholdVariant(
  runs: ArmRun[],
  arm: string,
  cut: number,
): ArmRun[] {
  return runs
    .filter((r) => r.arm === arm && r.prediction.fileScores)
    .map((r) => {
      const scores = r.prediction.fileScores!;
      let files = r.prediction.files.filter((f) => (scores[f] ?? 0) >= cut);
      if (!files.length) files = r.prediction.files.slice(0, 1);
      const keep = new Set(files);
      return {
        ...r,
        arm: `${arm}@${cut}`,
        prediction: {
          files,
          spans: r.prediction.spans.filter((s) => keep.has(s.file)),
        },
      };
    });
}

/** The cut with the best mean file F1 on the given (dev) tasks. */
export function calibrateCut(
  tasks: Task[],
  runs: ArmRun[],
  arm: string,
  cuts = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
): number {
  let best = { cut: cuts[0]!, f1: -1 };
  for (const cut of cuts) {
    const scored = scoreRuns(tasks, thresholdVariant(runs, arm, cut));
    const f1 =
      scored.reduce((t, s) => t + s.score.fileF1, 0) / (scored.length || 1);
    if (f1 > best.f1) best = { cut, f1 };
  }
  return best.cut;
}
