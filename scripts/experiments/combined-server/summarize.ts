// Export aggregate evidence without fixture credentials, paths or session IDs.
type Sample = {
  phase: string;
  elapsedMs: number;
  rssMiB: number;
  infrastructureRssMiB: number;
  apiMs: number | null;
};
type Trial = {
  layout: string;
  repeat: number;
  readyMs: number;
  loadMs?: number;
  idempotentRetries?: number;
  publishedHints?: number;
  toolReceipts?: Array<{ bytes: number; state: string }>;
  faultReceipt?: Record<string, unknown>;
  shutdown?: { shutdownMs: number; exits: number[] };
  samples: Sample[];
};
function quantile(values: number[], percentile: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * percentile)]! : null;
}
function summarize(trial: Trial) {
  const idle = trial.samples.filter((sample) => sample.phase === "idle");
  const lateIdle = idle.slice(Math.floor(idle.length / 2));
  const load = trial.samples.filter((sample) => sample.phase === "load");
  const latency = load.flatMap((sample) => (sample.apiMs === null ? [] : [sample.apiMs]));
  return {
    layout: trial.layout,
    repeat: trial.repeat,
    readyMs: trial.readyMs,
    loadMs: trial.loadMs,
    idleMedianMiB: quantile(
      lateIdle.map((sample) => sample.rssMiB),
      0.5,
    ),
    idleInfrastructureMedianMiB: quantile(
      lateIdle.map((sample) => sample.infrastructureRssMiB),
      0.5,
    ),
    idleWholeStackMedianMiB: quantile(
      lateIdle.map((sample) => sample.rssMiB + sample.infrastructureRssMiB),
      0.5,
    ),
    loadPeakMiB: quantile(
      load.map((sample) => sample.rssMiB),
      1,
    ),
    loadMedianMiB: quantile(
      load.map((sample) => sample.rssMiB),
      0.5,
    ),
    loadHealthMs: {
      median: quantile(latency, 0.5),
      p95: quantile(latency, 0.95),
      max: quantile(latency, 1),
      failedSamples: load.filter((sample) => sample.apiMs === null).length,
    },
    idempotentRetries: trial.idempotentRetries,
    publishedHints: trial.publishedHints,
    exports: trial.toolReceipts?.map(({ bytes, state }) => ({ bytes, state })),
    fault: trial.faultReceipt,
    shutdown: trial.shutdown,
  };
}
const names = process.argv.slice(2);
if (!names.length || names.some((name) => !/^[a-z0-9-]+$/.test(name)))
  throw new Error("Provide result basenames");
const evidence: Record<string, unknown> = {};
for (const name of names) {
  const trials: Trial[] = await Bun.file(`${import.meta.dir}/.state/${name}.json`).json();
  evidence[name] = trials.map(summarize);
}
await Bun.write(
  `${import.meta.dir}/measurements.json`,
  JSON.stringify(
    {
      measuredAt: "2026-10-13",
      sourceBase: "1ee99c1c1b25ae86b9af9b491d43f3cdbd1ebc39",
      runtime: "Bun 1.4.0, Linux x64",
      units: "MiB (summed process RSS; shared pages may be counted more than once)",
      baseline: "stock production role bundles, not the shared experimental split bundle",
      readiness: "fresh application processes; ready external infrastructure; warm OS file cache",
      evidence,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
