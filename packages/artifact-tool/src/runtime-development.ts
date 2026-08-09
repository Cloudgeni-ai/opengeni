import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalArtifactKernelBuildReceiptBytes,
  validateArtifactKernelBuildReceipt,
  type ArtifactKernelBuildReceipt,
} from "./runtime-receipt";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ArtifactRuntimeError,
  loadArtifactKernelRuntime,
  validateArtifactKernelPackageManifest,
  type ArtifactKernelPackageManifest,
  type ArtifactKernelRuntime,
  type ArtifactRuntimeKernelDependencies,
  type NativeArtifactRuntimeTarget,
} from "./runtime";
import {
  doctorVerifiedArtifactRuntime,
  loadVerifiedArtifactKernelRuntime,
  probeVerifiedArtifactSkillFacade,
  resolveCurrentArtifactRuntimeTarget,
  runArtifactRuntimeCli,
  runVerifiedArtifactPublicationCli,
  type VerifiedArtifactRuntimeLocation,
} from "./runtime-cli";

export const DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT = {
  manifest: "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST",
} as const;

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_JAVASCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_KERNEL_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_MATERIALIZER_EXECUTABLE_BYTES = 512 * 1024 * 1024;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type FileDescriptor = Readonly<{
  path: string;
  bytes: number;
  sha256: `sha256:${string}`;
}>;

export type DevelopmentArtifactRuntimeManifest = Readonly<{
  schemaVersion: 1;
  mode: "development-current-host";
  target: NativeArtifactRuntimeTarget;
  sourceFingerprint: `sha256:${string}`;
  artifactTool: Readonly<{
    packageName: "@opengeni/artifact-tool";
    packageVersion: string;
  }>;
  artifactToolIdentity: FileDescriptor;
  receipt: FileDescriptor;
  skillFacadeEntrypoint: FileDescriptor;
  materializerExecutable: FileDescriptor;
  kernelPackageRoot: string;
  kernel: ArtifactKernelPackageManifest;
}>;

export type VerifiedDevelopmentArtifactRuntimeLocation = Readonly<{
  schemaVersion: 1;
  mode: "development-current-host";
  target: NativeArtifactRuntimeTarget;
  manifestPath: string;
  receiptPath: string;
  artifactTool: DevelopmentArtifactRuntimeManifest["artifactTool"];
  skillFacadeEntrypoint: string;
  materializerExecutable: string;
  kernel: Readonly<{
    packageName: string;
    packageVersion: string;
    entrypoint: string;
    asset: string;
    supportFiles: readonly string[];
    buildIdentity: string;
  }>;
}>;

export type ConfiguredArtifactRuntimeLocation =
  | VerifiedArtifactRuntimeLocation
  | VerifiedDevelopmentArtifactRuntimeLocation;

export type VerifiedConfiguredArtifactKernelRuntime = Readonly<{
  location: ConfiguredArtifactRuntimeLocation;
  runtime: ArtifactKernelRuntime;
}>;

/** True when any production/development runtime authority was explicitly supplied. */
export function isArtifactRuntimeConfigured(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return [
    ARTIFACT_RUNTIME_ENVIRONMENT.manifest,
    ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint,
    DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest,
  ].some((name) => typeof environment[name] === "string");
}

