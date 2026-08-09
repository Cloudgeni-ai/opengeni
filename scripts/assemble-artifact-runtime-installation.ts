#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  ARTIFACT_KERNEL_BUILD_RECEIPT,
  canonicalArtifactKernelBuildReceiptBytes,
  validateArtifactKernelBuildReceipt,
} from "../packages/artifact-tool/kernel/bindings/package-receipt";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ArtifactRuntimeError,
  validateArtifactKernelPackageManifest,
  validateCompleteArtifactRuntimeReleaseManifest,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeInstallationManifest,
  type ArtifactRuntimeTarget,
} from "../packages/artifact-tool/src/runtime";
import {
  canonicalArtifactRuntimeInstallationManifestBytes,
  canonicalArtifactRuntimeReleaseManifestBytes,
  locateVerifiedArtifactRuntime,
  type VerifiedArtifactRuntimeLocation,
} from "../packages/artifact-tool/src/runtime-cli";
import { renderArtifactSkillFacadeBootstrap } from "./materialize-artifact-kernel-packages";

const RELEASE_MANIFEST = "artifact-runtime-release-manifest.json";
const PACKAGE_MANIFEST = "artifact-kernel-manifest.json";
const SKILL_FACADE = "skill-facade-entry.mjs";
const INSTALLATION_MANIFEST = "installation.json";
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACT_TOOL_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_TOOL_TAR_BYTES = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;

export type AssembleArtifactRuntimeInstallationOptions = Readonly<{
  releaseManifestPath: string;
  kernelPackageRoot: string;
  artifactToolTarballPath: string;
  outputRoot: string;
  target: ArtifactRuntimeTarget;
}>;

/**
 * Assembles one relocatable runtime root from exact, already-produced local
 * release inputs. This function performs no package resolution or network IO.
 */
