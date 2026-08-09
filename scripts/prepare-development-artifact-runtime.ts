#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import packageJson from "../packages/artifact-tool/package.json" with { type: "json" };
import {
  canonicalArtifactKernelBuildReceiptBytes,
  readArtifactKernelBuildReceipt,
  writeArtifactKernelBuildReceipt,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ArtifactRuntimeError,
  type NativeArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import { resolveCurrentArtifactRuntimeTarget } from "../packages/artifact-tool/src/runtime-cli";
import {
  DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT,
  canonicalDevelopmentArtifactRuntimeManifestBytes,
  canonicalDevelopmentArtifactToolIdentityBytes,
  doctorVerifiedDevelopmentArtifactRuntime,
  locateVerifiedDevelopmentArtifactRuntime,
  type DevelopmentArtifactRuntimeManifest,
} from "../packages/artifact-tool/src/runtime-development";
import {
  materializeArtifactKernelPackages,
  renderArtifactSkillFacadeBootstrap,
} from "./materialize-artifact-kernel-packages";

const SKILL_FACADE = "skill-facade-entry.mjs";
const INSTALLATION_MANIFEST = "installation.development.json";
const TOOL_IDENTITY = "artifact-tool-identity.json";
const RECEIPT = "artifact-kernel-build-receipt.json";
const BUILD_STAMP = "artifact-kernel-development-source.json";
const MATERIALIZER_EXECUTABLE =
  process.platform === "win32"
    ? "opengeni-artifact-materializer.exe"
    : "opengeni-artifact-materializer";

export type PrepareDevelopmentArtifactRuntimeOptions = Readonly<{
  repositoryRoot: string;
  outputRoot: string;
  assetRoot?: string;
  buildIfNeeded?: boolean;
  doctor?: boolean;
}>;

export type PreparedDevelopmentArtifactRuntime = Readonly<{
  rebuiltKernel: boolean;
  reusedInstallation: boolean;
  target: NativeArtifactRuntimeTarget;
  sourceFingerprint: `sha256:${string}`;
  manifestPath: string;
  skillFacadeEntrypoint: string;
  materializerExecutable: string;
}>;

/** Prepares one current-host-only development runtime; production is rejected. */
export async function prepareDevelopmentArtifactRuntime(
  options: PrepareDevelopmentArtifactRuntimeOptions,
): Promise<PreparedDevelopmentArtifactRuntime> {
  if (process.env.NODE_ENV === "production") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "Development artifact runtime preparation is forbidden when NODE_ENV=production",
    );
  }
  requireAbsolute(options.repositoryRoot, "repositoryRoot");
  requireAbsolute(options.outputRoot, "outputRoot");
  if (options.assetRoot) requireAbsolute(options.assetRoot, "assetRoot");
  const outputName = developmentOutputName(options.repositoryRoot, options.outputRoot);
  const repositoryRoot = await realpath(options.repositoryRoot);
  const localOutputRoot = join(repositoryRoot, ".opengeni");
  await rejectSymlinkIfPresent(localOutputRoot);
  const outputRoot = join(localOutputRoot, outputName);
  const assetRoot =
    options.assetRoot ??
    join(repositoryRoot, "packages", "artifact-tool", "kernel", "bindings", "dist");
  const target = currentNativeTarget();
  const sourceFingerprint = await developmentArtifactRuntimeSourceFingerprint(repositoryRoot);
  const manifestPath = join(outputRoot, INSTALLATION_MANIFEST);
  const skillFacadeEntrypoint = join(outputRoot, SKILL_FACADE);
  const materializerExecutable = join(outputRoot, MATERIALIZER_EXECUTABLE);
  const environment = developmentEnvironment(manifestPath, skillFacadeEntrypoint);

  if (await reusableInstallation(outputRoot, sourceFingerprint, environment, target)) {
    if (options.doctor !== false) {
      await doctorVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget: target });
    }
    return Object.freeze({
      rebuiltKernel: false,
      reusedInstallation: true,
      target,
      sourceFingerprint,
      manifestPath,
      skillFacadeEntrypoint,
      materializerExecutable,
    });
  }

  let rebuiltKernel = false;
  if (!(await reusableReceipt(assetRoot, target, sourceFingerprint))) {
    if (options.buildIfNeeded === false) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_UNAVAILABLE",
        "Current-host artifact kernel receipt is absent or stale",
      );
    }
    await buildCurrentHostKernel(repositoryRoot, assetRoot, target, sourceFingerprint);
    rebuiltKernel = true;
  }
  const receipt = await readArtifactKernelBuildReceipt(target, assetRoot);
  const stagingParent = dirname(outputRoot);
  await mkdir(stagingParent, { recursive: true });
  await rejectSymlinkIfPresent(outputRoot);
  const staging = await mkdtemp(join(stagingParent, ".artifact-runtime-development-"));
  const materialized = join(staging, "materialized");
  const assembled = join(staging, "assembled");
  try {
    const [kernelPackage] = await materializeArtifactKernelPackages({
      assetRoot,
      outputRoot: materialized,
      artifactToolVersion: packageJson.version,
      targets: [target],
    });
    if (!kernelPackage) throw new Error("Current-host kernel package was not materialized");
    await mkdir(join(assembled, "kernel"), { recursive: true });
    const runtimeDescriptors = [
      kernelPackage.manifest.entrypoint,
      kernelPackage.manifest.asset,
      ...kernelPackage.manifest.supportFiles,
    ];
    for (const runtimeDescriptor of runtimeDescriptors) {
      await copyFile(
        join(kernelPackage.packageRoot, runtimeDescriptor.path),
        join(assembled, "kernel", runtimeDescriptor.path),
      );
    }
    const artifactTool = Object.freeze({
      packageName: "@opengeni/artifact-tool" as const,
      packageVersion: packageJson.version,
    });
    const identityBytes = canonicalDevelopmentArtifactToolIdentityBytes(artifactTool);
    const receiptBytes = canonicalArtifactKernelBuildReceiptBytes(receipt);
    const facadeBytes = new TextEncoder().encode(
      renderArtifactSkillFacadeBootstrap(kernelPackage.manifest, {
        kernelSpecifier: "./kernel/index.js",
      }),
    );
    const stagedMaterializerExecutable = join(assembled, MATERIALIZER_EXECUTABLE);
    await run(
      [
        "bun",
        "build",
        "--compile",
        join(repositoryRoot, "packages", "artifact-tool", "src", "materializer-cli-entry.ts"),
        "--outfile",
        stagedMaterializerExecutable,
      ],
      repositoryRoot,
    );
    if (process.platform !== "win32") await chmod(stagedMaterializerExecutable, 0o755);
    const materializerBytes = await exactMaterializerExecutable(stagedMaterializerExecutable);
    await Promise.all([
      writeFile(join(assembled, TOOL_IDENTITY), identityBytes),
      writeFile(join(assembled, RECEIPT), receiptBytes),
      writeFile(join(assembled, SKILL_FACADE), facadeBytes),
    ]);
    const manifest: DevelopmentArtifactRuntimeManifest = {
      schemaVersion: 1,
      mode: "development-current-host",
      target,
      sourceFingerprint,
      artifactTool,
      artifactToolIdentity: descriptor(TOOL_IDENTITY, identityBytes),
      receipt: descriptor(RECEIPT, receiptBytes),
      skillFacadeEntrypoint: descriptor(SKILL_FACADE, facadeBytes),
      materializerExecutable: descriptor(MATERIALIZER_EXECUTABLE, materializerBytes),
      kernelPackageRoot: "kernel",
      kernel: kernelPackage.manifest,
    };
    await writeFile(
      join(assembled, INSTALLATION_MANIFEST),
      canonicalDevelopmentArtifactRuntimeManifestBytes(manifest),
    );
    await rm(outputRoot, { recursive: true, force: true });
    await rename(assembled, outputRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(staging, { recursive: true, force: true });

  await locateVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget: target });
  if (options.doctor !== false) {
    await doctorVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget: target });
  }
  return Object.freeze({
    rebuiltKernel,
    reusedInstallation: false,
    target,
    sourceFingerprint,
    manifestPath,
    skillFacadeEntrypoint,
    materializerExecutable,
  });
}