export function validateDevelopmentArtifactRuntimeManifest(
  value: unknown,
  expectedTarget?: NativeArtifactRuntimeTarget,
): DevelopmentArtifactRuntimeManifest {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "mode",
      "target",
      "sourceFingerprint",
      "artifactTool",
      "artifactToolIdentity",
      "receipt",
      "skillFacadeEntrypoint",
      "materializerExecutable",
      "kernelPackageRoot",
      "kernel",
    ],
    "development runtime manifest",
  );
  if (record.schemaVersion !== 1 || record.mode !== "development-current-host") {
    invalid("development runtime schema/mode is invalid");
  }
  if (record.target === "wasm-web") invalid("development server runtime must be native");
  const kernel = validateArtifactKernelPackageManifest(record.kernel);
  if (kernel.kind !== "native" || kernel.target !== record.target) {
    invalid("development runtime target differs from its native kernel");
  }
  if (expectedTarget && kernel.target !== expectedTarget) {
    invalid(`development runtime target ${kernel.target} does not match ${expectedTarget}`);
  }
  const artifactTool = exactRecord(
    record.artifactTool,
    ["packageName", "packageVersion"],
    "development artifact-tool identity",
  );
  if (
    artifactTool.packageName !== "@opengeni/artifact-tool" ||
    artifactTool.packageVersion !== kernel.artifactToolVersion
  ) {
    invalid("development artifact-tool identity differs from its kernel");
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: "development-current-host",
    target: kernel.target as NativeArtifactRuntimeTarget,
    sourceFingerprint: digest(record.sourceFingerprint, "development source fingerprint"),
    artifactTool: Object.freeze({
      packageName: "@opengeni/artifact-tool",
      packageVersion: kernel.artifactToolVersion,
    }),
    artifactToolIdentity: fileDescriptor(
      record.artifactToolIdentity,
      "development artifact-tool identity file",
    ),
    receipt: fileDescriptor(record.receipt, "development build receipt"),
    skillFacadeEntrypoint: fileDescriptor(record.skillFacadeEntrypoint, "development skill facade"),
    materializerExecutable: fileDescriptor(
      record.materializerExecutable,
      "development materializer executable",
    ),
    kernelPackageRoot: safeRelativePath(record.kernelPackageRoot, "development kernel root"),
    kernel,
  });
}

