// Measure metadata-only thin snapshots while the owned data device is idle.
// The caller owns storage-pool and must have stopped all guest writers.
import { writeFileSync } from "node:fs";
import { sh, now } from "./fc";
const count = Number(process.argv[2] ?? 1000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("invalid count");
const before = sh("dmsetup status storage-pool").trim();
const times: number[] = [];
const created: number[] = [];
try {
  for (let i = 0; i < count; i++) {
    const id = 10000 + i;
    const start = now();
    sh(`dmsetup message storage-pool 0 'create_snap ${id} 1'`);
    created.push(id); times.push(now() - start);
  }
  const after = sh("dmsetup status storage-pool").trim();
  const sorted = [...times].sort((a, b) => a - b);
  const result = { count, before, after, totalMs: times.reduce((a, b) => a + b, 0), p50Ms: sorted[Math.floor(count / 2)], p99Ms: sorted[Math.floor(count * 0.99)], method: "dmsetup subprocess per snapshot; includes process launch overhead" };
  writeFileSync("/lab/storage/analysis/density-thin.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const id of created) sh(`dmsetup message storage-pool 0 'delete ${id}'`);
}
