// Controlled host zswap tuning on disposable lab hosts only. Restores sysctls.
// Usage: bun wake-l2.ts COUNT ROUNDS [zstd:3:7,lz4:0:7,zstd:0:7,zstd:3:0]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { PROBE, ensureCgroupRoot, now, sleep, record, summarize } from "./fc";
import { TimedVm } from "./wake-vm";
import { measuredExec } from "./wake-exec";

const count = Number(process.argv[2] ?? 1);
const rounds = Number(process.argv[3] ?? 5);
const reclaimConcurrency = Number(process.env.WAKE_RECLAIM_CONCURRENCY ?? 8);
const variants = (process.argv[4] ?? "zstd:3:7,zstd:0:7,lz4:0:7,zstd:3:0").split(",");
const output = process.env.WAKE_RESULT ?? "wake-l2";
const prefix = process.env.WAKE_PREFIX ?? "wake-l2";
const paths = ["/sys/module/zswap/parameters/compressor", "/proc/sys/vm/page-cluster", "/sys/kernel/mm/lru_gen/enabled"];
const original = paths.map((p) => existsSync(p) ? readFileSync(p, "utf8").trim() : undefined);
if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("invalid prefix");
if (![count, rounds, reclaimConcurrency].every((n) => Number.isInteger(n) && n > 0)) throw new Error("positive counts required");

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let index = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = index++; if (i >= items.length) return; out[i] = await fn(items[i]!); }
  }));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return out;
}

ensureCgroupRoot();
let vms: TimedVm[] = [];
record(output, { event: "original-settings", paths, original, count, rounds });
try {
  for (const variant of variants) {
    const settings = variant.split(":");
    if (settings.length !== 3) throw new Error("variant must be compressor:page-cluster:MGLRU");
    try {
      paths.forEach((p, i) => { if (original[i] !== undefined) writeFileSync(p, settings[i]!); });
    } catch (error) {
      record(output, { event: "unsupported", variant, error: String(error) });
      continue;
    }
    vms = Array.from({ length: count }, (_, i) => new TimedVm(`${prefix}-${variant.replace(/[^a-z0-9-]/g, "-")}-${i}`));
    await pool(vms, 8, async (vm) => {
      await vm.boot();
      await vm.exec("cp -a /opt/work/express /root/express && sync && echo 3 > /proc/sys/vm/drop_caches");
      await sleep(5000);
      await vm.exec(PROBE);
    });
    for (let round = 0; round < rounds; round++) {
      await Promise.all(vms.map((vm) => vm.pause()));
      const reclaimStarted = now();
      if (process.env.WAKE_SKIP_RECLAIM !== "1") await pool(vms, reclaimConcurrency, async (vm) => {
        await writeFile(`${vm.cgroup}/memory.zswap.max`, "max");
        await writeFile(`${vm.cgroup}/memory.zswap.writeback`, "0");
        try { await writeFile(`${vm.cgroup}/memory.reclaim`, readFileSync(`${vm.cgroup}/memory.current`, "utf8")); }
        catch (error) { if ((error as { code?: string }).code !== "EAGAIN") throw error; }
      });
      const reclaimMs = now() - reclaimStarted;
      await sleep(2000);
      const asleep = vms.map((vm) => vm.memory());
      const started = now();
      const values = await Promise.all(vms.map(async (vm) => {
        const begin = now();
        await vm.resume();
        const commandStart = now();
        const probe = await measuredExec(vm.vsock, PROBE);
        if (!probe.out.includes("function") || probe.status !== 0) throw new Error("probe failed");
        return { totalMs: now() - begin, firstByteMs: commandStart - begin + probe.firstByteMs, commandMs: probe.ms,
          commandCompleteMs: commandStart - begin + probe.doneMs, observedCommandMs: probe.doneMs, transportTailMs: probe.ms - probe.doneMs };
      }));
      record(output, { event: "wake", variant, count, round, wallMs: now() - started,
        level: process.env.WAKE_SKIP_RECLAIM === "1" ? "L1-paused" : "L2-zswap",
        reclaimMs, reclaimConcurrency,
        measurement: "guest-completion-marker-and-eof", commandCompleteMs: summarize(values.map((x) => x.commandCompleteMs)),
        freshVmsPerVariant: true,
        totalMs: summarize(values.map((x) => x.totalMs)), firstByteMs: summarize(values.map((x) => x.firstByteMs)),
        sleepingMiB: summarize(asleep.map((m) => m.currentMiB)),
        zswapMiB: summarize(asleep.map((m) => m.zswapMiB)), asleep, values });
    }
    await pool(vms, 16, (vm) => vm.destroy());
    vms = [];
  }
} finally {
  await Promise.allSettled(vms.map((vm) => vm.kill()));
  paths.forEach((p, i) => { if (original[i] !== undefined) writeFileSync(p, original[i]!); });
}
