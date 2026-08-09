#!/usr/bin/env node

import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ARTIFACT_RUNTIME_ENVIRONMENT,
  ArtifactRuntimeError,
  loadArtifactKernelRuntime,
  locateArtifactRuntimeDependencies,
  resolveArtifactRuntimeTarget,
  validateArtifactRuntimeInstallationManifest,
  validateCompleteArtifactRuntimeReleaseManifest,
  type ArtifactKernelRuntime,
  type ArtifactRuntimeInstallationManifest,
  type ArtifactRuntimeTarget,
} from "./runtime";

const MAX_INSTALLATION_MANIFEST_BYTES = 256 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_TOOL_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JAVASCRIPT_ENTRYPOINT_BYTES = 32 * 1024 * 1024;
const MAX_SKILL_FACADE_SUPPORT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_KERNEL_ASSET_BYTES = 512 * 1024 * 1024;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type VerifiedArtifactRuntimeLocation = Readonly<{
  schemaVersion: 1;
  target: ArtifactRuntimeTarget;
  manifestPath: string;
  releaseManifestPath: string;
  artifactTool: Readonly<{
    packageName: "@opengeni/artifact-tool";
    packageVersion: string;
    integrity: `sha512-${string}`;
  }>;
  artifactToolArchive?: string;
  skillFacadeEntrypoint: string;
  skillFacadeSupportFiles?: readonly string[];
  kernel: Readonly<{
    packageName: string;
    packageVersion: string;
    entrypoint: string;
    asset: string;
    supportFiles: readonly string[];
    buildIdentity: string;
  }>;
}>;

export type LocateArtifactRuntimeOptions = Readonly<{
  environment?: RuntimeEnvironment;
  /** Test/build override. The executable always derives the current host target. */
  expectedTarget?: ArtifactRuntimeTarget;
}>;

export type DoctorArtifactRuntimeOptions = LocateArtifactRuntimeOptions &
  Readonly<{
    importer?: (specifier: string) => unknown | Promise<unknown>;
    probe?: (module: Record<string, unknown>) => void | Promise<void>;
  }>;

export type VerifiedArtifactKernelRuntime = Readonly<{
  location: VerifiedArtifactRuntimeLocation;
  runtime: ArtifactKernelRuntime;
}>;

/**
 * Verifies the complete local release/install chain without evaluating any
 * package code. All reads are local, bounded, streamed where large, and pinned
 * to exact byte counts plus SHA-256 digests.
 */
