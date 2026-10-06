import { expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  artifactKernelWasmRebuildDockerArguments,
  parseArtifactKernelWasmRebuildArguments,
} from "./rebuild-artifact-kernel-wasm-packages";

const repoRoot = resolve(import.meta.dir, "..");

test("diagnostics cannot relax the readonly source or clean Cargo target mounts", () => {
  const options = parseArtifactKernelWasmRebuildArguments([
    "--check",
    "--diagnostic-output",
    ".opengeni/ci-canonical-modality-wasm",
  ]);
  const args = artifactKernelWasmRebuildDockerArguments(options, "pinned-builder");
  expect(args).toContain(
    `type=bind,source=${repoRoot},target=/tmp/opengeni-artifact-wasm-source-v1,readonly`,
  );
  expect(args).toContain("type=volume,target=/tmp/opengeni-artifact-wasm-target-v1");
  expect(args).toContain("CARGO_TARGET_DIR=/tmp/opengeni-artifact-wasm-target-v1");
  expect(args).toContain(
    `type=bind,source=${resolve(repoRoot, ".opengeni/ci-canonical-modality-wasm")},target=/tmp/opengeni-artifact-wasm-diagnostics-v1`,
  );
  expect(args.at(-1)).toBe(
    "bun scripts/build-artifact-kernel-wasm-packages.ts --rebuild --check --diagnostic-output /tmp/opengeni-artifact-wasm-diagnostics-v1",
  );
  expect(args).toContain("--rm");
  expect(args).not.toContain("RUSTFLAGS");
});

test("ordinary canonical check and write commands remain unchanged", () => {
  const check = artifactKernelWasmRebuildDockerArguments(
    parseArtifactKernelWasmRebuildArguments(["--check"]),
    "pinned-builder",
  );
  expect(check.at(-1)).toBe("bun scripts/build-artifact-kernel-wasm-packages.ts --rebuild --check");
  expect(check.join(" ")).not.toContain("diagnostics-v1");
  const write = artifactKernelWasmRebuildDockerArguments(
    parseArtifactKernelWasmRebuildArguments(["--write"]),
    "pinned-builder",
  );
  expect(write).toContain(
    `type=bind,source=${repoRoot},target=/tmp/opengeni-artifact-wasm-source-v1`,
  );
  expect(write.at(-1)).toContain("bun scripts/build-artifact-runtime-target.ts --target wasm-web");
  expect(write.at(-1)).not.toContain("--diagnostic-output");
});

test("rejects diagnostic writes, missing or duplicate arguments and mount injection", () => {
  for (const args of [
    [],
    ["--skip-check"],
    ["--write", "--diagnostic-output", "output"],
    ["--check", "--diagnostic-output"],
    ["--check", "--diagnostic-output", "--write"],
    ["--check", "--diagnostic-output", "one", "--diagnostic-output", "two"],
    ["--check", "--diagnostic-output", "directory,readonly"],
  ])
    expect(() => parseArtifactKernelWasmRebuildArguments(args)).toThrow();
});
