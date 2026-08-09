#!/usr/bin/env node

import { createHash } from "node:crypto";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeEditableArtifactCausalFrontier,
  encodeEditableArtifactCausalFrontier,
} from "@opengeni/contracts/editable-artifact-causal-frontier";
import { EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES } from "@opengeni/contracts/editable-artifacts";
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
const MAX_PUBLICATION_SOURCE_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MIME_TYPE = "application/vnd.opengeni.editable-artifact-snapshot" as const;

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

export type PreparedArtifactPublication = Readonly<{
  schemaVersion: 1;
  modality: "spreadsheet" | "document" | "presentation";
  source: Readonly<{
    byteSize: number;
    contentHash: `sha256:${string}`;
    mimeType:
      | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }>;
  snapshot:
    | Readonly<{
        modality: "spreadsheet";
        byteSize: number;
        contentHash: `sha256:${string}`;
        mimeType: typeof SNAPSHOT_MIME_TYPE;
        coveredHeadSequence: 0;
        stateHash: `sha256:${string}`;
        modelSchemaVersion: 1;
        kernelVersion: string;
        coveredCausalFrontier: readonly Readonly<{
          replicaId: string;
          counter: number;
        }>[];
        operationProtocolVersion: 1;
        crdtStateVersion: 1;
      }>
    | Readonly<{
        modality: "document" | "presentation";
        byteSize: number;
        contentHash: `sha256:${string}`;
        mimeType: typeof SNAPSHOT_MIME_TYPE;
        coveredHeadSequence: 0;
        stateHash: `sha256:${string}`;
        modelSchemaVersion: 1;
        kernelVersion: string;
        nativeRevision: number;
      }>;
}>;

type ArtifactPublicationModality = PreparedArtifactPublication["modality"];

type PublicationRuntimeLocation = Readonly<{
  target: ArtifactRuntimeTarget;
  skillFacadeEntrypoint: string;
  kernel: Readonly<{ buildIdentity: string }>;
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
  if (args[0] === "prepare-publication") {
    const location = await doctorVerifiedArtifactRuntime({ environment });
    return await runVerifiedArtifactPublicationCli(args, location);
  }
  const [command, format, ...rest] = args;
  if ((command !== "locate" && command !== "doctor") || format !== "--json" || rest.length > 0) {
    throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_MANIFEST_INVALID", artifactRuntimeCliUsage());
  }
  const location =
    command === "doctor"
      ? await doctorVerifiedArtifactRuntime({ environment })
      : await locateVerifiedArtifactRuntime({ environment });
  return `${JSON.stringify(location)}\n`;
}

/**
 * Imports one validated Office file through the manifest-pinned skill facade
 * and writes an exclusive native-canonical snapshot for the trusted host.
 */
export async function runVerifiedArtifactPublicationCli(
  args: readonly string[],
  location: PublicationRuntimeLocation,
): Promise<string> {
  const parsed = parsePublicationArguments(args);
  const expected = publicationFormat(parsed.modality);
  const inputPath = await canonicalFile(parsed.inputPath, "publication source");
  if (extname(inputPath).toLowerCase() !== expected.extension) {
    invalidPublication(`publication source must have the ${expected.extension} extension`);
  }
  const outputPath = await canonicalNewFilePath(parsed.snapshotOutputPath);
  if (inputPath === outputPath) {
    invalidPublication("publication snapshot output must differ from its source");
  }
  const sourceBytes = await readBoundedFile(
    inputPath,
    MAX_PUBLICATION_SOURCE_BYTES,
    "publication source",
  );
  const sourceContentHash = sha256(sourceBytes);

  let imported: unknown;
  try {
    imported = await defaultImporter(pathToFileURL(location.skillFacadeEntrypoint).href);
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "Verified skill facade bootstrap could not be evaluated for publication",
      { cause },
    );
  }
  const module = strictModule(imported, "publication skill facade");
  const fileBlob = module.FileBlob as
    | { fromBytes?: (bytes: Uint8Array, options: { name: string; type: string }) => Blob }
    | undefined;
  const snapshotArtifact = module.createArtifactPublicationSnapshot;
  const disposeArtifact = module.disposeArtifact;
  const importer = publicationImporter(module, parsed.modality);
  if (
    typeof fileBlob?.fromBytes !== "function" ||
    typeof snapshotArtifact !== "function" ||
    typeof disposeArtifact !== "function"
  ) {
    incompatible("skill facade bootstrap is missing its publication surface");
  }

  const blob = fileBlob.fromBytes(sourceBytes, {
    name: basename(inputPath),
    type: expected.mimeType,
  });
  let artifact: unknown;
  try {
    artifact = await importer(blob);
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
      `The ${expected.extension} source could not be imported by the verified artifact runtime`,
      { cause },
    );
  }

  let prepared: Readonly<{
    result: PreparedArtifactPublication;
    snapshotBytes: Uint8Array;
  }>;
  try {
    prepared = validatePublicationSnapshot({
      candidate: snapshotArtifact(artifact),
      modality: parsed.modality,
      location,
      sourceByteSize: sourceBytes.byteLength,
      sourceContentHash,
      sourceMimeType: expected.mimeType,
    });
    await writeExclusivePublicationSnapshot(outputPath, prepared.snapshotBytes);
  } finally {
    disposeArtifact(artifact);
  }
  return `${JSON.stringify(prepared.result)}\n`;
}

