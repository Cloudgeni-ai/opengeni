import { once } from "node:events";
import { isAbsolute } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";

import {
  EditableArtifactMaterializerPermanentError,
  mimeTypeForFormat,
  type ClaimedEditableArtifactMaterialization,
  type NativeEditableArtifactMaterializationResult,
  type NativeEditableArtifactMaterializerIdentity,
  type NativeEditableArtifactMaterializerPort,
} from "./editable-artifact-materializer";

const INPUT_MAGIC = new TextEncoder().encode("OGAMI001");
const VERIFY_INPUT_MAGIC = new TextEncoder().encode("OGAVI001");
const OUTPUT_MAGIC = new TextEncoder().encode("OGAMO001");
const VERIFY_OUTPUT_MAGIC = new TextEncoder().encode("OGAVO001");
const ERROR_MAGIC = new TextEncoder().encode("OGAME001");
const IDENTITY_ARGUMENT = "--opengeni-materializer-identity-v1";
const MATERIALIZE_ARGUMENT = "--opengeni-materialize-v1";
const VERIFY_ARGUMENT = "--opengeni-verify-materialization-v1";
const MAX_IDENTITY_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

export type NativeEditableArtifactSubprocessOptions = Readonly<{
  /** Absolute path to the exact codec executable. Isolation belongs to launcher. */
  executable: string;
  launcher: VerifiedEditableArtifactProcessLauncher;
  childEnvironment?: Readonly<Record<string, string>>;
  /** Explicitly permits the current-host local-dev launcher; never set in production. */
  allowUnsandboxedDevelopment?: boolean;
  wallTimeoutMs: number;
  maxSourceBytes: number;
  maxOutputBytes: number;
  probeTimeoutMs?: number;
}>;

export type VerifiedEditableArtifactProcessLauncher = Readonly<{
  identity: Readonly<{
    platform: string;
    isolation: "subprocess";
    network: "denied" | "host";
    officeAutomation: false;
    sandboxEnforced: boolean;
    memoryLimitBytes: number;
    cpuTimeLimitMs: number;
    fileDescriptorLimit: number;
    processLimit: number;
    fileSizeLimitBytes: number;
  }>;
  spawn(input: {
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }): ChildProcessWithoutNullStreams;
}>;

type IdentityEnvelope = Readonly<{
  protocol: "OGAMC001";
  runtimeKind: "native";
  runtimeTarget: string;
  kernelVersion: string;
  codecVersions: Readonly<Record<string, string>>;
  fontRegistryHash: string;
  policyHash: string;
  maxOutputBytes: number;
  supportedModelSchemaVersions: readonly number[];
  supportedOperationProtocolVersions: readonly number[];
  supportedSnapshotProtocolVersions: readonly number[];
}>;

export type NativeEditableArtifactSubprocessPort = NativeEditableArtifactMaterializerPort &
  Readonly<{
    verifyMaterialization(input: {
      format: string;
      codecId: string;
      codecVersion: string;
      expectedSemanticHash: string;
      byteSize: number;
      chunks: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
    }): Promise<void>;
  }>;

/**
 * Probe exact codec/kernel capabilities and combine them with independently
 * verified parent-launcher isolation. The child is never trusted to attest its
 * own network namespace, resource limits, or platform sandbox.
 */
export async function createNativeEditableArtifactSubprocessPort(
  options: NativeEditableArtifactSubprocessOptions,
): Promise<NativeEditableArtifactSubprocessPort> {
  validateOptions(options);
  const childIdentity = await probeIdentity(options);
  validateIdentity(childIdentity);
  const identity = compositeIdentity(childIdentity, options);
  return Object.freeze({
    identity,
    materialize: async (
      input: Parameters<NativeEditableArtifactMaterializerPort["materialize"]>[0],
    ) => await executeMaterialization(options, childIdentity, input),
    verifyMaterialization: async (
      input: Parameters<NativeEditableArtifactSubprocessPort["verifyMaterialization"]>[0],
    ) => await executeVerification(options, childIdentity, input),
  });
}