export async function locateVerifiedArtifactRuntime(
  options: LocateArtifactRuntimeOptions = {},
): Promise<VerifiedArtifactRuntimeLocation> {
  const environment = options.environment ?? process.env;
  const manifestInput = requiredEnvironmentPath(environment, ARTIFACT_RUNTIME_ENVIRONMENT.manifest);
  const facadeInput = requiredEnvironmentPath(
    environment,
    ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint,
  );
  const expectedTarget = options.expectedTarget ?? resolveCurrentArtifactRuntimeTarget();

  const manifestPath = await canonicalFile(manifestInput, "installation manifest");
  const installationFile = await readInstallationManifest(manifestPath);
  const installation = installationFile.manifest;
  const dependencies = locateArtifactRuntimeDependencies(
    installation,
    pathToFileURL(manifestPath),
    expectedTarget,
  );
  assertCanonicalInstallationManifest(installationFile.bytes, dependencies.manifest);
  const installationRoot = await realpath(resolve(manifestPath, ".."));

  const releaseManifestPath = await confinedCanonicalFile(
    dependencies.releaseManifestUrl,
    installationRoot,
    "release manifest",
  );
  const artifactToolArchive = dependencies.artifactToolArchiveUrl
    ? await confinedCanonicalFile(
        dependencies.artifactToolArchiveUrl,
        installationRoot,
        "artifact-tool archive",
      )
    : undefined;
  const skillFacadeEntrypoint = await confinedCanonicalFile(
    dependencies.skillFacadeEntrypoint,
    installationRoot,
    "skill facade entrypoint",
  );
  const skillFacadeSupportFiles = await Promise.all(
    dependencies.skillFacadeSupportFiles.map((url, index) =>
      confinedCanonicalFile(url, installationRoot, `skill facade support file ${index}`),
    ),
  );
  const kernelEntrypoint = await confinedCanonicalFile(
    dependencies.kernelEntrypoint,
    installationRoot,
    "kernel entrypoint",
  );
  const kernelAsset = await confinedCanonicalFile(
    dependencies.kernelAsset,
    installationRoot,
    "kernel asset",
  );
  const kernelSupportFiles = await Promise.all(
    dependencies.kernelSupportFiles.map((url, index) =>
      confinedCanonicalFile(url, installationRoot, `kernel support file ${index}`),
    ),
  );
  const configuredFacade = await canonicalFile(facadeInput, "configured skill facade entrypoint");
  if (configuredFacade !== skillFacadeEntrypoint) {
    integrity(
      `${ARTIFACT_RUNTIME_ENVIRONMENT.toolEntrypoint} does not name the manifest-pinned skill facade entrypoint`,
    );
  }

  const releaseBytes = await readAndVerifyFile(
    releaseManifestPath,
    installation.releaseManifest,
    MAX_RELEASE_MANIFEST_BYTES,
    "release manifest",
  );
  const release = parseReleaseManifest(releaseBytes);
  assertCanonicalReleaseManifest(releaseBytes, release);
  if (!sameJson(release.artifactTool, installation.artifactTool)) {
    integrity("Installed artifact-tool identity does not match the complete release manifest");
  }
  if (artifactToolArchive && installation.artifactToolArchive) {
    const archiveBytes = await readAndVerifyFile(
      artifactToolArchive,
      installation.artifactToolArchive,
      MAX_ARTIFACT_TOOL_ARCHIVE_BYTES,
      "artifact-tool archive",
    );
    const archiveIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
    if (archiveIntegrity !== installation.artifactTool.integrity) {
      integrity("Packed artifact-tool archive differs from its installation identity");
    }
  }
  const releasedKernel = release.targets.find((entry) => entry.target === installation.target);
  if (!releasedKernel || !sameJson(releasedKernel, installation.kernel)) {
    integrity("Installed kernel package does not match its exact release target manifest");
  }

  // Do not evaluate the facade or kernel package until every executable/data
  // file in the chain has independently passed its byte proof.
  await verifyFile(
    skillFacadeEntrypoint,
    installation.skillFacadeEntrypoint,
    MAX_JAVASCRIPT_ENTRYPOINT_BYTES,
    "skill facade entrypoint",
  );
  for (const [index, path] of skillFacadeSupportFiles.entries()) {
    await verifyFile(
      path,
      installation.skillFacadeSupportFiles![index]!,
      MAX_SKILL_FACADE_SUPPORT_FILE_BYTES,
      `skill facade support file ${index}`,
    );
  }
  await verifyFile(
    kernelEntrypoint,
    installation.kernel.entrypoint,
    MAX_JAVASCRIPT_ENTRYPOINT_BYTES,
    "kernel entrypoint",
  );
  await verifyFile(kernelAsset, installation.kernel.asset, MAX_KERNEL_ASSET_BYTES, "kernel asset");
  for (const [index, path] of kernelSupportFiles.entries()) {
    await verifyFile(
      path,
      installation.kernel.supportFiles[index]!,
      MAX_JAVASCRIPT_ENTRYPOINT_BYTES,
      `kernel support file ${index}`,
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    target: installation.target,
    manifestPath,
    releaseManifestPath,
    artifactTool: Object.freeze({ ...installation.artifactTool }),
    ...(artifactToolArchive ? { artifactToolArchive } : {}),
    skillFacadeEntrypoint,
    ...(skillFacadeSupportFiles.length > 0
      ? { skillFacadeSupportFiles: Object.freeze([...skillFacadeSupportFiles]) }
      : {}),
    kernel: Object.freeze({
      packageName: installation.kernel.packageName,
      packageVersion: installation.kernel.packageVersion,
      entrypoint: kernelEntrypoint,
      asset: kernelAsset,
      supportFiles: Object.freeze([...kernelSupportFiles]),
      buildIdentity: installation.kernel.buildIdentity,
    }),
  });
}

