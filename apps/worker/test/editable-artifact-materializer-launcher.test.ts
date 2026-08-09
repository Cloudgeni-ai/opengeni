import { describe, expect, test } from "bun:test";

import {
  linuxEditableArtifactPrlimitArguments,
  linuxEditableArtifactSandboxArguments,
  linuxEditableArtifactSandboxRootEntries,
} from "../src/editable-artifact-materializer-launcher";

describe("editable artifact Linux sandbox command", () => {
  test("mounts only the executable, runtime, and read-only system libraries", () => {
    const executable = "/opt/opengeni/bin/opengeni-artifact-materializer";
    const runtimeRoot = "/app/artifact-runtime";
    const args = linuxEditableArtifactSandboxArguments({
      executable,
      runtimeRoot,
      scratchLimitBytes: 536_870_912,
      args: ["--opengeni-materialize-v1"],
    });

    expect(args).not.toContain("/var");
    expect(args).not.toContain("/run");
    expect(args).not.toContain("/home");
    expect(args).not.toContain("/root");
    expect(bindMounts(args)).not.toContainEqual(["/", "/"]);
    expect(bindMounts(args)).toContainEqual([runtimeRoot, runtimeRoot]);
    expect(bindMounts(args)).toContainEqual([executable, executable]);
    expect(args).toContain("--remount-ro");
    expect(args.slice(args.indexOf("--size"), args.indexOf("--size") + 4)).toEqual([
      "--size",
      "536870912",
      "--tmpfs",
      "/tmp",
    ]);
    expect(args.slice(-3)).toEqual(["--", executable, "--opengeni-materialize-v1"]);
    expect(linuxEditableArtifactSandboxRootEntries({ executable, runtimeRoot })).toEqual([
      "app",
      "dev",
      "etc",
      "lib",
      "lib64",
      "opt",
      "proc",
      "tmp",
      "usr",
    ]);
  });

  test("sets every independently probed process resource ceiling", () => {
    expect(
      linuxEditableArtifactPrlimitArguments({
        memoryLimitBytes: 536_870_912,
        cpuSeconds: 60,
        fileDescriptorLimit: 64,
        processLimit: 64,
        fileSizeLimitBytes: 536_870_912,
      }),
    ).toEqual(["--as=536870912", "--cpu=60", "--nofile=64", "--nproc=64", "--fsize=536870912"]);
  });
});

function bindMounts(args: readonly string[]): readonly (readonly [string, string])[] {
  const mounts: Array<readonly [string, string]> = [];
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === "--ro-bind" || args[index] === "--ro-bind-try") {
      mounts.push([args[index + 1]!, args[index + 2]!]);
    }
  }
  return mounts;
}
