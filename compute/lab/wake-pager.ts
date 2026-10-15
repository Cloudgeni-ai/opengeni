// Matched snapshot restore experiments. Run as root on a disposable lab host.
// Usage: bun wake-pager.ts COUNT ROUNDS [file,lazy,prefetch,eager,huge-lazy,...]
// WAKE_CONCURRENCY bounds experimental admission, not host resource ownership.
import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { LAB, PROBE, ensureCgroupRoot, now, record, sleep, summarize } from "./fc";
import { metrics, delta, hugetlbMiB, hostMemory } from "./wake-metrics";
import { TimedVm } from "./wake-vm";
import { measuredExec } from "./wake-exec";

const pagerBinary = process.env.PAGER_BIN ?? `${LAB}/bin/compute-pager`;

async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i]!);
    }
  }));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

export class WakeVm extends TimedVm {
  pager?: Subprocess;
  pagerOutput = "";

  get memoryFile() { return `${process.env.WAKE_MEMORY_ROOT ?? `${LAB}/vms`}/${this.id}/mem.snap`; }

  evictSnapshot() {
    const evicted = Bun.spawnSync(["dd", `if=${this.memoryFile}`, "iflag=nocache", "count=0", "status=none"]);
    if (evicted.exitCode !== 0) throw new Error(evicted.stderr.toString());
  }

  async supervised<T>(operation: Promise<T>): Promise<T> {
    if (!this.pager) return operation;
    return Promise.race([operation, this.pager.exited.then((code) => {
      throw new Error(`${this.id}: pager exited ${code}: ${readFileSync(`${this.dir}/pager.log`, "utf8")}`);
    })]);
  }

  async stopPager() {
    if (!this.pager) return;
    this.pager.kill("SIGTERM");
    const code = await this.pager.exited;
    this.pager = undefined;
    if (code !== 0) throw new Error(`${this.id}: pager exited ${code}: ${readFileSync(`${this.dir}/pager.log`, "utf8")}`);
  }

  async load(mode: string, label: string) {
    const started = now();
    const huge = mode.startsWith("huge-");
    const policy = mode.replace(/^huge-/, "").replace(/-cold$/, "");
    rmSync(this.apiSock, { force: true });
    rmSync(this.vsock, { force: true });
    const socket = `${this.dir}/pager.sock`;
    rmSync(socket, { force: true });
    this.pagerOutput = `${this.dir}/${label}`;
    rmSync(`${this.pagerOutput}.ready`, { force: true });
    if (policy !== "file") {
      const strategy = policy === "prefetch" ? `${this.dir}/working-set.json` : policy;
      this.pager = spawn([pagerBinary, socket, this.memoryFile, this.id, this.pagerOutput, strategy, "60000", process.env.WAKE_PREFETCH_ORDER ?? "ordered"], {
        stdout: Bun.file(`${this.dir}/pager.log`), stderr: Bun.file(`${this.dir}/pager.log`), stdin: "ignore",
      });
      while (!existsSync(socket)) {
        if (this.pager.exitCode !== null || now() - started > 10000) throw new Error("pager failed to listen");
        await sleep(1);
      }
    }
    this.proc = spawn([process.env.WAKE_VMM ?? `${LAB}/bin/firecracker`, "--api-sock", this.apiSock, "--id", this.id, ...(process.env.WAKE_NO_SECCOMP === "1" ? ["--no-seccomp"] : [])], {
      stdout: Bun.file(`${this.dir}/console.log`), stderr: Bun.file(`${this.dir}/vmm.log`), stdin: "ignore",
      env: { ...process.env, ...(process.env.WAKE_PREFAULT_WORKING_SET === "1" ? { WAKE_PREFAULT_PROFILE: `${this.dir}/working-set.json` } : {}) },
    });
    writeFileSync(`${this.cgroup}/cgroup.procs`, String(this.pid));
    while (!existsSync(this.apiSock)) {
      if (this.proc.exitCode !== null || now() - started > 10000) throw new Error("VMM failed to listen");
      await sleep(1);
    }
    await this.supervised(this.api("PUT", "/snapshot/load", {
      snapshot_path: `${this.dir}/vm.snap`,
      mem_backend: { backend_type: policy === "file" ? "File" : "Uffd", backend_path: policy === "file" ? this.memoryFile : socket },
      huge_pages: huge ? "2M" : "None",
      resume_vm: false,
      enable_diff_snapshots: false,
    }));
    if (policy !== "file" && process.env.WAKE_PREFETCH_TIMING !== "overlap") {
      while (!existsSync(`${this.pagerOutput}.ready`)) {
        if (this.pager!.exitCode !== null) throw new Error(`pager failed: ${readFileSync(`${this.dir}/pager.log`, "utf8")}`);
        if (now() - started > 120000) throw new Error("prefetch timed out");
        await sleep(1);
      }
    }
    const loadMs = now() - started;
    await this.resume();
    return { loadMs, resumeMs: now() - started };
  }
}