async function executeMaterialization(
  options: NativeEditableArtifactSubprocessOptions,
  identity: IdentityEnvelope,
  input: Parameters<NativeEditableArtifactMaterializerPort["materialize"]>[0],
): Promise<NativeEditableArtifactMaterializationResult> {
  throwIfAborted(input.signal);
  if (input.job.sourceByteSize > options.maxSourceBytes) {
    throw new EditableArtifactMaterializerPermanentError("source_size_limit");
  }
  const manifest = encodeManifest(input.job, input.normalizedOptions);
  const child = spawnNative(options, [MATERIALIZE_ARGUMENT]);
  const terminate = () => terminateChild(child);
  const timeout = setTimeout(terminate, options.wallTimeoutMs);
  timeout.unref?.();
  const abort = () => terminate();
  input.signal.addEventListener("abort", abort, { once: true });

  const stderrDone = drainStderr(child, terminate);
  const exit = waitForExit(child);
  const cancellation = createAbortWait(input.signal);
  const inputDone = pumpInput(
    child,
    manifest,
    input.job.sourceByteSize,
    input.snapshot,
    input.signal,
    exit,
    cancellation.promise,
  );
  void inputDone.catch(terminate);
  const reader = new BoundedProcessReader(child, terminate, cancellation.promise);

  try {
    const magic = await reader.readExactly(OUTPUT_MAGIC.byteLength, input.signal);
    if (equalBytes(magic, ERROR_MAGIC)) {
      throw await readTypedError(reader, input.signal);
    }
    if (!equalBytes(magic, OUTPUT_MAGIC)) {
      throw new Error("native materializer returned an invalid output protocol");
    }
    const header = await reader.readExactly(12, input.signal);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const metadataBytes = headerView.getUint32(0, true);
    const outputBytes = safeU64(headerView, 4, "native materializer output length");
    if (metadataBytes < 2 || metadataBytes > MAX_METADATA_BYTES) {
      throw new Error("native materializer metadata exceeds its bound");
    }
    if (
      outputBytes <= 0 ||
      outputBytes > options.maxOutputBytes ||
      outputBytes > identity.maxOutputBytes
    ) {
      throw new EditableArtifactMaterializerPermanentError("output_size_limit");
    }
    const metadataText = new TextDecoder("utf-8", { fatal: true }).decode(
      await reader.readExactly(metadataBytes, input.signal),
    );
    const result = decodeOutputMetadata(metadataText, input.job, outputBytes);
    let consumed = false;
    return Object.freeze({
      ...result,
      chunks: Object.freeze({
        async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
          if (consumed) throw new Error("native materializer output is single-use");
          consumed = true;
          try {
            yield* reader.streamExactly(outputBytes, input.signal);
            await reader.assertEof(input.signal);
            await inputDone;
            await stderrDone;
            const status = await exit;
            if (status.code !== 0 || status.signal !== null) {
              throw new Error("native materializer exited unsuccessfully");
            }
          } finally {
            cleanup();
          }
        },
      }),
    });
  } catch (error) {
    terminate();
    await Promise.allSettled([inputDone, stderrDone, exit]);
    cleanup();
    throw mapSubprocessFailure(error, input.signal);
  }

  function cleanup(): void {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abort);
    cancellation.dispose();
    if (child.exitCode === null && child.signalCode === null) terminate();
  }
}