/** Verify first, then evaluate the one pinned bootstrap and probe its facade. */
export async function doctorVerifiedArtifactRuntime(
  options: DoctorArtifactRuntimeOptions = {},
): Promise<VerifiedArtifactRuntimeLocation> {
  const location = await locateVerifiedArtifactRuntime(options);
  const importer = options.importer ?? defaultImporter;
  let imported: unknown;
  try {
    imported = await importer(pathToFileURL(location.skillFacadeEntrypoint).href);
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "Verified skill facade bootstrap could not be evaluated",
      { cause },
    );
  }
  if (typeof imported !== "object" || imported === null || Array.isArray(imported)) {
    incompatible("skill facade bootstrap did not export a module namespace");
  }
  const module = imported as Record<string, unknown>;
  if (options.probe) {
    await options.probe(module);
  } else {
    probeVerifiedArtifactSkillFacade(module, location);
  }
  return location;
}

/**
 * Loads only the manifest-pinned native kernel package after verifying every
 * selected runtime byte. A second complete verification after evaluation
 * closes ordinary replacement races; production additionally mounts this
 * installation read-only inside the materializer sandbox.
 */
export async function loadVerifiedArtifactKernelRuntime(
  options: LocateArtifactRuntimeOptions = {},
): Promise<VerifiedArtifactKernelRuntime> {
  const environment = options.environment ?? process.env;
  const expectedTarget = options.expectedTarget ?? resolveCurrentArtifactRuntimeTarget();
  const before = await locateVerifiedArtifactRuntime({ environment, expectedTarget });
  const installation = (await readInstallationManifest(before.manifestPath)).manifest;
  const dependencies = locateArtifactRuntimeDependencies(
    installation,
    pathToFileURL(before.manifestPath),
    expectedTarget,
  );
  const runtime = await loadArtifactKernelRuntime(dependencies);
  const after = await locateVerifiedArtifactRuntime({ environment, expectedTarget });
  if (
    !sameJson(before, after) ||
    runtime.kind !== "native" ||
    runtime.target !== before.target ||
    runtime.buildIdentity !== before.kernel.buildIdentity
  ) {
    integrity("Loaded kernel runtime does not match the verified installation");
  }
  return Object.freeze({ location: after, runtime });
}

/** Deterministic bytes used by release tooling and verified by the locator. */
export function canonicalArtifactRuntimeReleaseManifestBytes(value: unknown): Uint8Array {
  const manifest = validateCompleteArtifactRuntimeReleaseManifest(value);
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Deterministic installation bytes; the strict locator rejects other encodings. */
export function canonicalArtifactRuntimeInstallationManifestBytes(value: unknown): Uint8Array {
  const manifest = validateArtifactRuntimeInstallationManifest(value);
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function resolveCurrentArtifactRuntimeTarget(): ArtifactRuntimeTarget {
  const platform = process.platform;
  const arch = process.arch;
  if (platform !== "linux") {
    return resolveArtifactRuntimeTarget({ platform, arch }).target;
  }
  return resolveArtifactRuntimeTarget({ platform, arch, libc: detectLinuxLibc() }).target;
}

export async function runArtifactRuntimeCli(
  args: readonly string[],
  environment: RuntimeEnvironment = process.env,
): Promise<string> {
  const [command, format, ...rest] = args;
  if ((command !== "locate" && command !== "doctor") || format !== "--json" || rest.length > 0) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Usage: opengeni-artifact-runtime <locate|doctor> --json",
    );
  }
  const location =
    command === "doctor"
      ? await doctorVerifiedArtifactRuntime({ environment })
      : await locateVerifiedArtifactRuntime({ environment });
  return `${JSON.stringify(location)}\n`;
}

async function readInstallationManifest(
  path: string,
): Promise<Readonly<{ manifest: ArtifactRuntimeInstallationManifest; bytes: Uint8Array }>> {
  const bytes = await readBoundedFile(
    path,
    MAX_INSTALLATION_MANIFEST_BYTES,
    "installation manifest",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Installation manifest is not strict UTF-8 JSON",
      { cause },
    );
  }
  // locateArtifactRuntimeDependencies performs the exact schema validation.
  return Object.freeze({
    manifest: parsed as ArtifactRuntimeInstallationManifest,
    bytes,
  });
}

