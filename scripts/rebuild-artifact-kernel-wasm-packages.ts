#!/usr/bin/env bun

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const canonicalRoot = "/tmp/opengeni-artifact-wasm-source-v1";
const builderRoot = resolve(repoRoot, "packages/artifact-tool/kernel/bindings/wasm");
const builderImage = "opengeni-artifact-wasm-builder:1.97.0-0.2.127-1.3.14";
// An anonymous target volume guarantees every proof recompiles from clean Rust outputs. Docker
// removes it with the container, so an earlier build can never make a later byte check pass.
const targetMount = `type=volume,target=${canonicalRoot}/packages/artifact-tool/kernel/bindings/wasm/target`;
const mode = process.argv[2];

if (mode !== "--check" && mode !== "--write") {
  throw new TypeError(
    "usage: bun scripts/rebuild-artifact-kernel-wasm-packages.ts --check|--write",
  );
}
if (!Bun.which("docker")) {
  throw new Error("Docker is required for canonical Rust-to-WASM byte generation");
}

await run([
  "docker",
  "build",
  "--platform",
  "linux/amd64",
  "--file",
  resolve(builderRoot, "Dockerfile.builder"),
  "--tag",
  builderImage,
  builderRoot,
]);

const mount = `type=bind,source=${repoRoot},target=${canonicalRoot}${mode === "--check" ? ",readonly" : ""}`;
const command =
  mode === "--check"
    ? "bun scripts/build-artifact-kernel-wasm-packages.ts --rebuild --check"
    : [
        "bun scripts/build-artifact-runtime-target.ts --target wasm-web --output /tmp/opengeni-artifact-wasm-runtime",
        `cp -a /tmp/opengeni-artifact-wasm-runtime/wasm-web/. ${canonicalRoot}/packages/artifact-tool/kernel/bindings/dist/wasm-web/`,
        "bun scripts/build-artifact-kernel-wasm-packages.ts",
      ].join(" && ");

await run([
  "docker",
  "run",
  "--rm",
  "--platform",
  "linux/amd64",
  "--mount",
  mount,
  "--mount",
  targetMount,
  "--workdir",
  canonicalRoot,
  builderImage,
  "sh",
  "-c",
  command,
]);

async function run(argv: string[], cwd = repoRoot): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${argv[0]} ${argv[1] ?? ""}`.trim());
  }
}
