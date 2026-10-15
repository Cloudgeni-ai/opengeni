// Cold object-backed disk AND memory. Kernel NBD supplies file-mapping faults;
// this deliberately does not replace the separately developed userfaultfd pager.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LAB, sh, now, sleep } from "./fc";

const root = `${LAB}/storage/lazy`;
const run = `${root}/run-${Date.now()}`;
mkdirSync(run);
const daemons: Bun.Subprocess[] = [];
const attached: string[] = [];
let memoryMounted = false;
const start = now();
const startEpochMs = Date.now();
try {
  if (process.env.FETCH_MANIFESTS === "1") {
    await Promise.all(["disk", "memory", "state"].map(async name => {
      const packing = JSON.parse(readFileSync(`${root}/${name === "memory" ? "memory-fs" : name}-pack.json`, "utf8"));
      const proc = Bun.spawn([`${LAB}/storage/rust/target/release/storage-fetch`, "gcs", process.env.OBJECT_PREFIX ?? "storage-lazy", packing.manifest_digest, `${run}/${name === "state" ? "vm.snap" : `${name}.json`}`, ...(name === "state" ? ["--image"] : [])], { stdout: "pipe", stderr: "pipe" });
      if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
    }));
  }
  await Promise.all(["disk", "memory"].map(async (name, index) => {
    const device = `/dev/nbd${index}`;
    if (existsSync(`/sys/block/nbd${index}/pid`)) throw new Error(`${device} already attached`);
    const socket = `${run}/${name}.sock`;
    const daemon = Bun.spawn([`${LAB}/storage/rust/target/release/storage-nbd`, "gcs", process.env.OBJECT_PREFIX ?? "storage-lazy", `${process.env.FETCH_MANIFESTS === "1" ? run : root}/${name}.json`, socket, `${run}/${name}.cow`], {
      env: { ...process.env, STORAGE_TRACE: "1", ...(process.env.PREFETCH === "1" ? { STORAGE_PREFETCH: `${root}/${name}-prefetch.json` } : {}), ...(process.env.PREFETCH_BACKGROUND === "1" ? { STORAGE_PREFETCH_BACKGROUND: `${root}/${name}-background.json` } : {}) }, stdout: Bun.file(`${run}/${name}.log`), stderr: Bun.file(`${run}/${name}.err`),
    });
    daemons.push(daemon);
    for (let i = 0; i < 6000 && !existsSync(socket); i++) await sleep(5);
    if (!existsSync(socket)) throw new Error(readFileSync(`${run}/${name}.err`, "utf8"));
    sh(`nbd-client -unix ${socket} ${device}`);
    attached.push(device);
    sh(`blockdev --setra 0 ${device}`);
  }));
  mkdirSync(`${run}/memory`);
  sh(`mount -o ro,noload /dev/nbd1 ${run}/memory`);
  memoryMounted = true;
  const setupMs = now() - start;
  const child = Bun.spawn(["bun", `${LAB}/storage-cross.ts`, "restore", "T2"], {
    env: { ...process.env, DISK_BACKEND: "/dev/nbd0", MEMORY_BACKEND: `${run}/memory/mem.snap`, ...(process.env.FETCH_MANIFESTS === "1" ? { STATE_BACKEND: `${run}/vm.snap` } : {}) }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  const totalMs = now() - start;
  const parsed = JSON.parse(stdout);
  const row = { setupMs, totalMs, firstByteFromStartMs: parsed.firstByteEpochMs - startEpochMs, exitCode, stdout, stderr };
  writeFileSync(`${run}/result.json`, JSON.stringify(row, null, 2));
  console.log(JSON.stringify(row));
} finally {
  if (memoryMounted) {
    let unmounted = false;
    for (let i = 0; i < 20; i++) {
      const result = Bun.spawnSync(["umount", `${run}/memory`], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode === 0) { unmounted = true; break; }
      await sleep(100);
    }
    if (!unmounted) throw new Error("memory mount remains busy; backing devices retained for recovery");
  }
  for (const device of attached.reverse()) sh(`nbd-client -d ${device}`);
  for (const daemon of daemons) { daemon.kill(); await daemon.exited; }
}