function parseReleaseManifest(
  bytes: Uint8Array,
): ReturnType<typeof validateCompleteArtifactRuntimeReleaseManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Release manifest is not strict UTF-8 JSON",
      { cause },
    );
  }
  return validateCompleteArtifactRuntimeReleaseManifest(parsed);
}

function assertCanonicalReleaseManifest(
  actual: Uint8Array,
  manifest: ReturnType<typeof validateCompleteArtifactRuntimeReleaseManifest>,
): void {
  const canonical = canonicalArtifactRuntimeReleaseManifestBytes(manifest);
  if (!sameBytes(actual, canonical)) {
    integrity("Release manifest bytes are not in the canonical deterministic form");
  }
}

function assertCanonicalInstallationManifest(
  actual: Uint8Array,
  manifest: ArtifactRuntimeInstallationManifest,
): void {
  const canonical = canonicalArtifactRuntimeInstallationManifestBytes(manifest);
  if (!sameBytes(actual, canonical)) {
    integrity("Installation manifest bytes are not in the canonical deterministic form");
  }
}

async function confinedCanonicalFile(url: URL, root: string, name: string): Promise<string> {
  const path = await canonicalFile(fileURLToPath(url), name);
  const fromRoot = relative(root, path);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `${name} resolves outside the installation root`,
    );
  }
  return path;
}

async function canonicalFile(input: string, name: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      `${name} path must be absolute`,
    );
  }
  try {
    const path = await realpath(input);
    const metadata = await stat(path);
    if (!metadata.isFile()) unavailable(`${name} is not a regular file`);
    return path;
  } catch (cause) {
    if (cause instanceof ArtifactRuntimeError) throw cause;
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `${name} is not available`, {
      cause,
    });
  }
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
    if (!before.isFile()) unavailable(`${name} is not a regular file`);
    if (before.size <= 0 || before.size > maximumBytes) {
      integrity(`${name} size is outside its allowed bound`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      integrity(`${name} changed while it was being read`);
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

async function readAndVerifyFile(
  path: string,
  expected: Readonly<{ bytes: number; sha256: `sha256:${string}` }>,
  maximumBytes: number,
  name: string,
): Promise<Uint8Array> {
  if (expected.bytes > maximumBytes) integrity(`${name} exceeds its allowed bound`);
  const bytes = await readBoundedFile(path, maximumBytes, name);
  if (bytes.byteLength !== expected.bytes)
    integrity(`${name} byte count does not match its manifest`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== expected.sha256) integrity(`${name} digest does not match its manifest`);
  return bytes;
}

async function verifyFile(
  path: string,
  expected: Readonly<{ bytes: number; sha256: `sha256:${string}` }>,
  maximumBytes: number,
  name: string,
): Promise<void> {
  if (expected.bytes > maximumBytes) integrity(`${name} exceeds its allowed bound`);
  let handle;
  try {
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile()) unavailable(`${name} is not a regular file`);
    if (before.size !== expected.bytes) integrity(`${name} byte count does not match its manifest`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > maximumBytes || bytes > expected.bytes) integrity(`${name} exceeds its manifest`);
      hash.update(buffer);
    }
    const after = await handle.stat();
    if (after.size !== before.size || bytes !== before.size)
      integrity(`${name} changed while hashing`);
    const digest = `sha256:${hash.digest("hex")}`;
    if (digest !== expected.sha256) integrity(`${name} digest does not match its manifest`);
  } catch (cause) {
    if (cause instanceof ArtifactRuntimeError) throw cause;
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", `Could not verify ${name}`, {
      cause,
    });
  } finally {
    await handle?.close();
  }
}

function requiredEnvironmentPath(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    unavailable(`${name} is required; runtime discovery never downloads or guesses an asset`);
  }
  return value;
}

export type LinuxLibcRuntimeEvidence = Readonly<{
  arch: string;
  versions: Readonly<Record<string, string | undefined>>;
  report?: Readonly<{
    header?: Readonly<{
      glibcVersionRuntime?: unknown;
      release?: Readonly<{ sourceUrl?: unknown }>;
    }>;
    sharedObjects?: unknown;
  }>;
}>;

