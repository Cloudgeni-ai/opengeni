import { readFileSync } from "node:fs";

export function hugetlbMiB(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  return Number(/^HugetlbPages:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024;
}

export function hostMemory() {
  const data = readFileSync("/proc/meminfo", "utf8");
  return Object.fromEntries(["MemAvailable", "Cached", "HugePages_Total", "HugePages_Free", "Hugepagesize", "Hugetlb"]
    .map((name) => [name, Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(data)?.[1] ?? 0)]));
}

export function metrics() {
  const cpu = readFileSync("/proc/stat", "utf8").split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  const kvm: Record<string, number> = {};
  for (const key of ["exits", "pf_taken", "pf_fixed", "pf_emulate", "pf_spurious", "tlb_flush", "remote_tlb_flush", "mmu_shadow_zapped"]) {
    try { kvm[key] = Number(readFileSync(`/sys/kernel/debug/kvm/${key}`, "utf8")); } catch { /* unavailable counter stays absent */ }
  }
  const disks: Record<string, { readBytes: number; writeBytes: number; busyMs: number; weightedMs: number }> = {};
  for (const line of readFileSync("/proc/diskstats", "utf8").trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    const name = fields[2]!;
    if (!/^(nvme\d+n\d+|md\d+|sd[a-z]+)$/.test(name)) continue;
    disks[name] = { readBytes: Number(fields[5]) * 512, writeBytes: Number(fields[9]) * 512,
      busyMs: Number(fields[12]), weightedMs: Number(fields[13]) };
  }
  return { cpu, kvm, disks };
}

export function delta(before: ReturnType<typeof metrics>, after: ReturnType<typeof metrics>, count: number) {
  const ticks = after.cpu.map((v, i) => v - before.cpu[i]!);
  const total = ticks.slice(0, 8).reduce((a, b) => a + b, 0);
  const parts = { hostUser: ticks[0]! - ticks[8]!, guest: ticks[8]!, system: ticks[2]!, softirq: ticks[6]!, iowait: ticks[4]!, steal: ticks[7]!, idle: ticks[3]! };
  return {
    cpu: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / total])),
    kvmPerVm: Object.fromEntries(Object.entries(after.kvm).filter(([k]) => before.kvm[k] !== undefined).map(([k, v]) => [k, (v - before.kvm[k]!) / count])),
    // Array and member-device counters overlap; never sum both layers.
    diskIo: Object.fromEntries(Object.entries(after.disks).filter(([name]) => before.disks[name]).map(([name, sample]) => [name,
      Object.fromEntries(Object.entries(sample).map(([key, value]) => [key, value - before.disks[name]![key as keyof typeof sample]]))])),
  };
}
