// Snapshot portability and clock/entropy probe. Source and destination must use
// identical guest artifacts and the same device paths. No live network sessions.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { Vm, LAB, sh, sleep, now, ensureCgroupRoot, WORKLOAD, PROBE } from "./fc";

const action = process.argv[2] ?? "source";
const template = process.argv[3] ?? "None";
if (!["None", "T2", "C3", "T2S"].includes(template)) throw new Error("unsupported template");
const vmId = process.env.VM_ID ?? `storage-cross-${template.toLowerCase()}`;
if (!/^[a-z0-9-]+$/.test(vmId)) throw new Error("invalid VM_ID");
const vm = new Vm(vmId);
const restoredVsock = `${vm.dir}/restored.sock`;
ensureCgroupRoot();
mkdirSync(vm.dir, { recursive: true });
mkdirSync(vm.cgroup, { recursive: true });
const metadata = { template, hostKernel: sh("uname -r").trim(), cpu: sh("lscpu -J"), vmm: sh(`${LAB}/bin/firecracker --version`).trim() };
async function spawn() {
  for (const path of [vm.apiSock, vm.vsock, restoredVsock]) rmSync(path, { force: true });
  vm.proc = Bun.spawn([`${LAB}/bin/firecracker`, "--api-sock", vm.apiSock], { stdout: Bun.file(`${vm.dir}/console.log`), stderr: Bun.file(`${vm.dir}/vmm.log`) });
  writeFileSync(`${vm.cgroup}/cgroup.procs`, String(vm.pid));
  for (let i = 0; i < 1000 && !existsSync(vm.apiSock); i++) await sleep(5);
}
const probe = `${PROBE}\ndate +%s\ncat /proc/sys/kernel/random/boot_id\ncat /sys/devices/system/clocksource/clocksource0/current_clocksource\nhead -c32 /dev/urandom | od -An -tx1\ndmesg | grep -Ei 'vmgenid|vmclock|clocksource|reseed|fork' | tail -12`;
try {
  if (action === "source") {
    sh(`cp --reflink=auto ${process.env.COLD_DISK ?? `${LAB}/base.ext4`} ${vm.dir}/rootfs.ext4`);
    await spawn();
    await vm.api("PUT", "/boot-source", { kernel_image_path: `${LAB}/vmlinux`, boot_args: process.env.BOOT_ARGS ?? "console=ttyS0 reboot=k panic=1 quiet" });
    await vm.api("PUT", "/machine-config", { vcpu_count: 2, mem_size_mib: 2048, smt: false, ...(template === "None" ? {} : { cpu_template: template }) });
    await vm.api("PUT", "/drives/rootfs", { drive_id: "rootfs", path_on_host: `${vm.dir}/rootfs.ext4`, is_root_device: true, is_read_only: false });
    await vm.api("PUT", "/vsock", { guest_cid: 3, uds_path: vm.vsock });
    await vm.api("PUT", "/actions", { action_type: "InstanceStart" });
    await vm.waitAgent(60000);
    if (!process.env.COLD_DISK) {
      const work = await vm.exec(WORKLOAD);
      if (!work.out.includes("workload-done")) throw new Error(work.out);
    }
    const before = await vm.exec(`${probe}\nsync`);
    const snapshot = await vm.snapshotAndStop();
    sh(`cp --reflink=auto ${vm.dir}/rootfs.ext4 ${vm.dir}/root.checkpoint`);
    sh(`fallocate --dig-holes ${vm.dir}/mem.snap`);
    const row = { ...metadata, action, before: before.out, snapshotMs: snapshot.ms };
    writeFileSync(`${vm.dir}/source.json`, JSON.stringify(row, null, 2)); console.log(JSON.stringify(row));
  } else {
    rmSync(`${vm.dir}/rootfs.ext4`, { force: true });
    if (process.env.DISK_BACKEND) symlinkSync(process.env.DISK_BACKEND, `${vm.dir}/rootfs.ext4`);
    else sh(`cp --reflink=auto ${vm.dir}/root.checkpoint ${vm.dir}/rootfs.ext4`);
    const startEpochMs = Date.now();
    const start = now();
    await spawn();
    await vm.api("PUT", "/snapshot/load", { snapshot_path: process.env.STATE_BACKEND ?? `${vm.dir}/vm.snap`, mem_backend: { backend_type: "File", backend_path: process.env.MEMORY_BACKEND ?? `${vm.dir}/mem.snap` }, resume_vm: true, ...(process.env.VSOCK_OVERRIDE ? { vsock_override: { uds_path: restoredVsock } } : {}), clock_realtime: process.env.CLOCK_REALTIME === "1" });
    if (process.env.VSOCK_OVERRIDE) symlinkSync(restoredVsock, vm.vsock);
    const loadMs = now() - start;
    const result = await vm.exec(probe, Number(process.env.EXEC_TIMEOUT_MS ?? 15000));
    const row = { ...metadata, action, hostEpochSeconds: Date.now() / 1000, firstByteEpochMs: startEpochMs + loadMs + result.firstByteMs, loadMs, totalMs: now() - start, firstByteMs: loadMs + result.firstByteMs, output: result.out, success: result.out.includes("function") };
    writeFileSync(`${vm.dir}/restore-${Date.now()}.json`, JSON.stringify(row, null, 2)); console.log(JSON.stringify(row));
  }
} catch (error) {
  const row = { ...metadata, action, success: false, error: String(error), vmmLog: existsSync(`${vm.dir}/vmm.log`) ? readFileSync(`${vm.dir}/vmm.log`, "utf8").slice(-6000) : "" };
  writeFileSync(`${vm.dir}/failure-${Date.now()}.json`, JSON.stringify(row, null, 2)); console.log(JSON.stringify(row));
  process.exitCode = 1;
} finally { await vm.kill(); }
