// Compare engines on the same kernel, guest image, CPU count and command.
// Usage: bun wake-engine.ts firecracker|cloud-hypervisor COUNT ROUNDS
import { spawn } from "bun";
import { existsSync, mkdirSync, rmSync, writeFileSync, truncateSync, statSync, readFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { LAB, PROBE, DEFAULT_BOOT_ARGS, ensureCgroupRoot, now, sleep, sh, record, summarize } from "./fc";
import { TimedVm } from "./wake-vm";
import { measuredExec } from "./wake-exec";

export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let index = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = index++; if (i >= items.length) return; out[i] = await fn(items[i]!); }
  }));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return out;
}

async function syncFile(path: string) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function reflink(source: string, target: string) {
  const child = Bun.spawn(["cp", "--reflink=always", source, target], { stdout: "ignore", stderr: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
}

export class CloudVm extends TimedVm {
  readonly fileMemory = process.env.WAKE_ENGINE_FILE_MEMORY === "1";
  async call(name: string, body?: unknown) {
    return this.api("PUT", `/api/v1/vm.${name}`, body);
  }
  async start() {
    rmSync(this.apiSock, { force: true });
    rmSync(this.vsock, { force: true });
    if (!existsSync(this.cgroup)) mkdirSync(this.cgroup);
    this.proc = spawn([`${LAB}/bin/cloud-hypervisor`, "--api-socket", this.apiSock], {
      stdin: "ignore", stdout: Bun.file(`${this.dir}/vmm.log`), stderr: Bun.file(`${this.dir}/vmm.log`),
    });
    writeFileSync(`${this.cgroup}/cgroup.procs`, String(this.pid));
    const deadline = now() + 10000;
    while (!existsSync(this.apiSock)) {
      if (this.proc.exitCode !== null || now() > deadline) throw new Error(`${this.id}: VMM failed to start`);
      await sleep(1);
    }
  }
  override async boot() {
    const started = now();
    if (existsSync(this.dir)) throw new Error(`${this.id}: directory already exists; use a fresh prefix`);
    mkdirSync(this.dir, { recursive: true });
    sh(`cp --reflink=always ${LAB}/base.ext4 ${this.dir}/rootfs.ext4`);
    if (this.fileMemory) {
      writeFileSync(`${this.dir}/guest-memory`, "");
      truncateSync(`${this.dir}/guest-memory`, 2048 * 1024 * 1024);
    }
    await this.start();
    await this.call("create", {
      cpus: { boot_vcpus: 2, max_vcpus: 2 },
      memory: this.fileMemory ? { size: 0, zones: [{ id: "ram", size: 2048 * 1024 * 1024, file: `${this.dir}/guest-memory`, shared: true }] } : { size: 2048 * 1024 * 1024 },
      payload: { kernel: `${LAB}/vmlinux`, cmdline: `${DEFAULT_BOOT_ARGS} root=/dev/vda rw` },
      disks: [{ path: `${this.dir}/rootfs.ext4`, image_type: "Raw" }],
      vsock: { cid: 3, socket: this.vsock },
      serial: { mode: "File", file: `${this.dir}/console.log` }, console: { mode: "Off" },
      balloon: { size: 0, deflate_on_oom: true, free_page_reporting: true },
    });
    await this.call("boot");
    await this.waitAgent(60000);
    return now() - started;
  }
  override async pause() { await this.call("pause"); }
  override async resume() { await this.call("resume"); }
  override async snapshotAndStop() {
    const started = now();
    const bytesBefore = Number(/^write_bytes:\s+(\d+)/m.exec(readFileSync(`/proc/${this.pid}/io`, "utf8"))?.[1] ?? 0);
    await this.pause();
    mkdirSync(`${this.dir}/snapshot`);
    await this.call("snapshot", { destination_url: `file://${this.dir}/snapshot` });
    let backingAllocatedBytes: number | undefined;
    if (this.fileMemory) {
      // MAP_SHARED RAM is a mutable working file. Flush and clone while paused;
      // the checkpoint itself must never be mapped writable by a running VM.
      await syncFile(`${this.dir}/guest-memory`);
      await reflink(`${this.dir}/guest-memory`, `${this.dir}/guest-memory.base`);
      await syncFile(`${this.dir}/guest-memory.base`);
      backingAllocatedBytes = statSync(`${this.dir}/guest-memory.base`).blocks * 512;
    }
    // Match the Firecracker harness's durable snapshot boundary.
    if (this.fileMemory) {
      for (const name of readdirSync(`${this.dir}/snapshot`)) await syncFile(`${this.dir}/snapshot/${name}`);
      await syncFile(`${this.dir}/snapshot`);
      await syncFile(this.dir);
    } else sh(`sync -f ${this.dir}/snapshot`);
    const ms = now() - started;
    const writeBytes = Number(/^write_bytes:\s+(\d+)/m.exec(readFileSync(`/proc/${this.pid}/io`, "utf8"))?.[1] ?? 0) - bytesBefore;
    await this.kill();
    return { ms, memFile: `${this.dir}/snapshot/memory-ranges`, stateFile: `${this.dir}/snapshot/state.json`, writeBytes, backingAllocatedBytes };
  }
  async load(mode: string) {
    const started = now();
    if (this.fileMemory) await reflink(`${this.dir}/guest-memory.base`, `${this.dir}/guest-memory`);
    await this.start();
    await this.call("restore", { source_url: `file://${this.dir}/snapshot`, memory_restore_mode: mode });
    await this.resume();
    return now() - started;
  }
}

if (import.meta.main) {
const engine = process.argv[2] ?? "cloud-hypervisor";
const count = Number(process.argv[3] ?? 1);
const rounds = Number(process.argv[4] ?? 5);
const output = process.env.WAKE_RESULT ?? "wake-engine";
const modes = engine === "firecracker" ? ["File"] : (process.env.WAKE_ENGINE_MODES ?? "Copy,OnDemand,CopyOnWrite").split(",");
const prefix = process.env.WAKE_PREFIX ?? `wake-${engine}`;
if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("invalid VM prefix");
if (![count, rounds].every((n) => Number.isInteger(n) && n > 0)) throw new Error("positive counts required");
ensureCgroupRoot();
const vms = Array.from({ length: count }, (_, i) => engine === "firecracker"
  ? new TimedVm(`${prefix}-${String(i).padStart(3, "0")}`) : new CloudVm(`${prefix}-${String(i).padStart(3, "0")}`));
try {
  if (process.env.WAKE_REUSE !== "1") {
    const preparation = await pool(vms, 8, async (vm) => {
      const bootMs = await vm.boot();
      await vm.exec("cp -a /opt/work/express /root/express && sync && echo 3 > /proc/sys/vm/drop_caches");
      await sleep(5000);
      const idle = vm.memory();
      const awake = await measuredExec(vm.vsock, PROBE);
      const snapshot = await vm.snapshotAndStop();
      return { bootMs, idle, awakeMs: awake.doneMs, awakeEofMs: awake.ms, snapshotMs: snapshot.ms,
        snapshotWriteBytes: "writeBytes" in snapshot ? snapshot.writeBytes : undefined };
    });
    record(output, { event: "prepared", engine, count, bootMs: summarize(preparation.map((x) => x.bootMs)),
      snapshotMs: summarize(preparation.map((x) => x.snapshotMs)), idleRssMiB: summarize(preparation.map((x) => x.idle.rssMiB)),
      idleAnonMiB: summarize(preparation.map((x) => x.idle.anonMiB)), preparation });
  }
  for (const mode of modes) for (let round = 0; round < rounds; round++) {
    const started = now();
    const values = await pool(vms, count, async (vm) => {
      const begin = now();
      const loadMs = vm instanceof CloudVm ? await vm.load(mode) : (await vm.restore()).loadMs;
      const commandStart = now();
      const probe = await measuredExec(vm.vsock, PROBE);
      if (!probe.out.includes("function") || probe.status !== 0) throw new Error("probe failed");
      const finished = now();
      const memory = vm.memory();
      return { totalMs: finished - begin, firstByteMs: commandStart - begin + probe.firstByteMs, loadMs, commandMs: probe.ms, memory,
        commandCompleteMs: commandStart - begin + probe.doneMs, observedCommandMs: probe.doneMs, transportTailMs: probe.ms - probe.doneMs };
    });
    const wallMs = now() - started;
    await Promise.all(vms.map((vm) => vm.kill()));
    record(output, { event: "restore", engine, mode, count, round, wallMs,
      fileBackedSharedMemory: process.env.WAKE_ENGINE_FILE_MEMORY === "1",
      measurement: "guest-completion-marker-and-eof", commandCompleteMs: summarize(values.map((x) => x.commandCompleteMs)),
      totalMs: summarize(values.map((x) => x.totalMs)), loadMs: summarize(values.map((x) => x.loadMs)),
      firstByteMs: summarize(values.map((x) => x.firstByteMs)), values });
  }
} finally { await Promise.allSettled(vms.map((vm) => vm.kill())); }
}