async function executeVerification(
  options: NativeEditableArtifactSubprocessOptions,
  identity: IdentityEnvelope,
  input: Parameters<NativeEditableArtifactSubprocessPort["verifyMaterialization"]>[0],
): Promise<void> {
  throwIfAborted(input.signal);
  if (
    !isHash(input.expectedSemanticHash) ||
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize <= 0 ||
    input.byteSize > options.maxOutputBytes ||
    identity.codecVersions[input.codecId] !== input.codecVersion
  ) {
    throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      codecId: input.codecId,
      codecVersion: input.codecVersion,
      expectedSemanticHash: input.expectedSemanticHash,
      format: input.format,
      protocol: "OGAVJ001",
    }),
  );
  const child = spawnNative(options, [VERIFY_ARGUMENT]);
  const terminate = () => terminateChild(child);
  const timeout = setTimeout(terminate, options.wallTimeoutMs);
  timeout.unref?.();
  const abort = () => terminate();
  input.signal.addEventListener("abort", abort, { once: true });
  const stderrDone = drainStderr(child, terminate);
  const exit = waitForExit(child);
  const cancellation = createAbortWait(input.signal);
  const inputDone = pumpFrame(
    child,
    VERIFY_INPUT_MAGIC,
    manifest,
    input.byteSize,
    input.chunks,
    input.signal,
    exit,
    cancellation.promise,
    "output_verification_failed",
  );
  void inputDone.catch(terminate);
  const reader = new BoundedProcessReader(child, terminate, cancellation.promise);
  try {
    const magic = await reader.readExactly(VERIFY_OUTPUT_MAGIC.byteLength, input.signal);
    if (equalBytes(magic, ERROR_MAGIC)) throw await readTypedError(reader, input.signal);
    if (!equalBytes(magic, VERIFY_OUTPUT_MAGIC)) {
      throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
    }
    const header = await reader.readExactly(12, input.signal);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const metadataBytes = view.getUint32(0, true);
    const payloadBytes = safeU64(view, 4, "verification payload length");
    if (metadataBytes < 2 || metadataBytes > MAX_METADATA_BYTES || payloadBytes !== 0) {
      throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await reader.readExactly(metadataBytes, input.signal),
    );
    const value = JSON.parse(text) as unknown;
    if (
      JSON.stringify(value) !== text ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "protocol\0semanticHash" ||
      (value as Record<string, unknown>).protocol !== "OGAVR001" ||
      (value as Record<string, unknown>).semanticHash !== input.expectedSemanticHash
    ) {
      throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
    }
    await reader.assertEof(input.signal);
    await inputDone;
    await stderrDone;
    const status = await exit;
    if (status.code !== 0 || status.signal !== null) {
      throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
    }
  } catch (error) {
    terminate();
    await Promise.allSettled([inputDone, stderrDone, exit]);
    if (error instanceof EditableArtifactMaterializerPermanentError) throw error;
    throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", abort);
    cancellation.dispose();
    if (child.exitCode === null && child.signalCode === null) terminate();
  }
}

async function readTypedError(
  reader: BoundedProcessReader,
  signal: AbortSignal,
): Promise<EditableArtifactMaterializerPermanentError> {
  const header = await reader.readExactly(12, signal);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const metadataBytes = view.getUint32(0, true);
  const payloadBytes = safeU64(view, 4, "error payload length");
  if (metadataBytes < 2 || metadataBytes > MAX_METADATA_BYTES || payloadBytes !== 0) {
    return new EditableArtifactMaterializerPermanentError("kernel_result_mismatch");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await reader.readExactly(metadataBytes, signal),
  );
  const value = JSON.parse(text) as unknown;
  if (
    JSON.stringify(value) !== text ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "code\0protocol" ||
    (value as Record<string, unknown>).protocol !== "OGAMERR1"
  ) {
    return new EditableArtifactMaterializerPermanentError("kernel_result_mismatch");
  }
  const code = (value as Record<string, unknown>).code;
  if (
    code === "unsupported_semantics" ||
    code === "source_identity_mismatch" ||
    code === "kernel_incompatible" ||
    code === "output_verification_failed"
  ) {
    return new EditableArtifactMaterializerPermanentError(code);
  }
  return new EditableArtifactMaterializerPermanentError("kernel_result_mismatch");
}

async function probeIdentity(
  options: NativeEditableArtifactSubprocessOptions,
): Promise<IdentityEnvelope> {
  const child = spawnNative(options, [IDENTITY_ARGUMENT]);
  const terminate = () => terminateChild(child);
  const timeout = setTimeout(terminate, options.probeTimeoutMs ?? 5_000);
  timeout.unref?.();
  const stdout = collectBounded(child.stdout, MAX_IDENTITY_BYTES, terminate);
  const stderr = drainStderr(child, terminate);
  try {
    const [bytes, , status] = await Promise.all([stdout, stderr, waitForExit(child)]);
    if (status.code !== 0 || status.signal !== null) {
      throw new Error("native materializer identity probe failed");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (JSON.stringify(parsed) !== text) {
      throw new Error("native materializer identity is not canonical JSON");
    }
    return parsed as IdentityEnvelope;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) terminate();
  }
}