export function canonicalDevelopmentArtifactRuntimeManifestBytes(value: unknown): Uint8Array {
  const manifest = validateDevelopmentArtifactRuntimeManifest(value);
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function canonicalDevelopmentArtifactToolIdentityBytes(
  artifactTool: DevelopmentArtifactRuntimeManifest["artifactTool"],
): Uint8Array {
  if (
    artifactTool.packageName !== "@opengeni/artifact-tool" ||
    !stableVersion(artifactTool.packageVersion)
  ) {
    invalid("development artifact-tool identity is invalid");
  }
  return new TextEncoder().encode(`${JSON.stringify(artifactTool, null, 2)}\n`);
}

export async function locateVerifiedDevelopmentArtifactRuntime(
  options: {
    environment?: RuntimeEnvironment;
    expectedTarget?: NativeArtifactRuntimeTarget;
  } = {},
): Promise<VerifiedDevelopmentArtifactRuntimeLocation> {
  const environment = options.environment ?? process.env;
  assertDevelopmentEnvironment(environment);
  const expectedTarget = options.expectedTarget ?? currentNativeTarget();
  const manifestInput = requiredPath(
    environment,
    DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest,
  );
  const facadeInput = requiredPath(environment, ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint);
  const manifestPath = await canonicalFile(manifestInput, "development runtime manifest");
  const manifestBytes = await readBoundedFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
    "development runtime manifest",
  );
  const manifest = validateDevelopmentArtifactRuntimeManifest(
    parseJson(manifestBytes, "development runtime manifest"),
    expectedTarget,
  );
  if (!sameBytes(manifestBytes, canonicalDevelopmentArtifactRuntimeManifestBytes(manifest))) {
    integrity("Development runtime manifest is not canonical");
  }
  const root = await realpath(resolve(manifestPath, ".."));
  const identityPath = await confinedFile(
    root,
    manifest.artifactToolIdentity.path,
    "artifact-tool identity",
  );
  const receiptPath = await confinedFile(root, manifest.receipt.path, "kernel build receipt");
  const skillFacadeEntrypoint = await confinedFile(
    root,
    manifest.skillFacadeEntrypoint.path,
    "development skill facade",
  );
  const materializerExecutable = await confinedFile(
    root,
    manifest.materializerExecutable.path,
    "development materializer executable",
  );
  const configuredFacade = await canonicalFile(facadeInput, "configured development skill facade");
  if (configuredFacade !== skillFacadeEntrypoint) {
    integrity(
      `${ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint} differs from the development manifest`,
    );
  }
  const kernelRoot = await confinedDirectory(
    root,
    manifest.kernelPackageRoot,
    "kernel package root",
  );
  const kernelEntrypoint = await confinedFile(
    kernelRoot,
    manifest.kernel.entrypoint.path,
    "kernel entrypoint",
  );
  const kernelAsset = await confinedFile(kernelRoot, manifest.kernel.asset.path, "kernel asset");
  const kernelSupportFiles = await Promise.all(
    manifest.kernel.supportFiles.map((file, index) =>
      confinedFile(kernelRoot, file.path, `kernel support file ${index}`),
    ),
  );

  const identityBytes = await readAndVerify(
    identityPath,
    manifest.artifactToolIdentity,
    MAX_IDENTITY_BYTES,
    "artifact-tool identity",
  );
  if (
    !sameBytes(identityBytes, canonicalDevelopmentArtifactToolIdentityBytes(manifest.artifactTool))
  ) {
    integrity("Development artifact-tool identity bytes differ from the manifest");
  }
  const receiptBytes = await readAndVerify(
    receiptPath,
    manifest.receipt,
    MAX_RECEIPT_BYTES,
    "kernel build receipt",
  );
  const receipt = validateArtifactKernelBuildReceipt(
    parseJson(receiptBytes, "kernel build receipt"),
    manifest.target,
  );
  if (!sameBytes(receiptBytes, canonicalArtifactKernelBuildReceiptBytes(receipt))) {
    integrity("Development kernel receipt is not canonical");
  }
  assertReceiptMatchesKernel(receipt, manifest.kernel);
  await verifyFile(
    skillFacadeEntrypoint,
    manifest.skillFacadeEntrypoint,
    MAX_JAVASCRIPT_BYTES,
    "development skill facade",
  );
  await verifyFile(
    materializerExecutable,
    manifest.materializerExecutable,
    MAX_MATERIALIZER_EXECUTABLE_BYTES,
    "development materializer executable",
  );
  await verifyFile(
    kernelEntrypoint,
    manifest.kernel.entrypoint,
    MAX_JAVASCRIPT_BYTES,
    "kernel entrypoint",
  );
  await verifyFile(kernelAsset, manifest.kernel.asset, MAX_KERNEL_ASSET_BYTES, "kernel asset");
  for (const [index, path] of kernelSupportFiles.entries()) {
    await verifyFile(
      path,
      manifest.kernel.supportFiles[index]!,
      MAX_JAVASCRIPT_BYTES,
      `kernel support file ${index}`,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: "development-current-host",
    target: manifest.target,
    manifestPath,
    receiptPath,
    artifactTool: Object.freeze({ ...manifest.artifactTool }),
    skillFacadeEntrypoint,
    materializerExecutable,
    kernel: Object.freeze({
      packageName: manifest.kernel.packageName,
      packageVersion: manifest.kernel.packageVersion,
      entrypoint: kernelEntrypoint,
      asset: kernelAsset,
      supportFiles: Object.freeze(kernelSupportFiles),
      buildIdentity: manifest.kernel.buildIdentity,
    }),
  });
}

export async function doctorVerifiedDevelopmentArtifactRuntime(
  options: {
    environment?: RuntimeEnvironment;
    expectedTarget?: NativeArtifactRuntimeTarget;
    importer?: (specifier: string) => unknown | Promise<unknown>;
    probe?: (module: Record<string, unknown>) => void | Promise<void>;
  } = {},
): Promise<VerifiedDevelopmentArtifactRuntimeLocation> {
  const location = await locateVerifiedDevelopmentArtifactRuntime(options);
  let imported: unknown;
  try {
    imported = await (options.importer ?? defaultImporter)(
      pathToFileURL(location.skillFacadeEntrypoint).href,
    );
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "Verified development skill facade could not be evaluated",
      { cause },
    );
  }
  if (!isRecord(imported)) incompatible("development skill facade returned an invalid module");
  if (options.probe) await options.probe(imported);
  else probeVerifiedArtifactSkillFacade(imported, location);
  return location;
}

