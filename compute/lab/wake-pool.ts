// Measure hugetlb capacity provisioning separately from VM restore latency.
// Run only on an otherwise idle disposable host. No active huge mappings allowed.
import { readFileSync } from "node:fs";
import { now, record } from "./fc";
import { hostMemory } from "./wake-metrics";

const targets = (process.argv[2] ?? "200,20000").split(",").map(Number);
const rounds = Number(process.argv[3] ?? 3);
const output = process.env.WAKE_RESULT ?? "wake-pool";
if (![rounds, ...targets].every((n) => Number.isInteger(n) && n > 0)) throw new Error("positive integer inputs required");
const original = Number(readFileSync("/proc/sys/vm/nr_hugepages", "utf8"));
const initial = hostMemory();
if (initial.HugePages_Free !== initial.HugePages_Total) throw new Error("refusing to change a pool with active allocations");
function setPool(pages: number) {
  const result = Bun.spawnSync(["sysctl", "-w", `vm.nr_hugepages=${pages}`]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return Number(readFileSync("/proc/sys/vm/nr_hugepages", "utf8"));
}
try {
  for (const pages of targets) for (let round = 0; round < rounds; round++) {
    setPool(0);
    const before = hostMemory();
    const started = now();
    const actual = setPool(pages);
    record(output, { event: "pool", pages, actual, round, ms: now() - started, success: actual === pages,
      reservedMiB: actual * 2, before, after: hostMemory() });
  }
} finally { setPool(original); }
