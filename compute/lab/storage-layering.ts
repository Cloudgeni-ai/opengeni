// Isolated disk-layer comparison. Run as root on a disposable prepared lab host.
// Each guest boots the same independent root disk and benchmarks /work only.
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, openSync, fsyncSync, closeSync } from "node:fs";
import { Vm, LAB, sh, sleep, now, ensureCgroupRoot } from "./fc";

const ROOT = process.env.STORAGE_ROOT ?? `${LAB}/storage`;
const mode = process.argv[2] ?? "reflink";
if (!["reflink", "thin", "overlay", "nbd", "ublk"].includes(mode)) throw new Error("unknown mode");
const dir = `${ROOT}/${mode}`;
if (existsSync(`${dir}/results.json`)) throw new Error("results already exist; use a fresh STORAGE_ROOT");
mkdirSync(dir, { recursive: true });
const rows: unknown[] = [];
function save(row: object) {
  rows.push(row);
  writeFileSync(`${dir}/results.json`, JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(row));
}
const vm = new Vm(`storage-${mode}`);
ensureCgroupRoot();
mkdirSync(vm.dir, { recursive: true });
mkdirSync(vm.cgroup, { recursive: true });
sh(`cp --reflink=always ${LAB}/base.ext4 ${vm.dir}/rootfs.ext4`);
let disk = `${dir}/data.ext4`;
const tCreate = now();
if (mode === "thin") {
  // Only fresh, task-owned files/devices; never reuse an existing pool.
  if (existsSync("/dev/mapper/storage-pool")) throw new Error("pool already exists");
  sh(`truncate -s 128M ${dir}/meta; truncate -s 20G ${dir}/pool`);
  const meta = sh(`losetup --find --show ${dir}/meta`).trim();
  const data = sh(`losetup --find --show ${dir}/pool`).trim();
  const origin = sh(`losetup --read-only --find --show ${ROOT}/data-base.ext4`).trim();
  writeFileSync(`${dir}/loops.json`, JSON.stringify({ meta, data, origin }));
  sh(`dmsetup create storage-pool --table '0 41943040 thin-pool ${meta} ${data} 128 0 1 skip_block_zeroing'`);
  sh("dmsetup message storage-pool 0 'create_thin 1'");
  sh(`dmsetup create storage-data --table '0 8388608 thin /dev/mapper/storage-pool 1 ${origin}'`);
  disk = "/dev/mapper/storage-data";
} else {
  sh(`cp --reflink=always ${ROOT}/data-base.ext4 ${disk}`);
}
save({ mode, operation: "initial-create", ms: now() - tCreate });
if (mode === "nbd") {
  sh(`nbdkit --unix ${dir}/nbd.sock --pidfile ${dir}/nbd.pid file ${disk} --run 'nbd-client -unix ${dir}/nbd.sock /dev/nbd0; sleep 7200' >${dir}/nbd.log 2>&1 &`);
  for (let i = 0; i < 100 && !existsSync(`${dir}/nbd.pid`); i++) await sleep(20);
  await sleep(500);
  disk = "/dev/nbd0";
}
if (mode === "ublk") {
  if (existsSync("/dev/ublkb0")) throw new Error("ublk device 0 already exists");
  sh(`/usr/local/sbin/ublk add -t loop -f ${disk}`);
  disk = "/dev/ublkb0";
}
vm.proc = Bun.spawn([`${LAB}/bin/firecracker`, "--api-sock", vm.apiSock], {
  stdout: Bun.file(`${dir}/console.log`), stderr: Bun.file(`${dir}/vmm.log`),
});
writeFileSync(`${vm.cgroup}/cgroup.procs`, String(vm.pid));
for (let i = 0; i < 1000 && !existsSync(vm.apiSock); i++) await sleep(5);
await vm.api("PUT", "/boot-source", { kernel_image_path: `${LAB}/vmlinux`, boot_args: "console=ttyS0 reboot=k panic=1 quiet" });
await vm.api("PUT", "/machine-config", { vcpu_count: 2, mem_size_mib: 2048, smt: false });
await vm.api("PUT", "/drives/root", { drive_id: "root", path_on_host: `${vm.dir}/rootfs.ext4`, is_root_device: true, is_read_only: false, cache_type: "Writeback" });
await vm.api("PUT", "/drives/data", { drive_id: "data", path_on_host: mode === "overlay" ? `${ROOT}/data-base.ext4` : disk, is_root_device: false, is_read_only: mode === "overlay", cache_type: "Writeback" });
if (mode === "overlay") {
  await vm.api("PUT", "/drives/upper", { drive_id: "upper", path_on_host: disk, is_root_device: false, is_read_only: false, cache_type: "Writeback" });
}
await vm.api("PUT", "/vsock", { guest_cid: 3, uds_path: vm.vsock });
await vm.api("PUT", "/actions", { action_type: "InstanceStart" });
await vm.waitAgent(60000);
async function exec(command: string) {
  const r = await vm.exec(`set -e\n${command}\necho STORAGE_OK`);
  if (!r.out.includes("STORAGE_OK")) throw new Error(r.out);
  return r;
}
try {
  const mount = mode === "overlay"
    ? "mkdir -p /lower /upper /work; mount -o ro /dev/vdb /lower; mount /dev/vdc /upper; mkdir -p /upper/u /upper/w; mount -t overlay overlay -o lowerdir=/lower,upperdir=/upper/u,workdir=/upper/w /work"
    : "mkdir -p /work; mount /dev/vdb /work";
  await exec(mount);
  let checkpoint = 1;
  async function capture(stage: string) {
    await exec("sync");
    await vm.pause();
    const t = now();
    // Match the block-drain/fsync boundary required by a VMM checkpoint. A
    // block device can otherwise retain host-page-cache writes absent from its
    // backing file, producing an invalid but deceptively fast reflink snapshot.
    const fd = openSync(disk, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const drainMs = now() - t;
    if (mode === "thin") {
      checkpoint++;
      sh(`dmsetup suspend storage-data; dmsetup message storage-pool 0 'create_snap ${checkpoint} 1'; dmsetup resume storage-data`);
      sh(`dmsetup message storage-pool 0 reserve_metadata_snap`);
      const { meta } = JSON.parse(readFileSync(`${dir}/loops.json`, "utf8"));
      try { sh(`thin_delta --metadata-snap --thin1 ${checkpoint - 1} --thin2 ${checkpoint} ${meta} >${dir}/${stage}.delta.xml`); }
      finally { sh("dmsetup message storage-pool 0 release_metadata_snap"); }
      save({ mode, stage, operation: "checkpoint", ms: now() - t, drainMs, pool: sh("dmsetup status storage-pool").trim() });
      // Retain a sparse copy for equal chunk/dedup analysis, outside measured pause.
    } else {
      sh(`cp --reflink=always ${dir}/data.ext4 ${dir}/${stage}.ext4`);
      save({ mode, stage, operation: "checkpoint", ms: now() - t, drainMs, blocks: statSync(`${dir}/${stage}.ext4`).blocks });
    }
    await vm.resume();
  }
  await capture("empty");
  const stages = [
    ["clone", "git clone -q /opt/work/express /work/app"],
    ["install", "cd /work/app && npm install --offline --no-audit --no-fund --loglevel=error"],
    ["build", "cp -a /opt/work/web /work/web && cd /work/web && ./node_modules/.bin/vite build"],
    ["edit-rebuild", "printf '\\n// synthetic edit\\n' >> /work/app/index.js; printf '\\nconsole.log(42);\\n' >> /work/web/main.js; cd /work/web && ./node_modules/.bin/vite build"],
  ];
  for (const [stage, command] of stages) {
    const result = await exec(command!);
    save({ mode, stage, operation: "workload", ms: result.ms, output: result.out.slice(-500) });
    await capture(stage!);
  }
  if (process.env.DURABILITY === "1") {
    const writer = await exec(`python3 -c 'import os,time\nf=open("/work/sequence", "wb", buffering=0)\nfor i in range(3000):\n f.write((str(i)+"\\n").encode()); os.fsync(f.fileno()); time.sleep(.01)' </dev/null >/tmp/storage-writer.log 2>&1 & echo WRITER:$!`);
    const pid = /WRITER:(\d+)/.exec(writer.out)?.[1];
    if (!pid) throw new Error("missing writer pid");
    await sleep(1000);
    const freeze = await exec("fsfreeze -f /work");
    const t = now();
    try { sh(`cp --reflink=always ${dir}/data.ext4 ${dir}/frozen.ext4`); }
    finally {
      const snapshotMs = now() - t;
      const thaw = await exec("fsfreeze -u /work");
      const verification = await exec(`tail -1 /work/sequence; kill ${pid}; sync`);
      save({ mode, operation: "freeze-writing-filesystem", freezeMs: freeze.ms, snapshotMs, thawMs: thaw.ms, sequence: verification.out });
    }
    const check = Bun.spawnSync(["e2fsck", "-fn", `${dir}/frozen.ext4`], { stdout: "pipe", stderr: "pipe" });
    save({ mode, operation: "frozen-filesystem-check", exitCode: check.exitCode, stdout: check.stdout.toString(), stderr: check.stderr.toString() });
  }
  for (const [name, rw, bs, depth] of [["randread-q1", "randread", "4k", 1], ["randwrite-q1", "randwrite", "4k", 1], ["seqread", "read", "1m", 16], ["seqwrite", "write", "1m", 16]] as const) {
    const result = await exec(`fio --name=${name} --filename=/work/fio.bin --size=256m --rw=${rw} --bs=${bs} --iodepth=${depth} --ioengine=libaio --direct=1 --runtime=8 --time_based=1 --output-format=json --group_reporting=1`);
    const text = result.out.slice(result.out.indexOf("{"), result.out.lastIndexOf("}") + 1);
    const fio = JSON.parse(text);
    save({ mode, operation: "fio", name, fio });
  }
} finally {
  await vm.kill();
  // Exact task-owned VM root can be discarded; experiment disks remain for analysis.
  await vm.destroy();
  if (mode === "ublk") sh("/usr/local/sbin/ublk del -n 0");
}
