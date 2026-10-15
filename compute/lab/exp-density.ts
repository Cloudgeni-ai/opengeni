// How many sleeping sandboxes fit on one host, and what waking some of them costs
// while the rest stay asleep.
//
//   sudo bun exp-density.ts <count> [L2|L3] [wakeCount]
//
// Each sandbox boots, runs one representative agent turn, goes idle, and is put to
// sleep at the chosen level before the next ones start, so the host never holds
// more than a handful of awake sandboxes. Stops early if host memory runs low.
import {
  GUEST_DROP_CACHES,
  PROBE,
  Vm,
  WORKLOAD,
  ensureCgroupRoot,
  hostCpuBusy,
  hostMemAvailableMiB,
  now,
  record,
  sleep,
  summarize,
} from "./fc";

const target = Number(process.argv[2] ?? 1000);
const level = (process.argv[3] ?? "L2") as "L2" | "L3";
const wakeCount = Number(process.argv[4] ?? 100);
const concurrency = Number(process.env.CONCURRENCY ?? 16);
const reserveMiB = Number(process.env.RESERVE_MIB ?? 24 * 1024);
const FILE = "density";

ensureCgroupRoot();
const memStart = hostMemAvailableMiB();
const asleep: Vm[] = [];
let started = 0;
let stopReason = "target reached";
const t0 = now();

function snapshot(step: string) {
  let current = 0;
  let zswap = 0;
  let swap = 0;
  for (const vm of asleep) {
    const m = vm.memory();
    current += m.currentMiB;
    zswap += m.zswapMiB;
    swap += m.swapMiB;
  }
  const hostUsed = memStart - hostMemAvailableMiB();
  record(FILE, {
    level,
    step,
    asleep: asleep.length,
    elapsedS: Math.round((now() - t0) / 1000),
    hostMemUsedMiB: hostUsed,
    hostMemUsedPerSandboxMiB: asleep.length ? Math.round((hostUsed / asleep.length) * 10) / 10 : null,
    cgroupPerSandboxMiB: asleep.length ? Math.round((current / asleep.length) * 10) / 10 : null,
    zswapPerSandboxMiB: asleep.length ? Math.round((zswap / asleep.length) * 10) / 10 : null,
    swapPerSandboxMiB: asleep.length ? Math.round((swap / asleep.length) * 10) / 10 : null,
  });
}

async function onePass(vm: Vm) {
  await vm.boot();
  const r = await vm.exec(WORKLOAD);
  if (!r.out.includes("workload-done")) throw new Error(`${vm.id} workload failed: ${r.out.slice(-300)}`);
  await vm.exec(PROBE);
  await vm.exec(GUEST_DROP_CACHES);
  await sleep(5000); // let free page reporting hand freed memory back
  await vm.pause();
  vm.reclaim(level === "L2" ? "zswap" : "disk");
  vm.evictFileCache();
  asleep.push(vm);
}

let lastReport = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (started < target && stopReason === "target reached") {
    if (hostMemAvailableMiB() < reserveMiB) {
      stopReason = `host memory available fell below ${reserveMiB} MiB`;
      break;
    }
    const vm = new Vm(`dens-${String(started++).padStart(4, "0")}`);
    try {
      await onePass(vm);
    } catch (err) {
      console.error(`${vm.id}: ${err}`);
      await vm.destroy();
    }
    if (asleep.length - lastReport >= 100) {
      lastReport = asleep.length;
      snapshot("filling");
    }
  }
});
await Promise.all(workers);
await sleep(3000);
snapshot("full");
record(FILE, { level, step: "stop", reason: stopReason, started, asleep: asleep.length });

// A host full of sleeping sandboxes should cost close to no CPU.
record(FILE, { level, step: "idle-cpu", asleep: asleep.length, hostCpuBusy: Math.round((await hostCpuBusy(20_000)) * 1000) / 1000 });

// Wake a random subset at the same instant while the rest stay asleep.
const pick = [...asleep].sort(() => Math.random() - 0.5).slice(0, wakeCount);
const tw = now();
const results = await Promise.all(
  pick.map(async (vm) => {
    const s = now();
    await vm.resume();
    const r = await vm.exec(PROBE);
    if (!r.out.includes("function")) throw new Error(`${vm.id} probe failed: ${r.out}`);
    return { totalMs: now() - s, firstByteMs: r.firstByteMs };
  }),
);
record(FILE, {
  level,
  step: "wake",
  asleep: asleep.length,
  woken: pick.length,
  firstByteMs: summarize(results.map((r) => r.firstByteMs)),
  wakeToCommandDoneMs: summarize(results.map((r) => r.totalMs)),
  allAwakeWallMs: Math.round(now() - tw),
});

const all = asleep.splice(0);
let i = 0;
await Promise.all(
  Array.from({ length: 32 }, async () => {
    while (i < all.length) await all[i++]!.destroy();
  }),
);