export async function developmentArtifactRuntimeSourceFingerprint(
  repositoryRoot: string,
): Promise<`sha256:${string}`> {
  const inputs = [
    "bun.lock",
    "tsconfig.base.json",
    "packages/artifact-tool/package.json",
    "packages/artifact-tool/src",
    "packages/contracts/package.json",
    "packages/contracts/src",
    "packages/artifact-tool/kernel/Cargo.toml",
    "packages/artifact-tool/kernel/Cargo.lock",
    "packages/artifact-tool/kernel/rust-toolchain.toml",
    "packages/artifact-tool/kernel/src",
    "packages/artifact-tool/kernel/bindings/protocol/Cargo.toml",
    "packages/artifact-tool/kernel/bindings/protocol/Cargo.lock",
    "packages/artifact-tool/kernel/bindings/protocol/build.rs",
    "packages/artifact-tool/kernel/bindings/protocol/src",
    "packages/artifact-tool/kernel/bindings/napi/Cargo.toml",
    "packages/artifact-tool/kernel/bindings/napi/Cargo.lock",
    "packages/artifact-tool/kernel/bindings/napi/build.rs",
    "packages/artifact-tool/kernel/bindings/napi/src",
    "packages/artifact-tool/kernel/bindings/napi/scripts/smoke.mjs",
    "packages/artifact-tool/kernel/bindings/package-receipt.ts",
    "scripts/materialize-artifact-kernel-packages.ts",
    "scripts/prepare-development-artifact-runtime.ts",
  ];
  const files: string[] = [];
  for (const input of inputs) {
    const absolute = join(repositoryRoot, input);
    const metadata = await stat(absolute);
    if (metadata.isDirectory()) await collectFiles(repositoryRoot, absolute, files);
    else files.push(input);
  }
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update(new Uint8Array([0]));
    hash.update(await readFile(join(repositoryRoot, path)));
    hash.update(new Uint8Array([0xff]));
  }
  const rustc = await capture(
    ["rustc", "-Vv"],
    join(repositoryRoot, "packages/artifact-tool/kernel"),
  );
  hash.update("rustc\0");
  hash.update(rustc);
  const cargo = await capture(
    ["cargo", "-V"],
    join(repositoryRoot, "packages/artifact-tool/kernel"),
  );
  hash.update("cargo\0");
  hash.update(cargo);
  const bun = await capture(["bun", "--version"], repositoryRoot);
  hash.update("bun\0");
  hash.update(bun);
  return `sha256:${hash.digest("hex")}`;
}