export async function loadVerifiedDevelopmentArtifactKernelRuntime(
  options: {
    environment?: RuntimeEnvironment;
    expectedTarget?: NativeArtifactRuntimeTarget;
  } = {},
): Promise<VerifiedConfiguredArtifactKernelRuntime> {
  const environment = options.environment ?? process.env;
  const expectedTarget = options.expectedTarget ?? currentNativeTarget();
  const before = await locateVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget });
  const manifest = validateDevelopmentArtifactRuntimeManifest(
    parseJson(
      await readBoundedFile(
        before.manifestPath,
        MAX_MANIFEST_BYTES,
        "development runtime manifest",
      ),
      "development runtime manifest",
    ),
    expectedTarget,
  );
  const kernelRoot = pathToFileURL(
    `${resolve(before.manifestPath, "..", manifest.kernelPackageRoot)}/`,
  );
  const dependencies: ArtifactRuntimeKernelDependencies = {
    target: {
      target: manifest.target,
      kind: "native",
      packageName: manifest.kernel.packageName,
      platform: manifest.target.startsWith("darwin-")
        ? "darwin"
        : manifest.target.startsWith("linux-")
          ? "linux"
          : "win32",
      arch: manifest.target.includes("arm64") ? "arm64" : "x64",
      ...(manifest.target.includes("-gnu")
        ? { libc: "gnu" as const }
        : manifest.target.includes("-musl")
          ? { libc: "musl" as const }
          : {}),
    },
    kernelEntrypoint: new URL(manifest.kernel.entrypoint.path, kernelRoot),
    manifest: {
      kernel: manifest.kernel,
    },
  };
  const runtime = await loadArtifactKernelRuntime(dependencies);
  const after = await locateVerifiedDevelopmentArtifactRuntime({ environment, expectedTarget });
  if (
    !sameJson(before, after) ||
    runtime.kind !== "native" ||
    runtime.target !== after.target ||
    runtime.buildIdentity !== after.kernel.buildIdentity
  ) {
    integrity("Loaded development kernel differs from its verified installation");
  }
  return Object.freeze({ location: after, runtime });
}

export async function doctorConfiguredArtifactRuntime(
  environment: RuntimeEnvironment = process.env,
): Promise<ConfiguredArtifactRuntimeLocation> {
  return usesDevelopmentRuntime(environment)
    ? await doctorVerifiedDevelopmentArtifactRuntime({ environment })
    : await doctorVerifiedArtifactRuntime({ environment });
}

export async function loadConfiguredArtifactKernelRuntime(
  environment: RuntimeEnvironment = process.env,
): Promise<VerifiedConfiguredArtifactKernelRuntime> {
  return usesDevelopmentRuntime(environment)
    ? await loadVerifiedDevelopmentArtifactKernelRuntime({ environment })
    : await loadVerifiedArtifactKernelRuntime({ environment });
}

export async function runConfiguredArtifactRuntimeCli(
  args: readonly string[],
  environment: RuntimeEnvironment = process.env,
): Promise<string> {
  if (!usesDevelopmentRuntime(environment)) return await runArtifactRuntimeCli(args, environment);
  if (args[0] === "prepare-publication") {
    const location = await doctorVerifiedDevelopmentArtifactRuntime({ environment });
    return await runVerifiedArtifactPublicationCli(args, location);
  }
  const [command, format, ...rest] = args;
  if ((command !== "locate" && command !== "doctor") || format !== "--json" || rest.length > 0) {
    invalid(
      "Usage: opengeni-artifact-runtime <locate|doctor> --json | opengeni-artifact-runtime prepare-publication --json --modality <spreadsheet|document|presentation> --input <absolute-office-file> --snapshot-output <absolute-new-file>",
    );
  }
  const location =
    command === "doctor"
      ? await doctorVerifiedDevelopmentArtifactRuntime({ environment })
      : await locateVerifiedDevelopmentArtifactRuntime({ environment });
  return `${JSON.stringify(location)}\n`;
}

