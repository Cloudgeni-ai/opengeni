// Requires an existing lab snapshot; diagnoses command work versus EOF delay.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "bun";
import { Vm, LAB, PROBE, now, sleep, record } from "./fc";
import { measuredExec } from "./wake-exec";

const engine = process.argv[2]!;
const id = process.argv[3]!;
const count = Number(process.argv[4] ?? 5);
if (!/^wake-[a-z0-9-]+$/.test(id)) throw new Error("existing wake-prefixed VM id required");
const vm = new Vm(id);
try {
  if (engine === "firecracker") await vm.restore();
  else if (engine === "cloud-hypervisor") {
    rmSync(vm.apiSock, { force: true });
    rmSync(vm.vsock, { force: true });
    vm.proc = spawn([`${LAB}/bin/cloud-hypervisor`, "--api-socket", vm.apiSock], {
      stdin: "ignore", stdout: Bun.file(`${vm.dir}/probe-vmm.log`), stderr: Bun.file(`${vm.dir}/probe-vmm.log`),
    });
    writeFileSync(`${vm.cgroup}/cgroup.procs`, String(vm.pid));
    const deadline = now() + 10000;
    while (!existsSync(vm.apiSock)) { if (now() > deadline) throw new Error("VMM startup timed out"); await sleep(1); }
    await vm.api("PUT", "/api/v1/vm.restore", { source_url: `file://${vm.dir}/snapshot`, memory_restore_mode: "CopyOnWrite" });
    await vm.api("PUT", "/api/v1/vm.resume");
  } else throw new Error("unknown engine");
  for (let round = 0; round < count; round++) {
    const result = await measuredExec(vm.vsock, PROBE);
    record(process.env.WAKE_RESULT ?? "wake-protocol", { engine, round, ...result, transportTailMs: result.ms - result.doneMs });
  }
} finally { await vm.kill(); }
