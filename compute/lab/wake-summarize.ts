// Strict JSONL aggregation. Usage: bun wake-summarize.ts RESULT.jsonl ...
// Emit JSON so no presentation rounding loses the underlying measurements.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

type Row = Record<string, any>;
function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(percentile / 100 * sorted.length))]!;
}
function summary(values: number[], scale = 1) {
  const clean = values.filter(Number.isFinite).map((v) => v / scale);
  return { samples: clean.length, p50: quantile(clean, 50), p90: quantile(clean, 90), p99: quantile(clean, 99) };
}
const groups = new Map<string, Row[]>();
for (const path of process.argv.slice(2)) {
  const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Row; } catch { throw new Error(`${path}:${index + 1}: invalid JSON`); }
  });
  for (const row of rows) {
    if (!["burst", "restore", "wake", "save", "pool"].includes(row.event)) continue;
    const key = JSON.stringify({ file: basename(path), host: row.host, engine: row.engine,
      mode: row.mode ?? row.variant, level: row.level, n: row.count, concurrency: row.concurrency,
      phase: row.phase, poolPages: row.pages,
      cache: row.cache, storage: row.storage, lifecycle: row.lifecycle,
      measurement: row.measurement, completionPolicy: row.completionPolicy,
      prefetchTiming: row.prefetchTiming, prefetchOrder: row.prefetchOrder });
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
}
for (const [key, rows] of groups) {
  const values: Row[] = rows.flatMap((row) => row.values ?? (row.event === "pool" ? [row] : []));
  console.log(JSON.stringify({ ...JSON.parse(key), repetitions: rows.length,
    commandCompleteSeconds: summary(values.map((value) => value.commandCompleteMs), 1000),
    saveSeconds: summary(values.map((value) => value.saveMs), 1000),
    writtenMiB: summary(values.map((value) => value.writeBytes), 1024 * 1024),
    allocatedMiB: summary(values.map((value) => value.allocatedBytes), 1024 * 1024),
    poolProvisionSeconds: summary(values.map((value) => value.ms), 1000),
    burstCommandCompleteSeconds: summary(values.map((value) => value.burstCommandCompleteMs), 1000),
    transportTailSeconds: summary(values.map((value) => value.transportTailMs), 1000),
    totalSeconds: summary(values.map((value) => value.totalMs), 1000),
    firstByteSeconds: summary(values.map((value) => value.firstByteMs), 1000),
    burstCompletionSeconds: summary(values.map((value) => value.burstCompletionMs), 1000),
    commandSeconds: summary(values.map((value) => value.commandMs), 1000),
    vmmResidentMiB: summary(values.map((value) => value.memory ? value.memory.rssMiB + (value.memory.hugetlbMiB ?? 0) : NaN)),
    copiedMiB: summary(values.map((value) => value.stats?.copied_bytes), 1024 * 1024),
    faults: summary(values.map((value) => value.stats?.faults)),
    fixedKvmFaultsPerVm: summary(rows.filter((row) => row.event === "burst").map((row) => row.kvmPerVm?.pf_fixed)),
    asleepMiB: summary(rows.flatMap((row) => (row.asleep ?? []).map((sample: Row) => sample.currentMiB))),
    roundP90Seconds: rows.map((row) => row.totalMs?.p90 / 1000),
    roundCommandP90Seconds: rows.map((row) => row.commandCompleteMs?.p90 / 1000),
  }));
}