async function reusableInstallation(
  outputRoot: string,
  sourceFingerprint: string,
  environment: Readonly<Record<string, string>>,
  target: NativeArtifactRuntimeTarget,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(outputRoot, INSTALLATION_MANIFEST), "utf8"),
    ) as { sourceFingerprint?: unknown };
    if (manifest.sourceFingerprint !== sourceFingerprint) return false;
    await locateVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget: target });
    return true;
  } catch {
    return false;
  }
}

async function reusableReceipt(
  assetRoot: string,
  target: NativeArtifactRuntimeTarget,
  sourceFingerprint: string,
): Promise<boolean> {
  try {
    const expectedStamp = `${JSON.stringify({ schemaVersion: 1, target, sourceFingerprint })}\n`;
    const stamp = await readFile(join(assetRoot, "native", target, BUILD_STAMP), "utf8");
    if (stamp !== expectedStamp) return false;
    const receipt = await readArtifactKernelBuildReceipt(target, assetRoot);
    for (const file of receipt.runtimeFiles) {
      if (
        !(await matchesFileProof(
          join(assetRoot, "native", target, file.path),
          file.bytes,
          file.sha256,
        ))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function matchesFileProof(
  path: string,
  expectedBytes: number,
  expectedDigest: `sha256:${string}`,
): Promise<boolean> {
  if (expectedBytes <= 0 || expectedBytes > 512 * 1024 * 1024) return false;
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedBytes) return false;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > expectedBytes) return false;
      hash.update(buffer);
    }
    const after = await handle.stat();
    return (
      after.size === before.size &&
      bytes === expectedBytes &&
      `sha256:${hash.digest("hex")}` === expectedDigest
    );
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function exactMaterializerExecutable(path: string): Promise<Uint8Array> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 512 * 1024 * 1024) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Development materializer executable has an invalid size",
    );
  }
  const bytes = new Uint8Array(await readFile(path));
  const after = await stat(path);
  if (after.size !== metadata.size || bytes.byteLength !== metadata.size) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Development materializer executable changed while reading",
    );
  }
  return bytes;
}

