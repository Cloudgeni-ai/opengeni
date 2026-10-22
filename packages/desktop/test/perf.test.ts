import { describe, expect, test } from "bun:test";

import { footprintBytes, linuxPrivateKilobytes, privateMemoryMb } from "../src/main/perf";

describe("private memory", () => {
  test("macOS footprint output is summed per process, not taken from the summary twice", () => {
    const output = [
      "App Helper (Renderer) [11093]: 64-bit    Footprint: 78628376 B (16384 bytes per page)",
      "Auxiliary data:",
      "    phys_footprint: 78661144 B",
      "    phys_footprint_peak: 156435992 B",
      "App [11081]: 64-bit    Footprint: 50186112 B (16384 bytes per page)",
      "Auxiliary data:",
      "    phys_footprint: 50218880 B",
      "    phys_footprint_peak: 63489944 B",
      "Summary Footprint: 128634264 B",
    ].join("\n");
    expect(footprintBytes(output)).toBe(78661144 + 50218880);
  });

  test("Linux counts private dirty pages and swap, not shared or clean pages", () => {
    const rollup = [
      "55a0c0000000-7ffd00000000 ---p 00000000 00:00 0                          [rollup]",
      "Rss:              191488 kB",
      "Pss:              113664 kB",
      "Shared_Clean:     110592 kB",
      "Shared_Dirty:          0 kB",
      "Private_Clean:     34816 kB",
      "Private_Dirty:     45056 kB",
      "Swap:               1024 kB",
      "SwapPss:            1024 kB",
    ].join("\n");
    expect(linuxPrivateKilobytes(rollup)).toBe(46080);
  });

  test("Windows sums private bytes", async () => {
    const metric = (pid: number, privateBytes: number) =>
      ({ pid, memory: { workingSetSize: 999_999, peakWorkingSetSize: 0, privateBytes } }) as never;
    expect(await privateMemoryMb([metric(1, 51_200), metric(2, 102_400)], "win32")).toBe(150);
  });

  test("an unreadable measurement is reported as missing rather than zero", async () => {
    expect(await privateMemoryMb([], "linux")).toBeNull();
  });
});
