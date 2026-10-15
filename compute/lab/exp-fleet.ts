// Many sandboxes on one host: density, idle CPU, and what happens when they all
// wake at the same moment.
//
//   sudo bun exp-fleet.ts <count> [plain|devserver] [levels...]
//
// Levels as in exp-single.ts (L1 paused, L2 zswap, L3 swap, L4 snapshot).
import {
  DEV_SERVER,
  GUEST_DROP_CACHES,
  PROBE,
  Vm,
  WORKLOAD,
  ensureCgroupRoot,
  hostCpuBusy,
  hostLabel,
  hostMemAvailableMiB,
  now,
  record,
  sh,
  sleep,
  summarize,
} from "./fc";

const count = Number(process.argv[2] ?? 100);
const profile = process.argv[3] ?? "plain";
const levels = process.argv.slice(4).length > 0 ? process.argv.slice(4) : ["L1", "L2", "L3", "L4"];
const memMib = Number(process.env.MEM_MIB ?? 2048);
const bootConcurrency = Number(process.env.BOOT_CONCURRENCY ?? 16);
const workConcurrency = Number(process.env.WORK_CONCURRENCY ?? 16);
const FILE = "fleet";

ensureCgroupRoot();
console.error(`host ${hostLabel()} fleet ${count} profile ${profile} levels ${levels.join(",")}`);

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function totals(vms: Vm[]) {
  const sum = { currentMiB: 0, anonMiB: 0, fileMiB: 0, zswapMiB: 0, zswappedMiB: 0, swapMiB: 0 };
  for (const vm of vms) {
    const m = vm.memory();
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += m[k];
  }
  const per = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round((v / vms.length) * 10) / 10]));
  return { total: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v)])), perVm: per };
}

const memBefore = hostMemAvailableMiB();
const vms = Array.from({ length: count }, (_, i) => new Vm(`fleet-${String(i).padStart(3, "0")}`));

const bootTimes: number[] = [];
const tBoot = now();
await pool(vms, bootConcurrency, async (vm) => {
  bootTimes.push(await vm.boot({ memMib }));
});
record(FILE, { count, profile, step: "boot", wallMs: Math.round(now() - tBoot), bootMs: summarize(bootTimes) });

const workTimes: number[] = [];
const tWork = now();
await pool(vms, workConcurrency, async (vm) => {
  const r = await vm.exec(WORKLOAD);
  if (!r.out.includes("workload-done")) throw new Error(`${vm.id} workload failed: ${r.out.slice(-300)}`);
  if (profile === "devserver") await vm.exec(DEV_SERVER);
  await vm.exec(GUEST_DROP_CACHES);
  workTimes.push(r.ms);
});
await sleep(10_000);
record(FILE, {
  count,
  profile,
  step: "idle-running",
  wallMs: Math.round(now() - tWork),
  workloadMs: summarize(workTimes),
  memory: totals(vms),
  hostMemUsedMiB: memBefore - hostMemAvailableMiB(),
  hostCpuBusyIdleVms: Math.round((await hostCpuBusy(20_000)) * 1000) / 1000,
});

// Warm the first-command path once, as an earlier turn would have.
await Promise.all(vms.map((vm) => vm.exec(PROBE)));

for (const level of levels) {
  const tSleep = now();
  let storedMiB: number | undefined;
  if (level === "L4") {
    let total = 0;
    await pool(vms, 16, async (vm) => {
      await vm.snapshotAndStop(true);
      // Drop the zero pages Firecracker wrote out; only real guest memory stays on disk.
      sh(`fallocate --dig-holes ${vm.dir}/mem.snap`);
      total += vm.diskUsageMiB("mem.snap").allocatedMiB;
      vm.evictFileCache();
    });
    storedMiB = Math.round(total / vms.length);
  } else {
    await Promise.all(vms.map((vm) => vm.pause()));
    if (level === "L2") await pool(vms, 8, async (vm) => vm.reclaim("zswap"));
    if (level === "L3") await pool(vms, 8, async (vm) => vm.reclaim("disk"));
  }
  const sleepMs = now() - tSleep;
  await sleep(2000);
  const asleep = totals(vms);
  const hostAsleep = memBefore - hostMemAvailableMiB();

  const t0 = now();
  const results = await Promise.all(
    vms.map(async (vm) => {
      const s = now();
      if (level === "L4") await vm.restore();
      else await vm.resume();
      const woke = now() - s;
      const r = await vm.exec(PROBE);
      if (!r.out.includes("function")) throw new Error(`${vm.id} probe failed: ${r.out}`);
      return { wakeMs: woke, totalMs: now() - s };
    }),
  );
  const wallMs = now() - t0;
  record(FILE, {
    count,
    profile,
    level,
    sleepWallMs: Math.round(sleepMs),
    memFilePerVmMiB: storedMiB,
    memoryAsleep: asleep,
    hostMemUsedAsleepMiB: hostAsleep,
    wakeMs: summarize(results.map((r) => r.wakeMs)),
    wakeToCommandDoneMs: summarize(results.map((r) => r.totalMs)),
    allAwakeWallMs: Math.round(wallMs),
    memoryAfterWake: totals(vms),
  });
}

await pool(vms, 32, async (vm) => vm.destroy());