async function buildCurrentHostKernel(
  repositoryRoot: string,
  assetRoot: string,
  target: NativeArtifactRuntimeTarget,
  sourceFingerprint: `sha256:${string}`,
): Promise<void> {
  for (const tool of ["cargo", "rustc"] as const) {
    if (!Bun.which(tool))
      throw new Error(`${tool} is required to build the local artifact runtime`);
  }
  const kernelRoot = join(repositoryRoot, "packages", "artifact-tool", "kernel");
  const napiRoot = join(kernelRoot, "bindings", "napi");
  const toolchain = Bun.TOML.parse(
    await readFile(join(kernelRoot, "rust-toolchain.toml"), "utf8"),
  ) as { toolchain?: { channel?: unknown } };
  const pinnedChannel = toolchain.toolchain?.channel;
  if (
    typeof pinnedChannel !== "string" ||
    pinnedChannel.length === 0 ||
    pinnedChannel.trim() !== pinnedChannel
  ) {
    throw new Error("Artifact kernel Rust toolchain pin is missing or malformed");
  }
  assertArtifactKernelRustcVersion(await capture(["rustc", "--version"], napiRoot), pinnedChannel);
  // rustup resolves the checked-in kernel/rust-toolchain.toml from this directory's ancestors.
  // Running from the repository root can silently select a different host default and produce a
  // native build identity that the pinned browser WASM packages correctly reject.
  await run(
    ["cargo", "build", "--locked", "--manifest-path", join(napiRoot, "Cargo.toml"), "--release"],
    napiRoot,
  );
  const temporaryAssetRoot = await mkdtemp(join(dirname(assetRoot), ".artifact-native-build-"));
  try {
    const targetDirectory = join(temporaryAssetRoot, "native", target);
    await mkdir(targetDirectory, { recursive: true });
    const nativeOutput = join(targetDirectory, "opengeni_artifact_kernel.node");
    await copyFile(join(napiRoot, "target", "release", nativeLibraryName()), nativeOutput);
    await run(["bun", "run", join(napiRoot, "scripts", "smoke.mjs")], repositoryRoot, {
      OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH: nativeOutput,
    });
    await writeArtifactKernelBuildReceipt(target, temporaryAssetRoot);
    await writeFile(
      join(targetDirectory, BUILD_STAMP),
      `${JSON.stringify({ schemaVersion: 1, target, sourceFingerprint })}\n`,
    );
    await mkdir(join(assetRoot, "native"), { recursive: true });
    const destination = join(assetRoot, "native", target);
    await rm(destination, { recursive: true, force: true });
    await rename(targetDirectory, destination);
  } finally {
    await rm(temporaryAssetRoot, { recursive: true, force: true });
  }
}

export function assertArtifactKernelRustcVersion(
  rustcVersion: string,
  pinnedChannel: string,
): void {
  const [executable, version] = rustcVersion.trim().split(/\s+/u);
  if (executable !== "rustc" || version !== pinnedChannel) {
    throw new Error(
      `Artifact kernel requires Rust ${pinnedChannel}; active compiler is ${rustcVersion.trim() || "<unknown>"}`,
    );
  }
}

async function collectFiles(root: string, directory: string, output: string[]): Promise<void> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).split("\\").join("/"));
  }
}

function developmentEnvironment(
  manifestPath: string,
  skillFacadeEntrypoint: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: manifestPath,
    [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: skillFacadeEntrypoint,
    NODE_ENV: "development",
  });
}

function descriptor(path: string, bytes: Uint8Array) {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const,
  };
}

function currentNativeTarget(): NativeArtifactRuntimeTarget {
  const target = resolveCurrentArtifactRuntimeTarget();
  if (target === "wasm-web") throw new Error("Current development host is not native");
  return target;
}

function nativeLibraryName(): string {
  if (process.platform === "darwin") return "libopengeni_artifact_kernel_napi.dylib";
  if (process.platform === "linux") return "libopengeni_artifact_kernel_napi.so";
  if (process.platform === "win32") return "opengeni_artifact_kernel_napi.dll";
  throw new Error(`Unsupported native build platform: ${process.platform}`);
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new TypeError("outputRoot must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path) || resolve(path) === resolve("/")) {
    throw new TypeError(`${name} must be a non-root absolute path`);
  }
}

function developmentOutputName(repositoryRoot: string, outputRoot: string): string {
  const normalized = resolve(outputRoot);
  const localRoot = resolve(resolve(repositoryRoot), ".opengeni");
  const fromLocalRoot = relative(localRoot, normalized);
  if (
    fromLocalRoot === "" ||
    fromLocalRoot === ".." ||
    fromLocalRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromLocalRoot) ||
    fromLocalRoot.includes("/") ||
    fromLocalRoot.includes("\\")
  ) {
    throw new TypeError(
      "outputRoot must be a direct child of the repository's ignored .opengeni root",
    );
  }
  return fromLocalRoot;
}

async function run(
  command: string[],
  cwd: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function capture(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || `Command failed: ${command.join(" ")}`);
  return stdout;
}

function parseArguments(args: readonly string[]): PrepareDevelopmentArtifactRuntimeOptions {
  const values = new Map<string, string>();
  const allowed = new Set(["--repository-root", "--output", "--asset-root"]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || !value || values.has(name)) {
      throw new TypeError(`Invalid or duplicate option: ${name ?? "<missing>"}`);
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new TypeError(`${name} is required`);
    return value;
  };
  const assetRoot = values.get("--asset-root");
  return {
    repositoryRoot: required("--repository-root"),
    outputRoot: required("--output"),
    ...(assetRoot ? { assetRoot } : {}),
  };
}

if (import.meta.main) {
  const prepared = await prepareDevelopmentArtifactRuntime(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
}
