import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProcessMetric } from "electron";

/**
 * Startup timing marks, in milliseconds since the process started. With
 * OPENGENI_DESKTOP_PERF set to a directory, they are written there as JSON so
 * the budget check can read them.
 */
const marks: Record<string, number> = {};

/** Whether start-up and memory measurements are being recorded. */
export function measuring(): boolean {
  return Boolean(process.env.OPENGENI_DESKTOP_PERF);
}

export function mark(name: string): void {
  if (name in marks) return;
  // process.uptime() counts from process creation, before any JavaScript ran.
  marks[name] = Math.round(process.uptime() * 1000);
}

export function flushMarks(extra: Record<string, number> = {}): void {
  const directory = process.env.OPENGENI_DESKTOP_PERF;
  if (!directory) return;
  try {
    writeFileSync(
      join(directory, `startup-${process.pid}.json`),
      `${JSON.stringify({ ...marks, ...extra }, null, 2)}\n`,
    );
  } catch {
    // Measuring is best effort.
  }
}

/**
 * Memory the app's processes hold privately, in megabytes: the figure each
 * system's own monitor reports. Resident sizes are not summed, because every
 * process maps the same shared framework pages and those would be counted
 * once per process.
 *
 * - macOS: physical footprint (Activity Monitor's Memory column).
 * - Windows: private bytes.
 * - Linux: private dirty pages plus swap, the same kind of memory the macOS
 *   footprint counts. Clean pages of the binary and libraries are shared and
 *   can be dropped by the system, so they are left out.
 */
export async function privateMemoryMb(
  metrics: readonly ProcessMetric[],
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  const pids = metrics.map((metric) => metric.pid);
  let kilobytes: number | null = null;
  try {
    if (platform === "win32") {
      kilobytes = metrics.reduce((sum, metric) => sum + (metric.memory.privateBytes ?? 0), 0);
    } else if (platform === "darwin") {
      const { stdout } = await promisify(execFile)("/usr/bin/footprint", [
        "--noCategories",
        "-f",
        "bytes",
        ...pids.flatMap((pid) => ["-p", String(pid)]),
      ]);
      kilobytes = footprintBytes(stdout) / 1024;
    } else if (platform === "linux") {
      const rollups = await Promise.all(
        pids.map((pid) => readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "")),
      );
      kilobytes = rollups.reduce((sum, rollup) => sum + linuxPrivateKilobytes(rollup), 0);
    }
  } catch {
    return null;
  }
  return kilobytes === null || kilobytes <= 0 ? null : Math.round(kilobytes / 1024);
}

/** The summed `phys_footprint` of every process in `footprint -f bytes` output. */
export function footprintBytes(output: string): number {
  let total = 0;
  for (const match of output.matchAll(/^\s*phys_footprint:\s*(\d+)\s*B\s*$/gm)) {
    total += Number(match[1]);
  }
  return total;
}

/** Private dirty pages plus swap from a `/proc/<pid>/smaps_rollup`, in kilobytes. */
export function linuxPrivateKilobytes(rollup: string): number {
  let total = 0;
  for (const match of rollup.matchAll(/^(Private_Dirty|Swap):\s+(\d+) kB$/gm)) {
    total += Number(match[2]);
  }
  return total;
}
