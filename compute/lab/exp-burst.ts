// Why do many simultaneous wakes take so long when one wake is fast?
//
//   sudo bun exp-burst.ts [vmCount] [levels...]     (default 100, L2 L4 L4w)
//
// Separates three suspects by sweeping how many VMs act at the same moment:
//   cpu    pure computation, which a hypervisor barely touches
//   touch  writing fresh memory, so every page needs a new host mapping
//   exit   a tight CPUID loop: every iteration is one round trip guest -> hypervisor -> guest,
//          so this prices a single VM exit on this host (plain KVM or KVM inside a cloud VM)
//   wake   sleeping at a level and waking, then running the first command
// L4w is L4 with the snapshot left in the host page cache, so no disk reads.
// Host CPU time is split by /proc/stat category for every step.
// Where the host exposes KVM statistics in debugfs, exits seen by this host's KVM are
// counted per VM for every step.
//
// Environment:
//   BURST_TESTS       comma list of cpu,touch,exit,wake (default all)
//   BURST_FILE        results file name (default burst)
//   BURST_EXIT_LOOPS  CPUID iterations per exit measurement (default 50000)
import { existsSync, readFileSync } from "node:fs";
import {
  GUEST_DROP_CACHES,
  PROBE,
  Vm,
  WORKLOAD,
  ensureCgroupRoot,
  now,
  record,
  sleep,
  summarize,
} from "./fc";

const count = Number(process.argv[2] ?? 100);
const levels = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["L2", "L4", "L4w"];
const FILE = process.env.BURST_FILE ?? "burst";
const TESTS = new Set((process.env.BURST_TESTS ?? "cpu,touch,exit,wake").split(","));
const EXIT_LOOPS = Number(process.env.BURST_EXIT_LOOPS ?? 50_000);
const CPU = "node -e 'let x=0;for(let i=0;i<4e8;i++)x+=i%7;console.log(x>0)'";
const TOUCH = "head -c 512M /dev/zero > /dev/shm/t && rm /dev/shm/t && echo touched";
// x86-64: push rbx; mov rcx,rdi; loop { xor eax,eax; push rcx; cpuid; pop rcx; dec rcx; jnz }; pop rbx; ret
const EXIT_CODE = "534889f931c0510fa25948ffc975f55bc3";
const EXIT = [
  `python3 -c "import mmap,ctypes,time`,
  `m=mmap.mmap(-1,4096,prot=7)`,
  `m.write(bytes.fromhex('${EXIT_CODE}'))`,
  `f=ctypes.CFUNCTYPE(None,ctypes.c_uint64)(ctypes.addressof(ctypes.c_char.from_buffer(m)))`,
  `f(1000)`,
  `t=time.perf_counter()`,
  `f(${EXIT_LOOPS})`,
  `print('exit_us=%.3f'%((time.perf_counter()-t)/${EXIT_LOOPS}*1e6))"`,
].join(";");

ensureCgroupRoot();

const KVM_DEBUGFS = "/sys/kernel/debug/kvm";
const KVM_COUNTERS = [
  "exits",
  "pf_taken",
  "pf_fixed",
  "pf_emulate",
  "pf_spurious",
  "halt_exits",
  "halt_wakeup",
  "irq_exits",
  "io_exits",
  "mmio_exits",
  "insn_emulation",
  "tlb_flush",
  "remote_tlb_flush",
  "mmu_shadow_zapped",
  "mmu_pte_write",
  "mmu_cache_miss",
];

function kvmCounters(): Record<string, number> | undefined {
  if (!existsSync(KVM_DEBUGFS)) return undefined;
  const out: Record<string, number> = {};
  for (const name of KVM_COUNTERS) {
    try {
      out[name] = Number(readFileSync(`${KVM_DEBUGFS}/${name}`, "utf8"));
    } catch {
      // Counter not present on this kernel.
    }
  }
  return out;
}

function perVm(a: Record<string, number> | undefined, b: Record<string, number> | undefined, n: number) {
  if (!a || !b) return undefined;
  return Object.fromEntries(
    Object.keys(b)
      .filter((k) => a[k] !== undefined)
      .map((k) => [k, Math.round((b[k]! - a[k]!) / n)]),
  );
}

