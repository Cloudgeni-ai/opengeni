// Minimal Firecracker driver for sleep/wake experiments.
//
// Every VM gets its own directory under $LAB_DIR/vms/<id>, its own cgroup under
// /sys/fs/cgroup/lab/<id> (so the host can reclaim and account its memory), a
// copy-on-write clone of the base root filesystem, and a vsock exec channel.
// Run as root on a host prepared by host-setup.sh.
import { spawn, type Subprocess } from "bun";
import { connect } from "node:net";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export const LAB = process.env.LAB_DIR ?? "/lab";
const FIRECRACKER = `${LAB}/bin/firecracker`;
const CGROUP_ROOT = "/sys/fs/cgroup/lab";
const AGENT_PORT = 52;
/**
 * Report every freed guest page (not only free 2 MiB blocks) so an idle guest
 * hands nearly all of its free memory back to the host. Measured in
 * exp-reclaim.ts: the kernel default keeps roughly twice as much RAM resident.
 */
export const DEFAULT_BOOT_ARGS =
  process.env.GUEST_ARGS ?? "console=ttyS0 reboot=k panic=1 quiet loglevel=1 page_reporting.page_reporting_order=0";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
export const MiB = 1024 * 1024;

export function sh(cmd: string): string {
  const r = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`command failed (${r.exitCode}): ${cmd}\n${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

export function ensureCgroupRoot() {
  if (!existsSync(CGROUP_ROOT)) mkdirSync(CGROUP_ROOT);
  writeFileSync(`${CGROUP_ROOT}/cgroup.subtree_control`, "+memory +cpu");
}

export type BootOptions = {
  vcpus?: number;
  memMib?: number;
  freePageReporting?: boolean;
  bootArgs?: string;
};

export type MemorySample = {
  currentMiB: number; // everything charged to the VM cgroup, compressed zswap included
  anonMiB: number;
  fileMiB: number;
  zswapMiB: number; // compressed size held in RAM
  zswappedMiB: number; // original size of pages held in zswap
  swapMiB: number; // pages on the swap device (including those also in zswap)
  rssMiB: number;
  pssMiB: number;
};

export type ExecResult = { out: string; ms: number; firstByteMs: number };

export class Vm {
  readonly dir: string;
  readonly apiSock: string;
  readonly vsock: string;
  readonly cgroup: string;
  proc?: Subprocess;

  constructor(readonly id: string) {
    this.dir = `${LAB}/vms/${id}`;
    this.apiSock = `${this.dir}/api.sock`;
    this.vsock = `${this.dir}/v.sock`;
    this.cgroup = `${CGROUP_ROOT}/${id}`;
  }

  get pid(): number {
    if (!this.proc) throw new Error(`${this.id} has no process`);
    return this.proc.pid;
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`http://localhost${path}`, {
      method,
      unix: this.apiSock,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as RequestInit);
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.id} ${method} ${path} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  }

  private async spawnVmm() {
    rmSync(this.apiSock, { force: true });
    rmSync(this.vsock, { force: true });
    if (!existsSync(this.cgroup)) mkdirSync(this.cgroup);
    this.proc = spawn([FIRECRACKER, "--api-sock", this.apiSock, "--id", this.id.replace(/[^a-zA-Z0-9-]/g, "-")], {
      stdout: Bun.file(`${this.dir}/console.log`),
      stderr: Bun.file(`${this.dir}/vmm.log`),
      stdin: "ignore",
    });
    writeFileSync(`${this.cgroup}/cgroup.procs`, String(this.proc.pid));
    const deadline = now() + 5000;
    while (!existsSync(this.apiSock)) {
      if (now() > deadline) throw new Error(`${this.id}: firecracker api socket did not appear`);
      await sleep(2);
    }
  }

  /** Cold boot from a copy-on-write clone of base.ext4. Returns ms until the agent answers. */
  async boot(opts: BootOptions = {}): Promise<number> {
    const t0 = now();
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    sh(`cp --reflink=always ${LAB}/base.ext4 ${this.dir}/rootfs.ext4`);
    await this.spawnVmm();
    await this.api("PUT", "/boot-source", {
      kernel_image_path: `${LAB}/vmlinux`,
      boot_args: opts.bootArgs ?? DEFAULT_BOOT_ARGS,
    });
    await this.api("PUT", "/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: `${this.dir}/rootfs.ext4`,
      is_root_device: true,
      is_read_only: false,
    });
    await this.api("PUT", "/machine-config", {
      vcpu_count: opts.vcpus ?? 2,
      mem_size_mib: opts.memMib ?? 2048,
      smt: false,
    });
    await this.api("PUT", "/balloon", {
      amount_mib: 0,
      deflate_on_oom: true,
      stats_polling_interval_s: 0,
      free_page_reporting: opts.freePageReporting ?? true,
    });
    await this.api("PUT", "/vsock", { guest_cid: 3, uds_path: this.vsock });
    await this.api("PUT", "/actions", { action_type: "InstanceStart" });
    await this.waitAgent(60_000);
    return now() - t0;
  }

  async waitAgent(timeoutMs: number) {
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        await this.exec("true", 2000);
        return;
      } catch (err) {
        if (now() > deadline) throw new Error(`${this.id}: agent not ready: ${err}`);
        await sleep(20);
      }
    }
  }

  /** Run a bash script inside the guest over vsock. */
  exec(script: string, timeoutMs = 600_000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const t0 = now();
      let firstByteMs = 0;
      let out = "";
      let handshake = "";
      let connected = false;
      const sock = connect(this.vsock);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`${this.id}: exec timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      sock.on("connect", () => sock.write(`CONNECT ${AGENT_PORT}\n`));
      sock.on("data", (chunk: Buffer) => {
        let text = chunk.toString();
        if (!connected) {
          handshake += text;
          const nl = handshake.indexOf("\n");
          if (nl < 0) return;
          if (!handshake.startsWith("OK")) {
            clearTimeout(timer);
            sock.destroy();
            reject(new Error(`${this.id}: vsock handshake failed: ${handshake.trim()}`));
            return;
          }
          connected = true;
          text = handshake.slice(nl + 1);
          sock.write(`${script}\nexit\n`);
        }
        if (text.length > 0 && firstByteMs === 0) firstByteMs = now() - t0;
        out += text;
      });
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on("close", () => {
        clearTimeout(timer);
        if (!connected) reject(new Error(`${this.id}: vsock closed before handshake`));
        else resolve({ out, ms: now() - t0, firstByteMs });
      });
    });
  }

  async pause() {
    await this.api("PATCH", "/vm", { state: "Paused" });
  }

  async resume() {
    await this.api("PATCH", "/vm", { state: "Resumed" });
  }

  /** Pause, write a full snapshot, and stop the VMM so the VM holds no RAM. */
  async snapshotAndStop(sync = true): Promise<{ ms: number; memFile: string; stateFile: string }> {
    const t0 = now();
    await this.pause();
    const memFile = `${this.dir}/mem.snap`;
    const stateFile = `${this.dir}/vm.snap`;
    rmSync(memFile, { force: true });
    rmSync(stateFile, { force: true });
    await this.api("PUT", "/snapshot/create", {
      snapshot_type: "Full",
      snapshot_path: stateFile,
      mem_file_path: memFile,
      sync_snapshot_files: sync,
    });
    const ms = now() - t0;
    await this.kill();
    return { ms, memFile, stateFile };
  }

  /** Restore from the snapshot in this VM's directory (lazy, file-backed memory). */
  async restore(): Promise<{ loadMs: number }> {
    const t0 = now();
    await this.spawnVmm();
    await this.api("PUT", "/snapshot/load", {
      snapshot_path: `${this.dir}/vm.snap`,
      mem_backend: { backend_type: "File", backend_path: `${this.dir}/mem.snap` },
      resume_vm: true,
    });
    return { loadMs: now() - t0 };
  }

  async kill() {
    if (!this.proc) return;
    this.proc.kill("SIGKILL");
    await this.proc.exited;
    this.proc = undefined;
  }

  /** Drop this VM's snapshot and disk files from the host page cache. */
  evictFileCache() {
    for (const f of ["mem.snap", "vm.snap", "rootfs.ext4"]) {
      const p = `${this.dir}/${f}`;
      if (existsSync(p)) sh(`dd if=${p} iflag=nocache count=0 status=none`);
    }
  }

  /**
   * Ask the host kernel to push this VM's memory out of RAM.
   * zswap: compress it in RAM and keep it there (writeback to disk disabled for this VM).
   * disk:  bypass zswap and write it to the swap device.
   */
  reclaim(target: "zswap" | "disk") {
    writeFileSync(`${this.cgroup}/memory.zswap.max`, target === "zswap" ? "max" : "0");
    writeFileSync(`${this.cgroup}/memory.zswap.writeback`, target === "zswap" ? "0" : "1");
    const current = Number(readFileSync(`${this.cgroup}/memory.current`, "utf8"));
    try {
      writeFileSync(`${this.cgroup}/memory.reclaim`, String(current));
    } catch {
      // EAGAIN: the kernel reclaimed what it could; that is the measurement.
    }
  }

  memory(): MemorySample {
    const stat = Object.fromEntries(
      readFileSync(`${this.cgroup}/memory.stat`, "utf8")
        .trim()
        .split("\n")
        .map((l) => {
          const [k, v] = l.split(" ");
          return [k, Number(v)];
        }),
    ) as Record<string, number>;
    const current = Number(readFileSync(`${this.cgroup}/memory.current`, "utf8"));
    const swap = Number(readFileSync(`${this.cgroup}/memory.swap.current`, "utf8"));
    let rss = 0;
    let pss = 0;
    if (this.proc) {
      const rollup = readFileSync(`/proc/${this.proc.pid}/smaps_rollup`, "utf8");
      rss = Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) * 1024;
      pss = Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) * 1024;
    }
    const m = (b: number) => Math.round((b / MiB) * 10) / 10;
    return {
      currentMiB: m(current),
      anonMiB: m(stat.anon ?? 0),
      fileMiB: m(stat.file ?? 0),
      zswapMiB: m(stat.zswap ?? 0),
      zswappedMiB: m(stat.zswapped ?? 0),
      swapMiB: m(swap),
      rssMiB: m(rss),
      pssMiB: m(pss),
    };
  }

  diskUsageMiB(file: string): { apparentMiB: number; allocatedMiB: number } {
    const st = statSync(`${this.dir}/${file}`);
    return {
      apparentMiB: Math.round(st.size / MiB),
      allocatedMiB: Math.round((st.blocks * 512) / MiB),
    };
  }

  async destroy() {
    await this.kill();
    rmSync(this.dir, { recursive: true, force: true });
    try {
      rmdirSync(this.cgroup);
    } catch {
      // still busy or already gone
    }
  }
}

export function hostMemAvailableMiB(): number {
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  return Math.round(Number(/^MemAvailable:\s+(\d+)/m.exec(meminfo)?.[1] ?? 0) / 1024);
}

/** Host CPU busy fraction over an interval, from /proc/stat. */
export async function hostCpuBusy(intervalMs: number): Promise<number> {
  const read = () => {
    const f = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3]! + f[4]!;
    const total = f.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const a = read();
  await sleep(intervalMs);
  const b = read();
  return 1 - (b.idle - a.idle) / (b.total - a.total);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function summarize(values: number[]) {
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: values.length,
    p50: r(percentile(values, 50)),
    p90: r(percentile(values, 90)),
    p99: r(percentile(values, 99)),
    max: r(Math.max(...values)),
  };
}

export function record(file: string, row: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), host: hostLabel(), ...row });
  console.log(line);
  appendFileSync(`${LAB}/results/${file}.jsonl`, `${line}\n`);
}

export function hostLabel(): string {
  return process.env.LAB_HOST_LABEL ?? sh("hostname").trim();
}

/** A representative first command of an agent turn after a wake. */
export const PROBE =
  "cd /root/express && git status --short | wc -l && node -e \"const e=require('./');console.log(typeof e().listen)\"";

/** A representative agent turn: copy a repo, run its test suite, commit. */
export const WORKLOAD = [
  "set -e",
  "rm -rf /root/express && cp -a /opt/work/express /root/express && cd /root/express",
  "npm test </dev/null >/tmp/test.log 2>&1 || true",
  "tail -n 3 /tmp/test.log",
  "git add -A >/dev/null && git -c user.email=lab@example.com -c user.name=lab commit -qm wip --allow-empty",
  "echo workload-done",
].join("\n");

/** Optionally leave a dev server running, the case that keeps memory busy while idle. */
export const DEV_SERVER =
  "cd /opt/work/web && (setsid npx vite --host 0.0.0.0 --port 5173 </dev/null >/tmp/vite.log 2>&1 &) && sleep 4 && curl -s localhost:5173 | head -c 40; echo";

export const GUEST_DROP_CACHES = "sync && echo 3 > /proc/sys/vm/drop_caches && echo dropped";
