import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { packageReleaseChart } from "./package-release-chart";

const root = resolve(import.meta.dir, "..");

describe("package release chart", () => {
  test("normalizes Helm's time-bearing archive into stable bytes", async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "opengeni-chart-test-"));
    try {
      const first = resolve(scratch, "first.tgz");
      const second = resolve(scratch, "second.tgz");
      const input = {
        chartDirectory: resolve(root, "deploy/helm/opengeni"),
        version: "1.2.3-test.1",
        appVersion: "1.2.3-test.1",
        run: fakeHelm,
      };
      await packageReleaseChart({ ...input, output: first });
      await Bun.sleep(1_100);
      await packageReleaseChart({ ...input, output: second });

      const firstBytes = await readFile(first);
      const secondBytes = await readFile(second);
      expect(secondBytes).toEqual(firstBytes);
      expect(createHash("sha256").update(firstBytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
      expect([...firstBytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("rejects an invalid chart version before invoking Helm", async () => {
    await expect(
      packageReleaseChart({
        chartDirectory: resolve(root, "deploy/helm/opengeni"),
        output: resolve(tmpdir(), "unused-opengeni-chart.tgz"),
        version: "latest",
        appVersion: "latest",
      }),
    ).rejects.toThrow("chart version must be exact semver");
  });
});

async function fakeHelm(argv: string[], cwd: string): Promise<Buffer> {
  if (argv[0] !== "helm") return spawn(argv, cwd);
  const destination = argv[argv.indexOf("--destination") + 1];
  const version = argv[argv.indexOf("--version") + 1];
  const chart = argv[2];
  if (!destination || !version || !chart) throw new Error("invalid Helm test invocation");
  const output = resolve(destination, `${basename(chart)}-${version}.tgz`);
  return spawn(["tar", "-czf", output, "-C", dirname(resolve(chart)), basename(chart)], cwd);
}

async function spawn(argv: string[], cwd: string): Promise<Buffer> {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${argv[0]} failed: ${stderr.trim()}`);
  return Buffer.from(stdout);
}
