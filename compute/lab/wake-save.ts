// Durable save throughput and sparse-layer correctness on disposable hosts.
// Usage: bun wake-save.ts COUNT ROUNDS [full,resident,dirty,huge-resident]
import { copyFileSync, readFileSync, statSync } from "node:fs";
import { LAB, PROBE, ensureCgroupRoot, now, record, sleep, summarize } from "./fc";
import { WakeVm } from "./wake-pager";
import { measuredExec } from "./wake-exec";
import { metrics, delta, hugetlbMiB } from "./wake-metrics";

const count = Number(process.argv[2] ?? 1);
const rounds = Number(process.argv[3] ?? 3);
const modes = (process.argv[4] ?? "full,resident,dirty,huge-resident").split(",");
const prefix = process.env.WAKE_PREFIX ?? "wake-save";
const output = process.env.WAKE_RESULT ?? "wake-save";
if (![count, rounds].every((value) => Number.isInteger(value) && value > 0)) throw new Error("positive counts required");
if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("invalid prefix");
if (modes.some((mode) => !["full", "resident", "dirty", "huge-resident"].includes(mode))) throw new Error("unknown save mode");

async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(items.length, limit) }, async () => {
    for (;;) { const i = index++; if (i >= items.length) return; results[i] = await task(items[i]!); }
  }));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}
