import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distribution, summarize, type Distribution } from "./summarize-profiles";

function profile(path: string, wallSeconds: number, exitCode = 0): void {
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      name: "focused",
      exitCode,
      wallSeconds,
      process: {
        userSeconds: wallSeconds / 2,
        systemSeconds: wallSeconds / 4,
        maxRssBytes: wallSeconds * 100,
        fileSystemInputs: 0,
        fileSystemOutputs: 1,
      },
      cgroup: {
        memoryPeakDeltaFromStartBytes: wallSeconds * 200,
        cpuUsageDeltaNanoseconds: wallSeconds * 1e9,
        readBytesDelta: null,
        writeBytesDelta: wallSeconds * 10,
      },
      runner: {
        os: "linux",
        arch: "x64",
        bunVersion: "1.3.14",
        githubRunnerOs: null,
        githubRunnerArch: null,
      },
    }),
  );
}

describe("profile distribution summaries", () => {
  test("uses nearest-rank p95 and population variance", () => {
    expect(distribution([1, 2, 3, 4, 100])).toEqual({
      n: 5,
      min: 1,
      median: 3,
      p95: 100,
      max: 100,
      mean: 22,
      populationVariance: 1522,
      populationStddev: Math.sqrt(1522),
      cv: Math.sqrt(1522) / 22,
    });
  });

  test("reports failures but excludes them from successful distributions", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-summary-"));
    const paths = [join(root, "a.json"), join(root, "b.json"), join(root, "failed.json")];
    profile(paths[0] as string, 10);
    profile(paths[1] as string, 20);
    profile(paths[2] as string, 1_000, 7);
    const summary = summarize(paths) as {
      successfulCount: number;
      failed: Array<{ path: string; name: string; exitCode: number }>;
      metrics: { wallSeconds: Distribution };
    };
    expect(summary.successfulCount).toBe(2);
    expect(summary.failed).toEqual([{ path: paths[2] as string, name: "focused", exitCode: 7 }]);
    expect(summary.metrics.wallSeconds.median).toBe(15);
    expect(summary.metrics.wallSeconds.p95).toBe(20);
  });
});