function cpuTicks(): number[] {
  return readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
}

/** Share of host CPU time per category between two /proc/stat samples. */
function cpuSplit(a: number[], b: number[]) {
  const d = b.map((v, i) => v - a[i]!);
  // On Linux "user" already includes time spent running guests; split it out.
  const total = d.slice(0, 8).reduce((x, y) => x + y, 0);
  const parts: Record<string, number> = {
    hostUser: d[0]! - d[8]!,
    guest: d[8]!,
    system: d[2]!,
    softirq: d[6]!,
    iowait: d[4]!,
    steal: d[7]!,
    idle: d[3]!,
  };
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000]));
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

async function together(
  vms: Vm[],
  fn: (vm: Vm) => Promise<{ ms: number; firstByteMs?: number; exitUs?: number }>,
) {
  const a = cpuTicks();
  const ka = kvmCounters();
  const t0 = now();
  const r = await Promise.all(vms.map(fn));
  const wallMs = Math.round(now() - t0);
  const cpu = cpuSplit(a, cpuTicks());
  const kvm = perVm(ka, kvmCounters(), vms.length);
  return {
    n: vms.length,
    wallMs,
    ms: summarize(r.map((x) => x.ms)),
    firstByteMs: r[0]?.firstByteMs === undefined ? undefined : summarize(r.map((x) => x.firstByteMs!)),
    exitUs: r[0]?.exitUs === undefined ? undefined : summarize(r.map((x) => x.exitUs!)),
    cpu,
    kvmPerVm: kvm,
  };
}

const vms = Array.from({ length: count }, (_, i) => new Vm(`burst-${String(i).padStart(3, "0")}`));
await pool(vms, 16, async (vm) => {
  await vm.boot();
});
await pool(vms, 16, async (vm) => {
  const r = await vm.exec(WORKLOAD);
  if (!r.out.includes("workload-done")) throw new Error(`${vm.id} workload failed`);
  await vm.exec(GUEST_DROP_CACHES);
});
await sleep(10_000);
await Promise.all(vms.map((vm) => vm.exec(PROBE)));

const sizes = [1, 4, 8, 16, 32, 64, 100].filter((n) => n <= count);
for (const [name, script, check] of [
  ["cpu", CPU, "true"],
  ["touch", TOUCH, "touched"],
] as const) {
  if (!TESTS.has(name)) continue;
  for (const n of sizes) {
    const res = await together(vms.slice(0, n), async (vm) => {
      const r = await vm.exec(script);
      if (!r.out.includes(check)) throw new Error(`${vm.id} ${name} failed: ${r.out}`);
      return { ms: r.ms };
    });
    record(FILE, { test: name, ...res });
  }
}

if (TESTS.has("exit")) {
  for (const n of sizes) {
    const res = await together(vms.slice(0, n), async (vm) => {
      const r = await vm.exec(EXIT);
      const m = /exit_us=([0-9.]+)/.exec(r.out);
      if (!m) throw new Error(`${vm.id} exit failed: ${r.out}`);
      return { ms: r.ms, exitUs: Number(m[1]) };
    });
    record(FILE, { test: "exit", loops: EXIT_LOOPS, ...res });
  }
}

for (const level of TESTS.has("wake") ? levels : []) {
  for (const n of [1, 10, 25, 50, 100].filter((x) => x <= count)) {
    const group = vms.slice(0, n);
    if (level === "L2") {
      await Promise.all(group.map((vm) => vm.pause()));
      for (const vm of group) vm.reclaim("zswap");
    } else {
      await pool(group, 16, async (vm) => {
        await vm.snapshotAndStop(true);
        if (level === "L4") vm.evictFileCache();
      });
    }
    await sleep(2000);
    const res = await together(group, async (vm) => {
      const s = now();
      if (level === "L2") await vm.resume();
      else await vm.restore();
      const r = await vm.exec(PROBE);
      if (!r.out.includes("function")) throw new Error(`${vm.id} probe failed: ${r.out}`);
      return { ms: now() - s, firstByteMs: r.firstByteMs };
    });
    record(FILE, { test: `wake-${level}`, ...res });
  }
}

await pool(vms, 32, async (vm) => vm.destroy());
