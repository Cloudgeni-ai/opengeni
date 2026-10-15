// One sandbox, every sleep level: how much RAM it keeps while asleep and how long
// the first command takes after waking.
//
//   sudo bun exp-single.ts [plain|devserver] [levels...]
//
// Levels:
//   L0 running        never slept; baseline command latency
//   L1 paused         vCPUs stopped, memory untouched
//   L2 zswap          paused, then the host compresses the VM's memory in RAM
//   L3 swap           paused, then the host writes the VM's memory to local NVMe
//   L4 snapshot       full snapshot to local NVMe, VMM process exits (0 RAM);
//                     woken with lazy file-backed restore, with a warm and a cold
//                     host page cache
import {
  DEV_SERVER,
  GUEST_DROP_CACHES,
  PROBE,
  Vm,
  WORKLOAD,
  ensureCgroupRoot,
  hostLabel,
  now,
  record,
  sleep,
} from "./fc";

const profile = process.argv[2] ?? "plain";
const levels = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["L0", "L1", "L2", "L3", "L4"];
const memMib = Number(process.env.MEM_MIB ?? 2048);
const reps = Number(process.env.REPS ?? 3);
const idleBeforeSleepMs = Number(process.env.IDLE_MS ?? 8000);
const FILE = "single";

ensureCgroupRoot();
console.error(`host ${hostLabel()} profile ${profile} levels ${levels.join(",")}`);

async function guestMem(vm: Vm) {
  const r = await vm.exec("grep -E '^(MemTotal|MemFree|Cached|AnonPages|Shmem):' /proc/meminfo | awk '{printf \"%s%d \", $1, $2/1024}'");
  return r.out.trim();
}

/** Boot a fresh sandbox and bring it to the idle state an agent turn leaves behind. */
async function prepared(name: string): Promise<Vm> {
  const vm = new Vm(`${name}-${profile}`);
  const bootMs = await vm.boot({ memMib });
  const w = await vm.exec(WORKLOAD);
  if (!w.out.includes("workload-done")) throw new Error(`workload failed: ${w.out.slice(-500)}`);
  let dev = "";
  if (profile === "devserver") dev = (await vm.exec(DEV_SERVER)).out.trim();
  await sleep(3000);
  const afterWorkload = vm.memory();
  await vm.exec(GUEST_DROP_CACHES);
  await sleep(idleBeforeSleepMs); // let free page reporting hand freed pages back
  record(FILE, {
    profile,
    vm: vm.id,
    step: "prepared",
    bootMs: Math.round(bootMs),
    workloadMs: Math.round(w.ms),
    workloadTail: w.out.trim().split("\n").slice(-3).join(" | "),
    dev,
    memAfterWorkload: afterWorkload,
    memAfterGuestReclaim: vm.memory(),
    guest: await guestMem(vm),
  });
  return vm;
}

async function probe(vm: Vm) {
  const r = await vm.exec(PROBE);
  if (!r.out.includes("function")) throw new Error(`probe failed on ${vm.id}: ${r.out}`);
  return r;
}

for (const level of levels) {
  const vm = await prepared(level.toLowerCase());
  try {
    if (level === "L0") {
      for (let i = 0; i < reps; i++) {
        const r = await probe(vm);
        record(FILE, { profile, level, rep: i, wakeMs: 0, firstByteMs: r.firstByteMs, commandMs: r.ms, totalMs: r.ms });
        await sleep(1000);
      }
    } else if (level === "L1" || level === "L2" || level === "L3") {
      await probe(vm); // warm the guest's own caches the way a previous turn would
      for (let i = 0; i < reps; i++) {
        await vm.pause();
        if (level === "L2") vm.reclaim("zswap");
        if (level === "L3") vm.reclaim("disk");
        await sleep(1500);
        const asleep = vm.memory();
        const t0 = now();
        await vm.resume();
        const resumeMs = now() - t0;
        const r = await probe(vm);
        const totalMs = now() - t0;
        record(FILE, {
          profile,
          level,
          rep: i,
          memAsleep: asleep,
          wakeMs: resumeMs,
          firstByteMs: r.firstByteMs,
          commandMs: r.ms,
          totalMs,
          memAfterWake: vm.memory(),
        });
      }
    } else if (level === "L4") {
      await probe(vm);
      for (let i = 0; i < reps; i++) {
        for (const cache of ["warm", "cold"] as const) {
          const snap = await vm.snapshotAndStop(true);
          const sizes = { mem: vm.diskUsageMiB("mem.snap"), state: vm.diskUsageMiB("vm.snap") };
          if (cache === "cold") vm.evictFileCache();
          const t0 = now();
          const { loadMs } = await vm.restore();
          const r = await probe(vm);
          const totalMs = now() - t0;
          record(FILE, {
            profile,
            level: `L4-${cache}`,
            rep: i,
            snapshotMs: Math.round(snap.ms),
            sizes,
            wakeMs: loadMs,
            firstByteMs: r.firstByteMs,
            commandMs: r.ms,
            totalMs,
            memAfterWake: vm.memory(),
          });
        }
      }
    }
  } finally {
    await vm.destroy();
  }
}
