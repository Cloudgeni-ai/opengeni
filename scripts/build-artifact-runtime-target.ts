#!/usr/bin/env bun

import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  readArtifactKernelBuildReceipt,
  writeArtifactKernelBuildReceipt,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import type { ArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime";
import { resolveCurrentArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime-cli";
import targetMatrix from "../packages/artifact-tool/kernel/bindings/packages/targets.json" with { type: "json" };

type TargetDefinition = Readonly<{
  target: ArtifactRuntimeTarget;
  kind: "native" | "wasm";
  rustTarget: string;
  os: string;
  libc?: "glibc" | "musl";
}>;

export type BuildArtifactRuntimeTargetOptions = Readonly<{
  outputRoot: string;
  target: ArtifactRuntimeTarget;
}>;

/** Builds and smoke-receipts exactly one release target on its executable host. */
export async function buildArtifactRuntimeTarget(
  options: BuildArtifactRuntimeTargetOptions,
): Promise<void> {
  if (!isAbsolute(options.outputRoot) || resolve(options.outputRoot) === resolve("/")) {
    throw new TypeError("outputRoot must be a non-root absolute path");
  }
  const definition = targetDefinition(options.target);
  if (options.target !== "wasm-web") {
    const currentTarget = resolveCurrentArtifactRuntimeTarget();
    if (currentTarget !== options.target) {
      throw new Error(
        `Target ${options.target} must be built and smoke-tested by that exact host; current host is ${currentTarget}`,
      );
    }
  }
  for (const tool of ["bun", "cargo", "rustup"] as const) {
    if (!Bun.which(tool)) throw new Error(`${tool} is required to build ${options.target}`);
  }

  const stagingParent = dirname(options.outputRoot);
  await mkdir(stagingParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(stagingParent, ".artifact-runtime-target-"));
  try {
    if (definition.kind === "native") {
      await buildNativeTarget(stagingRoot, definition);
    } else {
      await buildWasmTarget(stagingRoot);
    }
    await writeArtifactKernelBuildReceipt(options.target, stagingRoot);
    await readArtifactKernelBuildReceipt(options.target, stagingRoot);
    await rm(options.outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, options.outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function buildNativeTarget(outputRoot: string, definition: TargetDefinition): Promise<void> {
  if (process.env.RUSTFLAGS || process.env.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error("ambient Rust flags make the native artifact build identity ambiguous");
  }
  const napiRoot = join(
    import.meta.dir,
    "..",
    "packages",
    "artifact-tool",
    "kernel",
    "bindings",
    "napi",
  );
  await run(["rustup", "target", "add", definition.rustTarget]);
  await run(
    [
      "cargo",
      "build",
      "--locked",
      "--manifest-path",
      join(napiRoot, "Cargo.toml"),
      "--release",
      "--target",
      definition.rustTarget,
    ],
    artifactRuntimeNativeCargoEnvironment(definition.target),
  );
  const targetRoot = join(outputRoot, "native", definition.target);
  await mkdir(targetRoot, { recursive: true });
  const nativeOutput = join(targetRoot, "opengeni_artifact_kernel.node");
  await copyFile(
    join(napiRoot, "target", definition.rustTarget, "release", nativeLibraryName(definition)),
    nativeOutput,
  );
  await run(["bun", "run", join(napiRoot, "scripts", "smoke.mjs")], {
    OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH: nativeOutput,
  });
}

/** Returns the deterministic Cargo environment required by one native release target. */
export function artifactRuntimeNativeCargoEnvironment(
  target: ArtifactRuntimeTarget,
): Readonly<Record<string, string>> {
  const definition = targetDefinition(target);
  if (definition.kind !== "native") {
    throw new TypeError(`Target ${target} is not native`);
  }
  return definition.libc === "musl"
    ? { CARGO_ENCODED_RUSTFLAGS: "-Ctarget-feature=-crt-static" }
    : {};
}

async function buildWasmTarget(outputRoot: string): Promise<void> {
  if (!Bun.which("wasm-bindgen")) {
    throw new Error("wasm-bindgen is required to build wasm-web");
  }
  const buildScript = join(
    import.meta.dir,
    "..",
    "packages",
    "artifact-tool",
    "kernel",
    "bindings",
    "wasm",
    "scripts",
    "build.sh",
  );
  const output = join(outputRoot, "wasm-web");
  for (const profile of ["full", "spreadsheet", "document", "presentation"] as const) {
    await run(["sh", buildScript, "web", output, profile]);
  }
}

function targetDefinition(target: ArtifactRuntimeTarget): TargetDefinition {
  const definition = targetMatrix.targets.find((entry) => entry.target === target);
  if (!definition) throw new TypeError(`Unknown artifact runtime target: ${target}`);
  return definition as TargetDefinition;
}

function nativeLibraryName(definition: TargetDefinition): string {
  if (definition.os === "darwin") return "libopengeni_artifact_kernel_napi.dylib";
  if (definition.os === "linux") return "libopengeni_artifact_kernel_napi.so";
  if (definition.os === "win32") return "opengeni_artifact_kernel_napi.dll";
  throw new Error(`Target ${definition.target} is not native`);
}

async function run(
  command: string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}

function parseArguments(args: readonly string[]): BuildArtifactRuntimeTargetOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--target" && name !== "--output") || !value || values.has(name)) {
      throw new TypeError(`Invalid or duplicate option: ${name ?? "<missing>"}`);
    }
    values.set(name, value);
  }
  const target = values.get("--target");
  const outputRoot = values.get("--output");
  if (!target || !outputRoot) throw new TypeError("--target and --output are required");
  targetDefinition(target as ArtifactRuntimeTarget);
  return { target: target as ArtifactRuntimeTarget, outputRoot };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  await buildArtifactRuntimeTarget(options);
  process.stdout.write(
    `${JSON.stringify({ target: options.target, outputRoot: options.outputRoot })}\n`,
  );
}
