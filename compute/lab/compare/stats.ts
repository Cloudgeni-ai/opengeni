/** Latency summaries: nearest-rank percentiles over milliseconds. */

export interface Summary {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * The nearest-rank percentile of already sorted samples: the smallest
 * sample with at least `p` percent of the samples at or below it. It never
 * invents a value between two samples, and with few samples it errs high.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of no samples");
  if (!(p > 0 && p <= 100)) throw new Error(`percentile must be in (0, 100]: ${p}`);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error("summary of no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** Milliseconds as a short human string: "12 ms", "1.4 s". */
export function formatMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}
