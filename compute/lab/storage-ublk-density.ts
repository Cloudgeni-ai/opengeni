// Device/daemon density, not 1,000 running guests. Requires a disposable host
// configured with enough ublk devices and an existing directory of scratch files.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sh, now } from "./fc";
const directory = process.argv[2];
const count = Number(process.argv[3] ?? 1000);
if (!directory?.startsWith("/lab/") || !Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("invalid scratch directory/count");
const created: number[] = [];
const times: number[] = [];
const pids: string[] = [];
let rssKiB = 0, pssKiB = 0, threads = 0;
const memBefore = readFileSync("/proc/meminfo", "utf8");
try {
  for (let i = 0; i < count; i++) {
    if (existsSync(`/dev/ublkb${i}`)) throw new Error(`device ${i} already exists`);
    const start = now();
    sh(`/usr/local/sbin/ublk add -t loop -n ${i} -f ${directory}/${i}`);
    times.push(now() - start); created.push(i);
    const info = sh(`/usr/local/sbin/ublk list -n ${i}`);
    const pid = /daemon pid (\d+)/.exec(info)?.[1];
    if (!pid) throw new Error("missing daemon pid");
    pids.push(pid);
  }
  for (const pid of pids) {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const memory = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    rssKiB += Number(/^Rss:\s+(\d+)/m.exec(memory)?.[1] ?? 0);
    pssKiB += Number(/^Pss:\s+(\d+)/m.exec(memory)?.[1] ?? 0);
    threads += Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 0);
  }
  times.sort((a, b) => a - b);
  const result = { count, createMs: times.reduce((a,b) => a+b, 0), p50Ms: times[Math.floor(count / 2)], p99Ms: times[Math.floor(count * .99)], rssKiB, pssKiB, threads, memBefore, memAfter: readFileSync("/proc/meminfo", "utf8"), note: "one loop-target daemon and default queue per device; no guest writers; final PSS sweep" };
  writeFileSync("/lab/storage/analysis/density-ublk.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const id of created.reverse()) sh(`/usr/local/sbin/ublk del -n ${id}`);
}