/** Resolves only mutually consistent evidence about the running Linux binary. */
export function resolveLinuxLibcFromRuntimeEvidence(
  evidence: LinuxLibcRuntimeEvidence,
): "gnu" | "musl" {
  const candidates = new Set<"gnu" | "musl">();
  if (nonempty(evidence.versions.musl)) candidates.add("musl");
  if (nonempty(evidence.report?.header?.glibcVersionRuntime)) candidates.add("gnu");
  if (
    Array.isArray(evidence.report?.sharedObjects) &&
    evidence.report.sharedObjects.some(
      (entry) =>
        typeof entry === "string" &&
        /(?:^|[\\/])ld-musl-(?:aarch64|x86_64)\.so(?:\.\d+)?$/u.test(entry),
    )
  ) {
    candidates.add("musl");
  }
  const bunArchiveLibc = libcFromOfficialBunRelease(
    evidence.report?.header?.release?.sourceUrl,
    evidence.versions.bun,
    evidence.arch,
  );
  if (bunArchiveLibc) candidates.add(bunArchiveLibc);
  if (candidates.size === 1) return [...candidates][0]!;
  throw new ArtifactRuntimeError(
    "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
    "Could not prove whether this Linux host uses glibc or musl",
  );
}

function detectLinuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport() as LinuxLibcRuntimeEvidence["report"];
  return resolveLinuxLibcFromRuntimeEvidence({
    arch: process.arch,
    versions: process.versions as Record<string, string | undefined>,
    ...(report ? { report } : {}),
  });
}

function libcFromOfficialBunRelease(
  sourceUrl: unknown,
  bunVersion: string | undefined,
  arch: string,
): "gnu" | "musl" | undefined {
  if (!nonempty(sourceUrl) || !nonempty(bunVersion)) return undefined;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const match = /^\/oven-sh\/bun\/releases\/download\/bun-v([^/]+)\/bun-linux-([^/]+)\.zip$/u.exec(
    url.pathname,
  );
  if (!match || match[1] !== bunVersion) return undefined;
  const archiveTarget = match[2]!;
  const validTarget =
    arch === "arm64"
      ? /^aarch64(?:-musl)?(?:-profile)?$/u.test(archiveTarget)
      : arch === "x64"
        ? /^x64(?:-musl)?(?:-baseline)?(?:-profile)?$/u.test(archiveTarget)
        : false;
  if (!validTarget) return undefined;
  return archiveTarget.split("-").includes("musl") ? "musl" : "gnu";
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function probeVerifiedArtifactSkillFacade(
  module: Record<string, unknown>,
  location: Pick<VerifiedArtifactRuntimeLocation, "target" | "kernel">,
): void {
  const getRuntime = module.getConfiguredArtifactRuntime;
  if (typeof getRuntime !== "function") {
    incompatible("skill facade bootstrap does not expose getConfiguredArtifactRuntime()");
  }
  const runtime = getRuntime();
  if (typeof runtime !== "object" || runtime === null) {
    incompatible("skill facade bootstrap did not configure its exact native runtime");
  }
  const record = runtime as Record<string, unknown>;
  if (
    record.kind !== "native" ||
    record.target !== location.target ||
    record.buildIdentity !== location.kernel.buildIdentity ||
    typeof record.capabilities !== "object" ||
    record.capabilities === null
  ) {
    incompatible("skill facade bootstrap configured an incompatible runtime");
  }
  const workbookFactory = module.Workbook as { create?: () => unknown } | undefined;
  const diagnostics = module.getArtifactCompositeDiagnostics;
  const dispose = module.disposeArtifact;
  if (
    typeof workbookFactory?.create !== "function" ||
    typeof diagnostics !== "function" ||
    typeof dispose !== "function"
  ) {
    incompatible("skill facade bootstrap is missing its native workbook health surface");
  }
  const workbook = workbookFactory.create();
  try {
    const proof = diagnostics(workbook) as Record<string, unknown>;
    if (
      proof.runtimeTarget !== location.target ||
      proof.runtimeBuildIdentity !== location.kernel.buildIdentity ||
      typeof proof.nativeStateHash !== "string"
    ) {
      incompatible("skill facade workbook health proof does not match the pinned runtime");
    }
  } finally {
    dispose(workbook);
  }
}

function defaultImporter(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function integrity(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INTEGRITY", message);
}

function unavailable(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_UNAVAILABLE", message);
}

function incompatible(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INCOMPATIBLE", message);
}