function quote(text: string) { return `'${text.replaceAll("'", "'\\''")}'`; }
async function command(args: string[]) {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${error}`);
}
function written(pid: number) {
  return Number(/^write_bytes:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] ?? 0);
}
function swapped(vm: SaveVm) { return Number(readFileSync(`${vm.cgroup}/memory.swap.current`, "utf8")); }
const canary = `counter=40
trap 'counter=$((counter + 1)); printf "%s\\n" "$counter" > /run/wake-counter-result' USR1
echo $$ > /run/wake-counter-pid
while :; do sleep 3600 & wait $!; done`;

class SaveVm extends WakeVm {
  constructor(id: string, readonly mode: string) { super(id); }
  override async api(method: string, path: string, body?: unknown): Promise<any> {
    if (method === "PUT" && path === "/machine-config") body = { ...body as object, track_dirty_pages: this.mode === "dirty" };
    return super.api(method, path, body);
  }
  async tick(expected: number) {
    const response = await measuredExec(this.vsock, `rm -f /run/wake-counter-result
kill -USR1 "$(cat /run/wake-counter-pid)"
for attempt in $(seq 1 200); do test -s /run/wake-counter-result && break; sleep .01; done
cat /run/wake-counter-result`, 10000, true);
    if (response.status !== 0 || Number(response.out.trim().split("\n")[0]) !== expected) throw new Error(`${this.id}: in-memory process canary mismatch`);
  }
}

ensureCgroupRoot();
let vms: SaveVm[] = [];
try {
  for (const mode of modes) {
    vms = Array.from({ length: count }, (_, index) => new SaveVm(`${prefix}-${mode}-${String(index).padStart(3, "0")}`, mode));
    await pool(vms, 8, async (vm) => {
      await vm.boot();
      await measuredExec(vm.vsock, `cp -a /opt/work/express /root/express
nohup bash -c ${quote(canary)} >/run/wake-counter-log 2>&1 </dev/null &
for attempt in $(seq 1 200); do test -s /run/wake-counter-pid && break; sleep .01; done
sync; echo prepared`, 30000, true);
      await sleep(5000);
      await measuredExec(vm.vsock, PROBE, 30000, true);
      if (mode === "huge-resident") {
        // A full image is only preparation here. Restore lazily into hugetlb
        // memory, so only the working set is resident and cannot be swapped.
        await vm.snapshotAndStop();
        await vm.load("huge-lazy", "save-baseline");
        await vm.supervised(measuredExec(vm.vsock, PROBE, 30000, true));
      }
    });
    for (let round = 0; round < rounds; round++) {
      await pool(vms, count, async (vm) => {
        if (round > 0) await vm.resume();
        await vm.tick(41 + round);
        await measuredExec(vm.vsock, PROBE, 30000, true);
      });
      await Promise.all(vms.map((vm) => vm.pause()));
      const before = metrics();
      const started = now();
      const values = await pool(vms, count, async (vm) => {
        const memoryBefore = { ...vm.memory(), hugetlbMiB: hugetlbMiB(vm.pid) };
        if (mode.includes("resident") && swapped(vm) !== 0) throw new Error("mincore save is invalid with swapped guest pages");
        const beforeBytes = written(vm.pid);
        const begin = now();
        const memoryPath = `${vm.dir}/capture-${round}.mem`;
        await vm.supervised(vm.api("PUT", "/snapshot/create", {
          snapshot_type: mode === "full" ? "Full" : "Diff",
          snapshot_path: `${vm.dir}/capture-${round}.state`, mem_file_path: memoryPath,
          sync_snapshot_files: true,
        }));
        const saveMs = now() - begin;
        const writeBytes = written(vm.pid) - beforeBytes;
        const allocation = statSync(memoryPath);
        const memoryAfter = { ...vm.memory(), hugetlbMiB: hugetlbMiB(vm.pid) };
        if (mode.includes("resident") && swapped(vm) !== 0) throw new Error("guest pages swapped during mincore save");
        return { vm: vm.id, saveMs, writeBytes, logicalBytes: allocation.size, allocatedBytes: allocation.blocks * 512,
          memoryBefore, memoryAfter };
      });
      record(output, { event: "save", mode, count, round, phase: round === 0 ? "initial" : "subsequent",
        initialNeedsBase: mode === "huge-resident", syncSnapshotFiles: true, wallMs: now() - started,
        swapSafety: mode === "huge-resident" ? "hugetlb-is-unswappable" : mode === "resident" ? "observed-zero-swap-only-not-a-production-precondition" : "not-mincore-dependent",
        ...delta(before, metrics(), count), saveMs: summarize(values.map((value) => value.saveMs)),
        writeMiB: summarize(values.map((value) => value.writeBytes / 2 ** 20)),
        allocatedMiB: summarize(values.map((value) => value.allocatedBytes / 2 ** 20)), values });
    }
    await Promise.all(vms.map(async (vm) => { await vm.kill(); await vm.stopPager(); }));
    // Resolve layers into a NEW immutable full image, never mutate a live base.
    const mergeStarted = now();
    await pool(vms, 8, async (vm) => {
      const resolved = `${vm.dir}/resolved.mem`;
      const base = mode === "huge-resident" ? `${vm.dir}/mem.snap` : `${vm.dir}/capture-0.mem`;
      await command(["cp", "--reflink=always", base, resolved]);
      if (mode === "full") {
        await command(["cp", "--reflink=always", `${vm.dir}/capture-${rounds - 1}.mem`, resolved]);
      } else {
        for (let round = mode === "huge-resident" ? 0 : 1; round < rounds; round++) {
          await command([`${LAB}/bin/snapshot-editor`, "edit-memory", "rebase", "--memory-path", resolved, "--diff-path", `${vm.dir}/capture-${round}.mem`]);
        }
      }
      await command(["sync", "-f", resolved]);
      await command(["cp", "--reflink=always", resolved, `${vm.dir}/mem.snap`]);
      copyFileSync(`${vm.dir}/capture-${rounds - 1}.state`, `${vm.dir}/vm.snap`);
    });
    record(output, { event: "resolve", mode, count, rounds, wallMs: now() - mergeStarted });
    await pool(vms, count, async (vm) => {
      // Explicitly override saved huge-page configuration for this validation.
      await vm.load("file", "save-validation");
      await vm.tick(41 + rounds);
      const response = await measuredExec(vm.vsock, PROBE, 60000, true);
      if (response.status !== 0 || !response.out.includes("function")) throw new Error(`${vm.id}: restored workload failed`);
      await vm.kill();
    });
    record(output, { event: "validated", mode, count, checks: ["merged image restores", "in-memory process counter survives", "guest workload succeeds"] });
    vms = [];
  }
} finally {
  await Promise.allSettled(vms.map(async (vm) => { await vm.kill(); await vm.stopPager(); }));
}
