#!/usr/bin/env bun

import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBunVersion } from "./bun-version";

const repoRoot = resolve(import.meta.dir, "..");
const canonicalRoot = "/tmp/opengeni-artifact-wasm-source-v1";
const canonicalTarget = "/tmp/opengeni-artifact-wasm-target-v1";
const builderRoot = resolve(repoRoot, "packages/artifact-tool/kernel/bindings/wasm");
const canonicalDiagnostics = "/tmp/opengeni-artifact-wasm-diagnostics-v1";
// An anonymous target volume guarantees every proof recompiles from clean Rust outputs. Docker
// removes it with the container, so an earlier build can never make a later byte check pass.
const targetMount = `type=volume,target=${canonicalTarget}`;
type RebuildOptions = Readonly<{
  mode: "--check" | "--write";
  diagnosticOutput?: string;
}>;

export function parseArtifactKernelWasmRebuildArguments(args: readonly string[]): RebuildOptions {
  const mode = args[0];
  if (
    (mode !== "--check" && mode !== "--write") ||
    (args.length !== 1 &&
      (mode !== "--check" ||
        args.length !== 3 ||
        args[1] !== "--diagnostic-output" ||
        !args[2] ||
        args[2].startsWith("--")))
  ) {
    throw new TypeError(
      "usage: bun scripts/rebuild-artifact-kernel-wasm-packages.ts --check|--write [--diagnostic-output <directory> (check only)]",
    );
  }
  const diagnosticOutput = args[2] ? resolve(args[2]) : undefined;
  if (diagnosticOutput && /[,\r\n]/u.test(diagnosticOutput)) {
    throw new TypeError("diagnostic output path cannot contain Docker mount separators");
  }
  return { mode, diagnosticOutput };
}

export function artifactKernelWasmRebuildDockerArguments(
  options: RebuildOptions,
  builderImage: string,
): string[] {
  const mount = `type=bind,source=${repoRoot},target=${canonicalRoot}${options.mode === "--check" ? ",readonly" : ""}`;
  const command =
    options.mode === "--check"
      ? `bun scripts/build-artifact-kernel-wasm-packages.ts --rebuild --check${options.diagnosticOutput ? ` --diagnostic-output ${canonicalDiagnostics}` : ""}`
      : [
          "bun scripts/build-artifact-runtime-target.ts --target wasm-web --output /tmp/opengeni-artifact-wasm-runtime",
          `cp -a /tmp/opengeni-artifact-wasm-runtime/wasm-web/. ${canonicalRoot}/packages/artifact-tool/kernel/bindings/dist/wasm-web/`,
          "bun scripts/build-artifact-kernel-wasm-packages.ts",
        ].join(" && ");
  return [
    "docker",
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--mount",
    mount,
    "--mount",
    targetMount,
    ...(options.diagnosticOutput
      ? ["--mount", `type=bind,source=${options.diagnosticOutput},target=${canonicalDiagnostics}`]
      : []),
    "--env",
    `CARGO_TARGET_DIR=${canonicalTarget}`,
    "--workdir",
    canonicalRoot,
    builderImage,
    "sh",
    "-c",
    command,
  ];
}

if (import.meta.main) {
  const options = parseArtifactKernelWasmRebuildArguments(process.argv.slice(2));
  if (!Bun.which("docker")) {
    throw new Error("Docker is required for canonical Rust-to-WASM byte generation");
  }
  if (options.diagnosticOutput) {
    await mkdir(options.diagnosticOutput, { recursive: true });
    if ((await readdir(options.diagnosticOutput)).length !== 0) {
      throw new Error("diagnostic output directory must be empty");
    }
  }
  const builderImage = `opengeni-artifact-wasm-builder:1.97.0-0.2.127-${await canonicalBunVersion()}`;
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
  await run(artifactKernelWasmRebuildDockerArguments(options, builderImage));
}

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