function usesDevelopmentRuntime(environment: RuntimeEnvironment): boolean {
  return Boolean(environment[DEVELOPMENT_ARTIFACT_RUNTIME_ENVIRONMENT.manifest]);
}

function assertDevelopmentEnvironment(environment: RuntimeEnvironment): void {
  if (environment.NODE_ENV === "production") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "Development artifact runtime is forbidden when NODE_ENV=production",
    );
  }
  if (environment[ARTIFACT_RUNTIME_ENVIRONMENT.manifest]) {
    invalid("Production and development artifact runtime manifests cannot both be configured");
  }
}

function currentNativeTarget(): NativeArtifactRuntimeTarget {
  const target = resolveCurrentArtifactRuntimeTarget();
  if (target === "wasm-web") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
      "Development server runtime requires a native host",
    );
  }
  return target;
}

function assertReceiptMatchesKernel(
  receipt: ArtifactKernelBuildReceipt,
  kernel: ArtifactKernelPackageManifest,
): void {
  const runtimeFiles = [kernel.asset, ...kernel.supportFiles].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    receipt.buildIdentity !== kernel.buildIdentity ||
    !sameJson(receipt.runtimeFiles, runtimeFiles)
  ) {
    integrity("Development build receipt differs from its kernel manifest");
  }
}

async function confinedFile(root: string, path: string, name: string): Promise<string> {
  return await confined(root, path, name, "file");
}

async function confinedDirectory(root: string, path: string, name: string): Promise<string> {
  return await confined(root, path, name, "directory");
}

async function confined(
  root: string,
  path: string,
  name: string,
  kind: "file" | "directory",
): Promise<string> {
  const candidate = await realpath(resolve(root, path)).catch((cause) => {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is unavailable`, {
      cause,
    });
  });
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    invalid(`${name} resolves outside the development installation`);
  }
  const metadata = await stat(candidate);
  if (
    (kind === "file" && !metadata.isFile()) ||
    (kind === "directory" && !metadata.isDirectory())
  ) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is not a ${kind}`);
  }
  return candidate;
}

async function canonicalFile(input: string, name: string): Promise<string> {
  if (!isAbsolute(input)) invalid(`${name} path must be absolute`);
  try {
    const path = await realpath(input);
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    return path;
  } catch (cause) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is unavailable`, {
      cause,
    });
  }
}

async function readAndVerify(
  path: string,
  expected: FileDescriptor,
  maximumBytes: number,
  name: string,
): Promise<Uint8Array> {
  const bytes = await readBoundedFile(path, maximumBytes, name);
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    integrity(`${name} differs from the development manifest`);
  }
  return bytes;
}

async function verifyFile(
  path: string,
  expected: FileDescriptor,
  maximumBytes: number,
  name: string,
): Promise<void> {
  await readAndVerify(path, expected, maximumBytes, name);
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  name: string,
): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      integrity(`${name} size is invalid`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      integrity(`${name} changed while reading`);
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof ArtifactRuntimeError) throw cause;
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `Could not read ${name}`, {
      cause,
    });
  } finally {
    await handle?.close();
  }
}

function fileDescriptor(value: unknown, name: string): FileDescriptor {
  const record = exactRecord(value, ["path", "bytes", "sha256"], name);
  if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) <= 0) {
    invalid(`${name} byte size is invalid`);
  }
  return Object.freeze({
    path: safeRelativePath(record.path, `${name} path`),
    bytes: record.bytes as number,
    sha256: digest(record.sha256, `${name} digest`),
  });
}

function safeRelativePath(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[%?#\0]/u.test(value)
  ) {
    invalid(`${name} must be a normalized relative path`);
  }
  return value;
}

function digest(value: unknown, name: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value as `sha256:${string}`;
}

function stableVersion(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)
  );
}

function requiredPath(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is required`);
  }
  return value;
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `${name} is not strict UTF-8 JSON`,
      { cause },
    );
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${name} is invalid`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    invalid(`${name} has unexpected fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function defaultImporter(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

function invalid(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_MANIFEST_INVALID", message);
}

function integrity(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INTEGRITY", message);
}

function incompatible(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INCOMPATIBLE", message);
}
