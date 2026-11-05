import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { packageReleaseChart, pinDesktopImageInValues } from "./package-release-chart";

const root = resolve(import.meta.dir, "..");
const hasGnuTar = Bun.spawnSync(["tar", "--version"]).stdout.toString().includes("GNU tar");
const desktopImageRef = `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"a".repeat(64)}`;

describe("package release chart", () => {
  test.skipIf(!hasGnuTar)("normalizes Helm's time-bearing archive into stable bytes", async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "opengeni-chart-test-"));
    try {
      const first = resolve(scratch, "first.tgz");
      const second = resolve(scratch, "second.tgz");
      const input = {
        chartDirectory: resolve(root, "deploy/helm/opengeni"),
        version: "1.2.3-test.1",
        appVersion: "1.2.3-test.1",
        desktopImageRef,
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

  test.skipIf(!hasGnuTar)(
    "pins the packaged default Modal desktop image to the release's own desktop image",
    async () => {
      const scratch = await mkdtemp(resolve(tmpdir(), "opengeni-chart-test-"));
      try {
        const output = resolve(scratch, "chart.tgz");
        await packageReleaseChart({
          chartDirectory: resolve(root, "deploy/helm/opengeni"),
          output,
          version: "1.2.3-test.1",
          appVersion: "1.2.3-test.1",
          desktopImageRef,
          run: fakeHelm,
        });
        const packaged = await spawn(["tar", "-xzOf", output, "opengeni/values.yaml"], scratch);
        const source = await readFile(resolve(root, "deploy/helm/opengeni/values.yaml"), "utf8");
        const values = Bun.YAML.parse(packaged.toString("utf8")) as {
          desktop: { imageRef: string };
        };
        expect(values.desktop.imageRef).toBe(desktopImageRef);
        // Only the pin changes; every other default ships as written.
        expect(packaged.toString("utf8")).toBe(pinDesktopImageInValues(source, desktopImageRef));
        const sourceDesktop = (Bun.YAML.parse(source) as { desktop: { imageRef: string } }).desktop
          .imageRef;
        expect(sourceDesktop).not.toBe(desktopImageRef);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  test("refuses a desktop pin that is not an exact opengeni-desktop digest", async () => {
    for (const ref of [
      "",
      "ghcr.io/cloudgeni-ai/opengeni-desktop:latest",
      "ghcr.io/cloudgeni-ai/opengeni-desktop:canary-sha-" + "a".repeat(40),
      `ghcr.io/cloudgeni-ai/opengeni-sandbox@sha256:${"a".repeat(64)}`,
      `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"A".repeat(64)}`,
      `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"a".repeat(63)}`,
      `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"a".repeat(64)}\n`,
    ]) {
      await expect(
        packageReleaseChart({
          chartDirectory: resolve(root, "deploy/helm/opengeni"),
          output: resolve(tmpdir(), "unused-opengeni-chart.tgz"),
          version: "1.2.3",
          appVersion: "1.2.3",
          desktopImageRef: ref,
          run: () => Promise.reject(new Error("Helm must not run")),
        }),
      ).rejects.toThrow("desktop image ref must be");
    }
    for (const ref of [
      desktopImageRef,
      `opengenipublicneuacr.azurecr.io/opengeni-desktop@sha256:${"b".repeat(64)}`,
      `registry.example.com:5000/team/opengeni-desktop@sha256:${"c".repeat(64)}`,
    ]) {
      expect(pinDesktopImageInValues('desktop:\n  imageRef: "old"\n', ref)).toBe(
        `desktop:\n  imageRef: "${ref}"\n`,
      );
    }
  });

  test("requires exactly one top-level desktop.imageRef to pin", () => {
    expect(() => pinDesktopImageInValues("config: {}\n", desktopImageRef)).toThrow(
      "exactly one top-level desktop.imageRef (found 0)",
    );
    expect(() =>
      pinDesktopImageInValues(
        'desktop:\n  imageRef: "a"\nother:\n  x: 1\ndesktop:\n  imageRef: "b"\n',
        desktopImageRef,
      ),
    ).toThrow("found 2");
    expect(() =>
      pinDesktopImageInValues('web:\n  desktop:\n  imageRef: "a"\n', desktopImageRef),
    ).toThrow("found 0");
  });

  test("rejects an invalid chart version before invoking Helm", async () => {
    await expect(
      packageReleaseChart({
        chartDirectory: resolve(root, "deploy/helm/opengeni"),
        output: resolve(tmpdir(), "unused-opengeni-chart.tgz"),
        version: "latest",
        appVersion: "latest",
        desktopImageRef,
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