function parsePublicationArguments(args: readonly string[]): Readonly<{
  modality: ArtifactPublicationModality;
  inputPath: string;
  snapshotOutputPath: string;
}> {
  const [command, format, modalityFlag, modality, inputFlag, inputPath, outputFlag, outputPath] =
    args;
  if (
    args.length !== 8 ||
    command !== "prepare-publication" ||
    format !== "--json" ||
    modalityFlag !== "--modality" ||
    (modality !== "spreadsheet" && modality !== "document" && modality !== "presentation") ||
    inputFlag !== "--input" ||
    typeof inputPath !== "string" ||
    inputPath.length === 0 ||
    outputFlag !== "--snapshot-output" ||
    typeof outputPath !== "string" ||
    outputPath.length === 0
  ) {
    invalidPublication(artifactRuntimeCliUsage());
  }
  return Object.freeze({ modality, inputPath, snapshotOutputPath: outputPath });
}

function publicationFormat(modality: ArtifactPublicationModality): Readonly<{
  extension: ".xlsx" | ".docx" | ".pptx";
  mimeType:
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}> {
  if (modality === "spreadsheet") {
    return Object.freeze({
      extension: ".xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
  if (modality === "document") {
    return Object.freeze({
      extension: ".docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  }
  return Object.freeze({
    extension: ".pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

function publicationImporter(
  module: Record<string, unknown>,
  modality: ArtifactPublicationModality,
): (input: Blob) => unknown | Promise<unknown> {
  const facadeName =
    modality === "spreadsheet"
      ? "SpreadsheetFile"
      : modality === "document"
        ? "DocumentFile"
        : "PresentationFile";
  const methodName =
    modality === "spreadsheet"
      ? "importXlsx"
      : modality === "document"
        ? "importDocx"
        : "importPptx";
  const facade = module[facadeName];
  if (typeof facade !== "function" && (typeof facade !== "object" || facade === null)) {
    incompatible(`skill facade bootstrap is missing ${facadeName}`);
  }
  const method = (facade as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    incompatible(`skill facade bootstrap is missing ${facadeName}.${methodName}()`);
  }
  return (input) => Reflect.apply(method, facade, [input]);
}

function validatePublicationSnapshot(
  input: Readonly<{
    candidate: unknown;
    modality: ArtifactPublicationModality;
    location: PublicationRuntimeLocation;
    sourceByteSize: number;
    sourceContentHash: `sha256:${string}`;
    sourceMimeType: PreparedArtifactPublication["source"]["mimeType"];
  }>,
): Readonly<{ result: PreparedArtifactPublication; snapshotBytes: Uint8Array }> {
  const candidate = exactDataRecord(
    input.candidate,
    input.modality === "spreadsheet"
      ? [
          "schemaVersion",
          "modality",
          "runtimeTarget",
          "kernelVersion",
          "modelSchemaVersion",
          "snapshotVersion",
          "stateHash",
          "snapshotBytes",
          "coveredCausalFrontier",
          "operationProtocolVersion",
          "crdtStateVersion",
        ]
      : [
          "schemaVersion",
          "modality",
          "runtimeTarget",
          "kernelVersion",
          "modelSchemaVersion",
          "snapshotVersion",
          "stateHash",
          "snapshotBytes",
          "nativeRevision",
        ],
    "publication snapshot",
  );
  if (
    candidate.schemaVersion !== 1 ||
    candidate.modality !== input.modality ||
    candidate.runtimeTarget !== input.location.target ||
    candidate.kernelVersion !== input.location.kernel.buildIdentity ||
    candidate.modelSchemaVersion !== 1 ||
    candidate.snapshotVersion !== 1 ||
    typeof candidate.stateHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.stateHash) ||
    !(candidate.snapshotBytes instanceof Uint8Array) ||
    candidate.snapshotBytes.byteLength <= 0 ||
    candidate.snapshotBytes.byteLength > EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES
  ) {
    incompatible("publication snapshot differs from the verified native runtime boundary");
  }
  const snapshotBytes = Uint8Array.from(candidate.snapshotBytes);
  const common = {
    byteSize: snapshotBytes.byteLength,
    contentHash: sha256(snapshotBytes),
    mimeType: SNAPSHOT_MIME_TYPE,
    coveredHeadSequence: 0 as const,
    stateHash: candidate.stateHash as `sha256:${string}`,
    modelSchemaVersion: 1 as const,
    kernelVersion: candidate.kernelVersion as string,
  };
  const source = Object.freeze({
    byteSize: input.sourceByteSize,
    contentHash: input.sourceContentHash,
    mimeType: input.sourceMimeType,
  });
  let snapshot: PreparedArtifactPublication["snapshot"];
  if (input.modality === "spreadsheet") {
    if (
      candidate.operationProtocolVersion !== 1 ||
      candidate.crdtStateVersion !== 1 ||
      !Array.isArray(candidate.coveredCausalFrontier)
    ) {
      incompatible("spreadsheet publication coverage is invalid");
    }
    let coveredCausalFrontier;
    try {
      coveredCausalFrontier = decodeEditableArtifactCausalFrontier(
        encodeEditableArtifactCausalFrontier(candidate.coveredCausalFrontier as never),
      );
    } catch {
      incompatible("spreadsheet publication frontier is invalid");
    }
    snapshot = Object.freeze({
      ...common,
      modality: "spreadsheet" as const,
      coveredCausalFrontier,
      operationProtocolVersion: 1 as const,
      crdtStateVersion: 1 as const,
    });
  } else {
    if (
      !Number.isSafeInteger(candidate.nativeRevision) ||
      (candidate.nativeRevision as number) < 0
    ) {
      incompatible("serialized publication revision is invalid");
    }
    snapshot = Object.freeze({
      ...common,
      modality: input.modality,
      nativeRevision: candidate.nativeRevision as number,
    });
  }
  return Object.freeze({
    result: Object.freeze({
      schemaVersion: 1 as const,
      modality: input.modality,
      source,
      snapshot,
    }),
    snapshotBytes,
  });
}

async function canonicalNewFilePath(input: string): Promise<string> {
  if (!isAbsolute(input)) invalidPublication("publication snapshot output path must be absolute");
  let parent: string;
  try {
    parent = await realpath(dirname(input));
    const metadata = await stat(parent);
    if (!metadata.isDirectory())
      unavailable("publication snapshot output directory is unavailable");
  } catch (cause) {
    if (cause instanceof ArtifactRuntimeError) throw cause;
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "publication snapshot output directory is unavailable",
      { cause },
    );
  }
  return join(parent, basename(input));
}

async function writeExclusivePublicationSnapshot(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  let created = false;
  let succeeded = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== bytes.byteLength) {
      integrity("publication snapshot write did not preserve its exact byte count");
    }
    await handle.close();
    handle = undefined;
    succeeded = true;
  } catch (cause) {
    if (cause instanceof ArtifactRuntimeError) throw cause;
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      "publication snapshot could not be written exclusively",
      { cause },
    );
  } finally {
    await handle?.close();
    if (created && !succeeded) await rm(path, { force: true });
  }
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    incompatible(`${name} is not a plain data record`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    incompatible(`${name} contains missing or unknown properties`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) incompatible(`${name}.${key} must be data`);
  }
  return value as Record<string, unknown>;
}

function strictModule(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    incompatible(`${name} did not export a module namespace`);
  }
  return value as Record<string, unknown>;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactRuntimeCliUsage(): string {
  return "Usage: opengeni-artifact-runtime <locate|doctor> --json | opengeni-artifact-runtime prepare-publication --json --modality <spreadsheet|document|presentation> --input <absolute-office-file> --snapshot-output <absolute-new-file>";
}

function invalidPublication(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_MANIFEST_INVALID", message);
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
  const publicationSnapshot = module.createArtifactPublicationSnapshot;
  const dispose = module.disposeArtifact;
  if (
    typeof workbookFactory?.create !== "function" ||
    typeof diagnostics !== "function" ||
    typeof publicationSnapshot !== "function" ||
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