if (import.meta.main) {
const count = Number(process.argv[2] ?? 1);
const rounds = Number(process.argv[3] ?? 5);
const modes = (process.argv[4] ?? "file,lazy,prefetch,eager").split(",");
const concurrency = Number(process.env.WAKE_CONCURRENCY ?? count);
const output = process.env.WAKE_RESULT ?? "wake-pager";
const prefix = process.env.WAKE_PREFIX ?? "wake-pager";
if (![count, rounds, concurrency].every((n) => Number.isInteger(n) && n > 0)) throw new Error("positive integer counts required");
if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("invalid VM prefix");
ensureCgroupRoot();
const vms = Array.from({ length: count }, (_, i) => new WakeVm(`${prefix}-${i.toString().padStart(3, "0")}`));
record(output, { event: "start", count, rounds, modes, concurrency, kernel: Bun.spawnSync(["uname", "-r"]).stdout.toString().trim() });
try {
  if (process.env.WAKE_REUSE !== "1") await pool(vms, 8, async (vm) => {
    const bootMs = await vm.boot();
    // Same public repository and first command as the original harness;
    // no network installation or test-suite variability in snapshot preparation.
    const prepared = await vm.exec("cp -a /opt/work/express /root/express && echo prepared");
    if (!prepared.out.includes("prepared")) throw new Error("guest preparation failed");
    await vm.exec("sync && echo 3 > /proc/sys/vm/drop_caches && echo dropped");
    await sleep(5000);
    const awake = await measuredExec(vm.vsock, PROBE);
    const snapshot = await vm.snapshotAndStop();
    record(output, { event: "prepared", vm: vm.id, bootMs, awakeCommandMs: awake.doneMs, awakeEofMs: awake.ms, snapshotMs: snapshot.ms, snapshot: vm.diskUsageMiB("mem.snap") });
  });
  for (const mode of modes) {
    for (let round = 0; round < rounds; round++) {
      if (mode.endsWith("-cold")) for (const vm of vms) vm.evictSnapshot();
      const burstStarted = now();
      const before = metrics();
      const values = await pool(vms, concurrency, async (vm) => {
        const admitted = now();
        const loaded = await vm.load(mode, `${mode}-${round}`);
        const commandStarted = now();
        const probe = await vm.supervised(measuredExec(vm.vsock, PROBE, 120000, process.env.WAKE_CLOSE_AT_COMPLETION === "1"))
          .catch((error) => { throw new Error(`${vm.id} (${mode}): ${error}`, { cause: error }); });
        if (!probe.out.includes("function") || probe.status !== 0) throw new Error(`${vm.id}: probe failed`);
        const finished = now();
        const memory = { ...vm.memory(), hugetlbMiB: hugetlbMiB(vm.pid) };
        return { vm: vm.id, queueMs: admitted - burstStarted, ...loaded,
          totalMs: finished - admitted, burstCompletionMs: finished - burstStarted,
          firstByteMs: commandStarted - admitted + probe.firstByteMs,
          commandCompleteMs: commandStarted - admitted + probe.doneMs,
          burstCommandCompleteMs: commandStarted - burstStarted + probe.doneMs,
          observedCommandMs: probe.doneMs, transportTailMs: probe.ms - probe.doneMs,
          commandMs: probe.ms, memory, stats: null as Record<string, number> | null };
      });
      const wallMs = now() - burstStarted;
      const counters = delta(before, metrics(), count);
      const hostMemoryAtCompletion = hostMemory();
      await Promise.all(vms.map(async (vm, index) => {
        await vm.kill();
        await vm.stopPager();
        if (mode.replace(/-cold$/, "") !== "file") {
          values[index]!.stats = JSON.parse(readFileSync(`${vm.pagerOutput}.stats.json`, "utf8"));
        }
        if (mode === "lazy" && round === 0) copyFileSync(`${vm.pagerOutput}.profile.json`, `${vm.dir}/working-set.json`);
      }));
      record(output, { event: "burst", mode, round, count, concurrency,
        measurement: "guest-completion-marker-and-eof",
        completionPolicy: process.env.WAKE_CLOSE_AT_COMPLETION === "1" ? "client-close-at-marker" : "wait-for-peer-eof",
        lifecycle: "retain-all-until-burst-complete",
        hostMemoryAtCompletion,
        prefetchTiming: process.env.WAKE_PREFETCH_TIMING ?? "before-resume",
        prefetchOrder: process.env.WAKE_PREFETCH_ORDER ?? "ordered",
        ...counters,
        cache: mode.endsWith("-cold") ? "snapshot-evicted-rootfs-warm" : "snapshot-written-and-reused",
        storage: process.env.WAKE_STORAGE_LABEL ?? "default", wallMs,
        totalMs: summarize(values.map((v) => v.totalMs)),
        commandCompleteMs: summarize(values.map((v) => v.commandCompleteMs)),
        burstCommandCompleteMs: summarize(values.map((v) => v.burstCommandCompleteMs)),
        burstCompletionMs: summarize(values.map((v) => v.burstCompletionMs)),
        firstByteMs: summarize(values.map((v) => v.firstByteMs)),
        commandMs: summarize(values.map((v) => v.commandMs)), values });
    }
  }
} finally {
  await Promise.allSettled(vms.map(async (vm) => { await vm.kill(); await vm.stopPager(); }));
  // Keep per-VM immutable snapshots and profiles for controlled follow-up tests.
  // The resource ledger owns their explicit cleanup after results are retained.
}
}