export async function assembleArtifactRuntimeInstallation(
  options: AssembleArtifactRuntimeInstallationOptions,
): Promise<VerifiedArtifactRuntimeLocation> {
  for (const [name, path] of Object.entries({
    releaseManifestPath: options.releaseManifestPath,
    kernelPackageRoot: options.kernelPackageRoot,
    artifactToolTarballPath: options.artifactToolTarballPath,
    outputRoot: options.outputRoot,
  })) {
    requireAbsolute(path, name);
  }
  rejectBroadOutput(options.outputRoot);

  const releaseBytes = await exactFile(
    options.releaseManifestPath,
    MAX_RELEASE_MANIFEST_BYTES,
    "complete artifact runtime release manifest",
  );
  const release = validateCompleteArtifactRuntimeReleaseManifest(
    parseJson(releaseBytes, "release manifest"),
  );
  if (!sameBytes(releaseBytes, canonicalArtifactRuntimeReleaseManifestBytes(release))) {
    throw integrity("Release manifest is not canonical");
  }
  const releasedKernel = release.targets.find(({ target }) => target === options.target);
  if (!releasedKernel) throw integrity(`Release manifest does not contain ${options.target}`);

  const artifactToolTarball = await exactFile(
    options.artifactToolTarballPath,
    MAX_ARTIFACT_TOOL_TARBALL_BYTES,
    "packed artifact-tool tarball",
  );
  const tarballIntegrity = `sha512-${createHash("sha512").update(artifactToolTarball).digest("base64")}`;
  if (tarballIntegrity !== release.artifactTool.integrity) {
    throw integrity("Packed artifact-tool integrity differs from the release manifest");
  }
  const packedArtifactTool = parseJson(
    packedPackageJson(artifactToolTarball),
    "packed artifact-tool package.json",
  );
  if (
    !isRecord(packedArtifactTool) ||
    packedArtifactTool.name !== release.artifactTool.packageName ||
    packedArtifactTool.version !== release.artifactTool.packageVersion
  ) {
    throw integrity("Packed artifact-tool identity differs from the release manifest");
  }

  const packageRoot = await canonicalDirectory(options.kernelPackageRoot, "kernel package root");
  const packageManifestBytes = await confinedFile(
    packageRoot,
    PACKAGE_MANIFEST,
    MAX_PACKAGE_MANIFEST_BYTES,
    "kernel package manifest",
  );
  const packageManifest = validateArtifactKernelPackageManifest(
    parseJson(packageManifestBytes, "kernel package manifest"),
    options.target,
  );
  if (!sameBytes(packageManifestBytes, canonicalJsonBytes(packageManifest))) {
    throw integrity("Kernel package manifest is not canonical");
  }
  if (!sameJson(packageManifest, releasedKernel)) {
    throw integrity("Kernel package manifest differs from its complete release target");
  }
  await verifyKernelPackageMetadata(packageRoot, packageManifest);

  const receiptBytes = await confinedFile(
    packageRoot,
    ARTIFACT_KERNEL_BUILD_RECEIPT,
    MAX_RECEIPT_BYTES,
    "kernel build receipt",
  );
  const receipt = validateArtifactKernelBuildReceipt(
    parseJson(receiptBytes, "kernel build receipt"),
    options.target,
  );
  if (!sameBytes(receiptBytes, canonicalArtifactKernelBuildReceiptBytes(receipt))) {
    throw integrity("Kernel build receipt is not canonical");
  }
  if (
    receipt.buildIdentity !== packageManifest.buildIdentity ||
    !sameJson(
      receipt.runtimeFiles,
      [packageManifest.asset, ...packageManifest.supportFiles].sort(comparePath),
    )
  ) {
    throw integrity("Kernel build receipt differs from the package runtime files");
  }

  const runtimeFiles = await Promise.all(
    [packageManifest.entrypoint, packageManifest.asset, ...packageManifest.supportFiles].map(
      async (descriptor) => ({
        descriptor,
        bytes: await verifiedPackageFile(packageRoot, descriptor),
      }),
    ),
  );
  const facadeBytes = new TextEncoder().encode(
    renderArtifactSkillFacadeBootstrap(packageManifest, {
      kernelSpecifier: "./kernel/index.js",
    }),
  );

  const outputParent = dirname(options.outputRoot);
  await mkdir(outputParent, { recursive: true });
  await rejectSymlinkIfPresent(options.outputRoot);
  const stagingRoot = await mkdtemp(join(outputParent, ".artifact-runtime-installation-"));
  try {
    await mkdir(join(stagingRoot, "kernel"), { recursive: true });
    await Promise.all([
      writeFile(join(stagingRoot, RELEASE_MANIFEST), releaseBytes, { mode: 0o444 }),
      writeFile(join(stagingRoot, SKILL_FACADE), facadeBytes, { mode: 0o444 }),
      ...runtimeFiles.map(({ descriptor, bytes }) =>
        writeFile(join(stagingRoot, "kernel", descriptor.path), bytes, { mode: 0o444 }),
      ),
    ]);

    const installation: ArtifactRuntimeInstallationManifest = {
      schemaVersion: 1,
      target: options.target,
      releaseManifest: fileDescriptor(RELEASE_MANIFEST, releaseBytes),
      artifactTool: release.artifactTool,
      skillFacadeEntrypoint: fileDescriptor(SKILL_FACADE, facadeBytes),
      kernelPackageRoot: "kernel",
      kernel: packageManifest,
    };
    await writeFile(
      join(stagingRoot, INSTALLATION_MANIFEST),
      canonicalArtifactRuntimeInstallationManifestBytes(installation),
      { mode: 0o444 },
    );

    await rm(options.outputRoot, { recursive: true, force: true });
    await rename(stagingRoot, options.outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return await locateVerifiedArtifactRuntime({
    environment: {
      [ARTIFACT_RUNTIME_ENVIRONMENT.manifest]: join(options.outputRoot, INSTALLATION_MANIFEST),
      [ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint]: join(options.outputRoot, SKILL_FACADE),
    },
    expectedTarget: options.target,
  });
}

async function verifyKernelPackageMetadata(
  packageRoot: string,
  manifest: ArtifactKernelPackageManifest,
): Promise<void> {
  const packageJson = parseJson(
    await confinedFile(packageRoot, "package.json", MAX_PACKAGE_JSON_BYTES, "kernel package.json"),
    "kernel package.json",
  );
  if (
    !isRecord(packageJson) ||
    packageJson.name !== manifest.packageName ||
    packageJson.version !== manifest.packageVersion ||
    packageJson.type !== "module"
  ) {
    throw integrity("Kernel package.json identity differs from its package manifest");
  }
}

async function verifiedPackageFile(
  packageRoot: string,
  descriptor: Readonly<{ path: string; bytes: number; sha256: `sha256:${string}` }>,
): Promise<Uint8Array> {
  const bytes = await confinedFile(
    packageRoot,
    descriptor.path,
    MAX_RUNTIME_FILE_BYTES,
    `kernel runtime file ${descriptor.path}`,
  );
  if (bytes.byteLength !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw integrity(`Kernel runtime file ${descriptor.path} differs from its package manifest`);
  }
  return bytes;
}

async function confinedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  name: string,
): Promise<Uint8Array> {
  const candidate = join(root, relativePath);
  const canonical = await realpath(candidate).catch((cause) => {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is unavailable`, {
      cause,
    });
  });
  const fromRoot = relative(root, canonical);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `${name} escapes the kernel package root`,
    );
  }
  return await exactFile(canonical, maximumBytes, name);
}

async function exactFile(path: string, maximumBytes: number, name: string): Promise<Uint8Array> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (cause) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is unavailable`, {
      cause,
    });
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw integrity(`${name} has an invalid size`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const after = await stat(path);
  if (after.size !== metadata.size || bytes.byteLength !== metadata.size) {
    throw integrity(`${name} changed while reading`);
  }
  return bytes;
}

async function canonicalDirectory(path: string, name: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (cause) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is unavailable`, {
      cause,
    });
  }
}

function packedPackageJson(compressed: Uint8Array): Uint8Array {
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_ARTIFACT_TOOL_TAR_BYTES });
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Packed artifact-tool is not a bounded gzip tarball",
      { cause },
    );
  }
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/u.test(sizeText)) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_MANIFEST_INVALID",
        "Packed artifact-tool tar header has an invalid size",
      );
    }
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || bodyEnd > archive.byteLength) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_MANIFEST_INVALID",
        "Packed artifact-tool tar entry is truncated",
      );
    }
    if (path === "package/package.json") {
      if (size <= 0 || size > MAX_PACKAGE_JSON_BYTES) {
        throw integrity("Packed artifact-tool package.json has an invalid size");
      }
      return new Uint8Array(archive.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw integrity("Packed artifact-tool tarball is missing package/package.json");
}

function tarString(value: Uint8Array): string {
  const end = value.indexOf(0);
  return Buffer.from(end === -1 ? value : value.subarray(0, end)).toString("utf8");
}

function parseJson(value: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `${name} is not strict UTF-8 JSON`,
      { cause },
    );
  }
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function fileDescriptor(path: string, bytes: Uint8Array) {
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) } as const;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function comparePath(left: Readonly<{ path: string }>, right: Readonly<{ path: string }>): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
}

function rejectBroadOutput(path: string): void {
  const normalized = resolve(path);
  if (normalized === resolve("/") || normalized === dirname(normalized)) {
    throw new TypeError("outputRoot is too broad");
  }
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new TypeError("outputRoot must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function integrity(message: string): ArtifactRuntimeError {
  return new ArtifactRuntimeError("ARTIFACT_RUNTIME_INTEGRITY", message);
}

type ParsedArguments = AssembleArtifactRuntimeInstallationOptions;

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--release-manifest",
    "--kernel-package-root",
    "--artifact-tool-tarball",
    "--output",
    "--target",
  ]);
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
  return {
    releaseManifestPath: required("--release-manifest"),
    kernelPackageRoot: required("--kernel-package-root"),
    artifactToolTarballPath: required("--artifact-tool-tarball"),
    outputRoot: required("--output"),
    target: required("--target") as ArtifactRuntimeTarget,
  };
}

if (import.meta.main) {
  const location = await assembleArtifactRuntimeInstallation(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(location)}\n`);
}
