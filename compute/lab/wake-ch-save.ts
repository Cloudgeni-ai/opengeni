// Shared file-backed RAM: durable flush + immutable reflink checkpoint.
// Usage: WAKE_ENGINE_FILE_MEMORY=1 bun wake-ch-save.ts COUNT ROUNDS
import { renameSync, readFileSync } from "node:fs";
import { CloudVm, pool } from "./wake-engine";
import { PROBE, ensureCgroupRoot, now, sleep, record, summarize } from "./fc";
import { measuredExec } from "./wake-exec";
import { metrics, delta } from "./wake-metrics";

const count = Number(process.argv[2] ?? 1);
const rounds = Number(process.argv[3] ?? 3);
const prefix = process.env.WAKE_PREFIX ?? "wake-ch-save";
const output = process.env.WAKE_RESULT ?? "wake-ch-save";
if (process.env.WAKE_ENGINE_FILE_MEMORY !== "1") throw new Error("shared file-backed memory must be explicitly selected");
if (!/^[a-z0-9-]+$/.test(prefix) || ![count, rounds].every((n) => Number.isInteger(n) && n > 0)) throw new Error("invalid inputs");
function quote(text: string) { return `'${text.replaceAll("'", "'\\''")}'`; }
const program = `counter=40
trap 'counter=$((counter+1)); printf "%s\\n" "$counter" > /run/wake-counter-result' USR1
echo $$ > /run/wake-counter-pid
while :; do sleep 3600 & wait $!; done`;
async function tick(vm: CloudVm, expected: number) {
  const result = await measuredExec(vm.vsock, `rm -f /run/wake-counter-result
kill -USR1 "$(cat /run/wake-counter-pid)"
for attempt in $(seq 1 200); do test -s /run/wake-counter-result && break; sleep .01; done
cat /run/wake-counter-result`, 10000, true);
  if (result.status !== 0 || Number(result.out.trim().split("\n")[0]) !== expected) throw new Error(`${vm.id}: process state lost`);
}
function written(vm: CloudVm) { return Number(/^write_bytes:\s+(\d+)/m.exec(readFileSync(`/proc/${vm.pid}/io`, "utf8"))?.[1] ?? 0); }
ensureCgroupRoot();
const vms = Array.from({ length: count }, (_, i) => new CloudVm(`${prefix}-${String(i).padStart(3, "0")}`));
try {
  const lifecycleStart = metrics();
  await pool(vms, 8, async (vm) => {
    await vm.boot();
    await measuredExec(vm.vsock, `cp -a /opt/work/express /root/express
nohup bash -c ${quote(program)} >/run/wake-counter-log 2>&1 </dev/null &
for attempt in $(seq 1 200); do test -s /run/wake-counter-pid && break; sleep .01; done
sync; echo prepared`, 30000, true);
    await sleep(5000);
    await measuredExec(vm.vsock, PROBE, 30000, true);
  });
  record(output, { event: "preparation-io", engine: "cloud-hypervisor", count, ...delta(lifecycleStart, metrics(), count),
    vmmWriteMiB: summarize(vms.map((vm) => written(vm) / 2 ** 20)),
    note: "Shared RAM may write to disk during guest execution; checkpoint-only write bytes are not total lifecycle cost." });
  for (let round = 0; round < rounds; round++) {
    const wakes = await pool(vms, count, async (vm) => {
      const started = now();
      if (round > 0) await vm.load("Copy");
      await tick(vm, 41 + round);
      const response = await measuredExec(vm.vsock, PROBE, 60000, true);
      if (response.status !== 0 || !response.out.includes("function")) throw new Error("restored workload failed");
      if (round > 0) renameSync(`${vm.dir}/snapshot`, `${vm.dir}/capture-${round - 1}`);
      return { commandCompleteMs: now() - started };
    });
    if (round > 0) record(output, { event: "restore", engine: "cloud-hypervisor", mode: "shared-file-with-canary", count, round,
      commandCompleteMs: summarize(wakes.map((value) => value.commandCompleteMs)), values: wakes });
    const before = metrics();
    const started = now();
    const values = await pool(vms, count, async (vm) => {
      const memoryBefore = vm.memory();
      const snapshot = await vm.snapshotAndStop();
      return { vm: vm.id, saveMs: snapshot.ms, writeBytes: snapshot.writeBytes,
        allocatedBytes: snapshot.backingAllocatedBytes, memoryBefore };
    });
    record(output, { event: "save", engine: "cloud-hypervisor", mode: "shared-file", count, round,
      phase: round === 0 ? "initial" : "subsequent", wallMs: now() - started,
      syncSnapshotFiles: true, includesPauseAndReflink: true, ...delta(before, metrics(), count),
      saveMs: summarize(values.map((value) => value.saveMs)),
      writeMiB: summarize(values.map((value) => value.writeBytes / 2 ** 20)), values });
  }
  await pool(vms, count, async (vm) => { await vm.load("Copy"); await tick(vm, 41 + rounds); await vm.kill(); });
  record(output, { event: "validated", engine: "cloud-hypervisor", mode: "shared-file", count,
    checks: ["immutable checkpoint cloned before every writable restore", "in-memory process counter continues"] });
} finally { await Promise.allSettled(vms.map((vm) => vm.kill())); }
