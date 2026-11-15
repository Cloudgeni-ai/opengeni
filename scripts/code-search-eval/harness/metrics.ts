import { mergeSpans } from "./datasets";
import type { Prediction, Span, Task } from "./types";

export type TaskScore = {
  fileRecall: number;
  filePrecision: number;
  fileF1: number;
  lineRecall: number;
  linePrecision: number;
  lineF1: number;
  /** Reciprocal rank of the first oracle file in the ranked list, 0 when absent. */
  mrr: number;
  recallAt: Record<number, number>;
  /** Lines of predicted context, the cost side of line precision. */
  predictedLines: number;
};

const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const lineCount = (spans: Span[]) =>
  spans.reduce((n, s) => n + s.end - s.start + 1, 0);

/** Lines shared by two merged span sets. */
export function overlapLines(a: Span[], b: Span[]): number {
  let total = 0;
  for (const x of a)
    for (const y of b)
      if (x.file === y.file)
        total += Math.max(
          0,
          Math.min(x.end, y.end) - Math.max(x.start, y.start) + 1,
        );
  return total;
}

export function scoreTask(
  task: Task,
  prediction: Prediction,
  ks = [1, 3, 5, 10],
): TaskScore {
  const oracleFiles = new Set(task.oracle.files);
  const ranked = [...new Set(prediction.files)];
  const hits = ranked.filter((f) => oracleFiles.has(f)).length;
  const fileRecall = oracleFiles.size ? hits / oracleFiles.size : 0;
  const filePrecision = ranked.length ? hits / ranked.length : 0;
  const firstHit = ranked.findIndex((f) => oracleFiles.has(f));
  const recallAt: Record<number, number> = {};
  for (const k of ks)
    recallAt[k] = oracleFiles.size
      ? ranked.slice(0, k).filter((f) => oracleFiles.has(f)).length /
        oracleFiles.size
      : 0;
  const gold = mergeSpans(task.oracle.spans);
  const predicted = mergeSpans(prediction.spans);
  const shared = overlapLines(gold, predicted);
  const goldLines = lineCount(gold);
  const predictedLines = lineCount(predicted);
  const lineRecall = goldLines ? shared / goldLines : 0;
  const linePrecision = predictedLines ? shared / predictedLines : 0;
  return {
    fileRecall,
    filePrecision,
    fileF1: f1(filePrecision, fileRecall),
    lineRecall,
    linePrecision,
    lineF1: f1(linePrecision, lineRecall),
    mrr: firstHit < 0 ? 0 : 1 / (firstHit + 1),
    recallAt,
    predictedLines,
  };
}

/** Deterministic PRNG (mulberry32) so confidence intervals are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = {
  mean: number;
  low: number;
  high: number;
  n: number;
  clusters: number;
};

/**
 * Cluster bootstrap 95% interval of a mean. Tasks from one repository are correlated, so whole
 * repositories are resampled. For a paired comparison pass per-task differences (arm B minus arm A).
 */
export function clusterBootstrap(
  values: { cluster: string; value: number }[],
  iterations = 2000,
  seed = 7,
): Interval {
  const clusters = new Map<string, number[]>();
  for (const { cluster, value } of values)
    clusters.set(cluster, [...(clusters.get(cluster) ?? []), value]);
  const groups = [...clusters.values()];
  const mean = values.reduce((s, v) => s + v.value, 0) / (values.length || 1);
  if (groups.length < 2)
    return {
      mean,
      low: mean,
      high: mean,
      n: values.length,
      clusters: groups.length,
    };
  const random = rng(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < groups.length; j++) {
      const group = groups[Math.floor(random() * groups.length)]!;
      for (const v of group) sum += v;
      count += group.length;
    }
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    low: means[Math.floor(0.025 * iterations)]!,
    high: means[Math.ceil(0.975 * iterations) - 1]!,
    n: values.length,
    clusters: groups.length,
  };
}

/** Paired difference interval: tasks present in both runs, B minus A, clustered by repository. */
export function pairedDifference(
  a: Map<string, { cluster: string; value: number }>,
  b: Map<string, { cluster: string; value: number }>,
): Interval {
  const diffs: { cluster: string; value: number }[] = [];
  for (const [id, x] of a) {
    const y = b.get(id);
    if (y) diffs.push({ cluster: x.cluster, value: y.value - x.value });
  }
  return clusterBootstrap(diffs);
}

/** Tasks needed for a paired 95% CI half-width, given the SD of per-task differences. */
export function pairedSampleSize(
  sdOfDifference: number,
  halfWidth: number,
  designEffect = 1,
): number {
  return Math.ceil(((1.96 * sdOfDifference) / halfWidth) ** 2 * designEffect);
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  ]!;
}