function spawnNative(
  options: NativeEditableArtifactSubprocessOptions,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  return options.launcher.spawn({
    executable: options.executable,
    args,
    environment: Object.freeze({
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      ...(options.childEnvironment ?? {}),
    }),
  });
}

async function pumpInput(
  child: ChildProcessWithoutNullStreams,
  manifest: Uint8Array,
  expectedSourceBytes: number,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  cancellation: Promise<never>,
): Promise<void> {
  await pumpFrame(
    child,
    INPUT_MAGIC,
    manifest,
    expectedSourceBytes,
    source,
    signal,
    exit,
    cancellation,
    "source_identity_mismatch",
  );
}

async function pumpFrame(
  child: ChildProcessWithoutNullStreams,
  magic: Uint8Array,
  manifest: Uint8Array,
  expectedSourceBytes: number,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  cancellation: Promise<never>,
  mismatchCode: "source_identity_mismatch" | "output_verification_failed",
): Promise<void> {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, manifest.byteLength, true);
  view.setBigUint64(4, BigInt(expectedSourceBytes), true);
  await write(child, magic, signal, exit, cancellation);
  await write(child, header, signal, exit, cancellation);
  await write(child, manifest, signal, exit, cancellation);
  let sourceBytes = 0;
  for await (const chunk of source) {
    throwIfAborted(signal);
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      chunk.byteLength > 8 * 1024 * 1024
    ) {
      throw new EditableArtifactMaterializerPermanentError(mismatchCode);
    }
    sourceBytes += chunk.byteLength;
    if (sourceBytes > expectedSourceBytes) {
      throw new EditableArtifactMaterializerPermanentError(mismatchCode);
    }
    await write(child, chunk, signal, exit, cancellation);
  }
  if (sourceBytes !== expectedSourceBytes) {
    throw new EditableArtifactMaterializerPermanentError(mismatchCode);
  }
  child.stdin.end();
}

async function write(
  child: ChildProcessWithoutNullStreams,
  bytes: Uint8Array,
  signal: AbortSignal,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  cancellation: Promise<never>,
): Promise<void> {
  throwIfAborted(signal);
  if (!child.stdin.write(bytes)) {
    await Promise.race([
      once(child.stdin, "drain"),
      cancellation,
      exit.then(() => {
        throw new Error("native materializer closed input early");
      }),
    ]);
  }
}

class BoundedProcessReader {
  readonly #iterator: AsyncIterator<Buffer | string>;
  #buffer = new Uint8Array(0);
  #done = false;

  constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly terminate: () => void,
    private readonly cancellation: Promise<never>,
  ) {
    this.#iterator = child.stdout[Symbol.asyncIterator]();
  }

  async readExactly(length: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid framed length");
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      throwIfAborted(signal);
      if (this.#buffer.byteLength === 0) await this.#fill(signal);
      if (this.#buffer.byteLength === 0) throw new Error("truncated native materializer output");
      const count = Math.min(length - offset, this.#buffer.byteLength);
      output.set(this.#buffer.subarray(0, count), offset);
      this.#buffer = this.#buffer.subarray(count);
      offset += count;
    }
    return output;
  }

  async *streamExactly(length: number, signal: AbortSignal): AsyncIterableIterator<Uint8Array> {
    let remaining = length;
    while (remaining > 0) {
      throwIfAborted(signal);
      const count = Math.min(remaining, STREAM_CHUNK_BYTES);
      const chunk = await this.readExactly(count, signal);
      remaining -= chunk.byteLength;
      yield chunk;
    }
  }

  async assertEof(signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.#buffer.byteLength > 0) throw new Error("trailing native materializer output");
    if (!this.#done) await this.#fill(signal);
    if (this.#buffer.byteLength > 0 || !this.#done) {
      throw new Error("trailing native materializer output");
    }
  }

  async #fill(signal: AbortSignal): Promise<void> {
    if (this.#done) return;
    throwIfAborted(signal);
    let next: IteratorResult<Buffer | string>;
    try {
      next = await Promise.race([this.#iterator.next(), this.cancellation]);
    } catch (error) {
      this.terminate();
      throw error;
    }
    if (next.done) {
      this.#done = true;
      return;
    }
    if (typeof next.value === "string") throw new Error("native materializer emitted text stream");
    this.#buffer = new Uint8Array(
      next.value.buffer,
      next.value.byteOffset,
      next.value.byteLength,
    ).slice();
  }
}

function encodeManifest(
  job: ClaimedEditableArtifactMaterialization,
  normalizedOptions: Uint8Array,
): Uint8Array {
  const options = new TextDecoder("utf-8", { fatal: true }).decode(normalizedOptions);
  const manifest = {
    protocol: "OGAMJ001",
    artifactId: job.artifactId,
    jobId: job.jobId,
    versionId: job.versionId,
    modality: job.modality,
    inputSnapshotId: job.inputSnapshotId,
    targetHeadSequence: job.targetHeadSequence,
    stateHash: job.stateHash,
    sourceByteSize: job.sourceByteSize,
    sourceContentHash: job.sourceContentHash,
    modelSchemaVersion: job.modelSchemaVersion,
    operationProtocolVersion: job.operationProtocolVersion,
    snapshotProtocolVersion: job.snapshotProtocolVersion,
    format: job.format,
    codecId: job.codecId,
    normalizedOptions: JSON.parse(options) as unknown,
    optionsHash: job.optionsHash,
    codecVersion: job.codecVersion,
    kernelVersion: job.kernelVersion,
    fontRegistryHash: job.fontRegistryHash,
    policyHash: job.policyHash,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_METADATA_BYTES) {
    throw new EditableArtifactMaterializerPermanentError("invalid_job_manifest");
  }
  return bytes;
}

function decodeOutputMetadata(
  text: string,
  job: ClaimedEditableArtifactMaterialization,
  outputBytes: number,
): Omit<NativeEditableArtifactMaterializationResult, "chunks"> {
  const value = JSON.parse(text) as unknown;
  if (JSON.stringify(value) !== text || typeof value !== "object" || value === null) {
    throw new Error("native materializer metadata is not canonical JSON");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "byteSize",
    "codecId",
    "codecVersion",
    "contentHash",
    "fontRegistryHash",
    "format",
    "headSequence",
    "kernelVersion",
    "mimeType",
    "policyHash",
    "protocol",
    "semanticHash",
    "stateHash",
  ].sort();
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error("native materializer metadata fields are invalid");
  }
  if (record.protocol !== "OGAMR001" || record.byteSize !== outputBytes) {
    throw new Error("native materializer output length disagrees with metadata");
  }
  const expectedMimeType = mimeTypeForFormat(job.format);
  if (
    !Number.isSafeInteger(record.headSequence) ||
    record.headSequence !== job.targetHeadSequence ||
    !isHash(record.stateHash) ||
    record.stateHash !== job.stateHash ||
    record.format !== job.format ||
    record.mimeType !== expectedMimeType ||
    !isBoundedVersion(record.codecId) ||
    record.codecId !== job.codecId ||
    !isBoundedVersion(record.codecVersion) ||
    record.codecVersion !== job.codecVersion ||
    !isBoundedKernelVersion(record.kernelVersion) ||
    record.kernelVersion !== job.kernelVersion ||
    !isHash(record.fontRegistryHash) ||
    record.fontRegistryHash !== job.fontRegistryHash ||
    !isHash(record.policyHash) ||
    record.policyHash !== job.policyHash ||
    !isHash(record.contentHash) ||
    !isHash(record.semanticHash)
  ) {
    throw new Error("native materializer output metadata is incompatible");
  }
  return Object.freeze({
    headSequence: record.headSequence,
    stateHash: record.stateHash,
    format: job.format,
    mimeType: expectedMimeType,
    codecId: record.codecId,
    codecVersion: record.codecVersion,
    kernelVersion: record.kernelVersion,
    fontRegistryHash: record.fontRegistryHash,
    policyHash: record.policyHash,
    byteSize: outputBytes,
    contentHash: record.contentHash,
    semanticHash: record.semanticHash,
  });
}

function validateOptions(options: NativeEditableArtifactSubprocessOptions): void {
  if (!isAbsolute(options.executable) || options.executable.length > 2_048) {
    throw new TypeError("native materializer executable must be an absolute path");
  }
  for (const [label, value] of [
    ["wall timeout", options.wallTimeoutMs],
    ["source limit", options.maxSourceBytes],
    ["output limit", options.maxOutputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} is invalid`);
  }
  const launcher = options.launcher.identity;
  const sandboxed =
    launcher.sandboxEnforced === true &&
    launcher.network === "denied" &&
    Number.isSafeInteger(launcher.memoryLimitBytes) &&
    launcher.memoryLimitBytes > 0 &&
    Number.isSafeInteger(launcher.cpuTimeLimitMs) &&
    launcher.cpuTimeLimitMs > 0 &&
    Number.isSafeInteger(launcher.fileDescriptorLimit) &&
    launcher.fileDescriptorLimit > 0 &&
    Number.isSafeInteger(launcher.processLimit) &&
    launcher.processLimit > 0 &&
    Number.isSafeInteger(launcher.fileSizeLimitBytes) &&
    launcher.fileSizeLimitBytes > 0;
  const developmentUnsandboxed =
    options.allowUnsandboxedDevelopment === true &&
    launcher.sandboxEnforced === false &&
    launcher.network === "host" &&
    launcher.memoryLimitBytes === 0 &&
    launcher.cpuTimeLimitMs === 0 &&
    launcher.fileDescriptorLimit === 0 &&
    launcher.processLimit === 0 &&
    launcher.fileSizeLimitBytes === 0;
  if (
    launcher.isolation !== "subprocess" ||
    launcher.officeAutomation !== false ||
    !isBoundedVersion(launcher.platform) ||
    (!sandboxed && !developmentUnsandboxed)
  ) {
    throw new TypeError("materializer launcher isolation is not verified");
  }
  if (options.childEnvironment !== undefined) {
    const keys = Object.keys(options.childEnvironment).sort();
    const productionKeys = ["OPENGENI_ARTIFACT_RUNTIME_MANIFEST", "OPENGENI_ARTIFACT_TOOL_ENTRY"];
    const developmentKeys = [
      "NODE_ENV",
      "OPENGENI_ARTIFACT_DEVELOPMENT_RUNTIME_MANIFEST",
      "OPENGENI_ARTIFACT_TOOL_ENTRY",
    ];
    const production = keys.join("\0") === productionKeys.join("\0");
    const development = keys.join("\0") === developmentKeys.join("\0");
    if (!production && !development) {
      throw new TypeError("native materializer child environment is not exact");
    }
    if (development !== developmentUnsandboxed) {
      throw new TypeError("native materializer launcher and runtime authority modes differ");
    }
    if (
      development &&
      (options.allowUnsandboxedDevelopment !== true ||
        options.childEnvironment.NODE_ENV !== "development")
    ) {
      throw new TypeError("native materializer development child environment is forbidden");
    }
    for (const [name, value] of Object.entries(options.childEnvironment)) {
      if (name === "NODE_ENV") continue;
      if (!isAbsolute(value) || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError("native materializer child environment path is invalid");
      }
    }
  }
}

function validateIdentity(identity: IdentityEnvelope): void {
  const record = identity as unknown as Record<string, unknown>;
  const expectedKeys = [
    "codecVersions",
    "fontRegistryHash",
    "kernelVersion",
    "maxOutputBytes",
    "policyHash",
    "protocol",
    "runtimeKind",
    "runtimeTarget",
    "supportedModelSchemaVersions",
    "supportedOperationProtocolVersions",
    "supportedSnapshotProtocolVersions",
  ].sort();
  if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error("native materializer identity fields are invalid");
  }
  if (
    identity.protocol !== "OGAMC001" ||
    identity.runtimeKind !== "native" ||
    !Number.isSafeInteger(identity.maxOutputBytes) ||
    identity.maxOutputBytes <= 0
  ) {
    throw new Error("native materializer sandbox identity is incompatible");
  }
  if (
    !isBoundedKernelVersion(identity.kernelVersion) ||
    !isBoundedVersion(identity.runtimeTarget) ||
    !isHash(identity.fontRegistryHash) ||
    !isHash(identity.policyHash) ||
    !isCodecRegistry(identity.codecVersions) ||
    !isCanonicalPositiveVersionList(identity.supportedModelSchemaVersions) ||
    !isCanonicalPositiveVersionList(identity.supportedOperationProtocolVersions) ||
    !isCanonicalPositiveVersionList(identity.supportedSnapshotProtocolVersions)
  ) {
    throw new Error("native materializer capability identity is incomplete");
  }
}

function compositeIdentity(
  child: IdentityEnvelope,
  options: NativeEditableArtifactSubprocessOptions,
): NativeEditableArtifactMaterializerIdentity {
  const launcher = options.launcher.identity;
  return Object.freeze({
    kind: "native",
    isolation: launcher.isolation,
    network: launcher.network,
    officeAutomation: launcher.officeAutomation,
    processProtocolVersion: 1,
    sandboxEnforced: launcher.sandboxEnforced,
    memoryLimitBytes: launcher.memoryLimitBytes,
    cpuTimeLimitMs: launcher.cpuTimeLimitMs,
    fileDescriptorLimit: launcher.fileDescriptorLimit,
    processLimit: launcher.processLimit,
    fileSizeLimitBytes: launcher.fileSizeLimitBytes,
    maxOutputBytes: Math.min(child.maxOutputBytes, options.maxOutputBytes),
    kernelVersion: child.kernelVersion,
    codecVersions: child.codecVersions,
    fontRegistryHash: child.fontRegistryHash,
    policyHash: child.policyHash,
    runtimeTarget: child.runtimeTarget,
    supportedModelSchemaVersions: child.supportedModelSchemaVersions,
    supportedOperationProtocolVersions: child.supportedOperationProtocolVersions,
    supportedSnapshotProtocolVersions: child.supportedSnapshotProtocolVersions,
  });
}

function isCodecRegistry(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 64) return false;
  let previous = "";
  for (const [codecId, version] of entries) {
    if (
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(codecId) ||
      codecId <= previous ||
      !isBoundedVersion(version)
    ) {
      return false;
    }
    previous = codecId;
  }
  return true;
}

function isCanonicalPositiveVersionList(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  let previous = 0;
  for (const version of value) {
    if (!Number.isSafeInteger(version) || version <= previous) return false;
    previous = version;
  }
  return true;
}

function isBoundedVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function isBoundedKernelVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    new TextEncoder().encode(value).byteLength <= EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

async function collectBounded(
  stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
  maximum: number,
  terminate: () => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    total += chunk.byteLength;
    if (total > maximum) {
      terminate();
      throw new Error("native materializer diagnostic exceeded its bound");
    }
    chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function drainStderr(
  child: ChildProcessWithoutNullStreams,
  terminate: () => void,
): Promise<void> {
  await collectBounded(child.stderr, MAX_STDERR_BYTES, terminate);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.removeListener("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.removeListener("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.destroy();
  child.kill("SIGKILL");
}

function createAbortWait(signal: AbortSignal): {
  promise: Promise<never>;
  dispose(): void;
} {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    listener = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", listener, { once: true });
  });
  // The promise is deliberately shared by every stream race. Attach a handler
  // once so a late abort after another branch failed cannot be unhandled.
  void promise.catch(() => undefined);
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError();
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function mapSubprocessFailure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason ?? abortError();
  return error;
}

function safeU64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe integer`);
  return Number(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
