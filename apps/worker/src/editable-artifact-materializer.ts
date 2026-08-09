import { createHash } from "node:crypto";

import { EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES } from "@opengeni/contracts/editable-artifacts";

import type {
  BoundedImmutableObjectWritePort,
  BoundedObjectRead,
  BoundedObjectReadPort,
} from "@opengeni/storage";
import { BoundedObjectReadError, BoundedObjectWriteError } from "@opengeni/storage";

/**
 * The database role allowed to poll the cross-tenant materialization queue.
 * It owns no table privileges; @opengeni/db exposes only fenced SECURITY
 * DEFINER functions to this role.
 */
export const EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE =
  "opengeni_artifact_materializer" as const;

export const EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const EDITABLE_ARTIFACT_MATERIALIZER_MAX_OPTIONS_BYTES = 256 * 1024;
export const EDITABLE_ARTIFACT_MATERIALIZER_MAX_ATTEMPTS = 20;

export type EditableArtifactMaterializationFormat =
  | "xlsx"
  | "pptx"
  | "docx"
  | "pdf"
  | "png"
  | "webp";

export type EditableArtifactMaterializationModality = "spreadsheet" | "presentation" | "document";

export type EditableArtifactMaterializationMimeType =
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/pdf"
  | "image/png"
  | "image/webp";

export type EditableArtifactMaterializationScope = Readonly<{
  accountId: string;
  workspaceId: string;
}>;

/**
 * One immutable, self-contained input manifest returned by the global claim
 * function. The source snapshot covers exactly targetHeadSequence. There is
 * deliberately no "current" lookup after claim and no unbounded DB tail read.
 */
export type ClaimedEditableArtifactMaterialization = Readonly<{
  scope: EditableArtifactMaterializationScope;
  artifactId: string;
  jobId: string;
  versionId: string | null;
  modality: EditableArtifactMaterializationModality;
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: string;
  sourceObjectReference: string;
  sourceByteSize: number;
  sourceContentHash: string;
  sourceMimeType: string;
  modelSchemaVersion: number;
  operationProtocolVersion: number;
  snapshotProtocolVersion: number;
  format: EditableArtifactMaterializationFormat;
  codecId: string;
  /** Canonical UTF-8 JSON, bounded and hashed by optionsHash. */
  normalizedOptions: string;
  optionsHash: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

export type EditableArtifactMaterializationLease = Readonly<{
  scope: EditableArtifactMaterializationScope;
  artifactId: string;
  jobId: string;
  owner: string;
  attemptCount: number;
}>;

export interface EditableArtifactMaterializationStorePort {
  claim(input: {
    owner: string;
    leaseDurationMs: number;
    limit: number;
  }): Promise<readonly ClaimedEditableArtifactMaterialization[]>;
  renew(input: EditableArtifactMaterializationLease & { leaseDurationMs: number }): Promise<string>;
  succeed(
    input: EditableArtifactMaterializationLease & {
      resultId: string;
      blobRefId: string;
      objectReference: string;
      byteSize: number;
      contentHash: string;
      mimeType: EditableArtifactMaterializationMimeType;
      verifiedAt: string;
    },
  ): Promise<unknown>;
  fail(input: EditableArtifactMaterializationLease & { errorCode: string }): Promise<unknown>;
}

export type NativeEditableArtifactMaterializerIdentity = Readonly<{
  kind: "native";
  /** Parent-owned launcher facts, never copied from the codec child. */
  isolation: "subprocess";
  network: "denied" | "host";
  officeAutomation: false;
  processProtocolVersion: 1;
  sandboxEnforced: boolean;
  memoryLimitBytes: number;
  cpuTimeLimitMs: number;
  fileDescriptorLimit: number;
  processLimit: number;
  fileSizeLimitBytes: number;
  maxOutputBytes: number;
  kernelVersion: string;
  codecVersions: Readonly<Record<string, string>>;
  fontRegistryHash: string;
  policyHash: string;
  runtimeTarget: string;
  supportedModelSchemaVersions: readonly number[];
  supportedOperationProtocolVersions: readonly number[];
  supportedSnapshotProtocolVersions: readonly number[];
}>;

export type NativeEditableArtifactMaterializationResult = Readonly<{
  headSequence: number;
  stateHash: string;
  format: EditableArtifactMaterializationFormat;
  mimeType: EditableArtifactMaterializationMimeType;
  codecId: string;
  codecVersion: string;
  kernelVersion: string;
  fontRegistryHash: string;
  policyHash: string;
  /** Optional precomputed facts; the independent writer/verifier still checks. */
  byteSize?: number;
  contentHash?: string;
  /** Canonical semantics projected by the authoritative native source kernel. */
  semanticHash: string;
  chunks: AsyncIterable<Uint8Array>;
}>;

/**
 * Production implementations must be a native Rust subprocess adapter. The
 * adapter consumes a version-pinned stream, reconstructs and validates the
 * canonical snapshot, and exports without Office/COM or network access.
 */
export interface NativeEditableArtifactMaterializerPort {
  readonly identity: NativeEditableArtifactMaterializerIdentity;
  materialize(input: {
    job: ClaimedEditableArtifactMaterialization;
    normalizedOptions: Uint8Array;
    snapshot: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }): Promise<NativeEditableArtifactMaterializationResult>;
}

export type VerifiedEditableArtifactMaterialization = Readonly<{
  objectReference: string;
  byteSize: number;
  contentHash: string;
  mimeType: EditableArtifactMaterializationMimeType;
  format: EditableArtifactMaterializationFormat;
  codecId: string;
  codecVersion: string;
}>;

/** Independent reader/parser. It must not reuse the exporting codec process. */
export interface EditableArtifactMaterializationVerifierPort {
  verify(input: {
    objectReference: string;
    expectedByteSize: number;
    expectedContentHash: string;
    expectedMimeType: EditableArtifactMaterializationMimeType;
    format: EditableArtifactMaterializationFormat;
    codecId: string;
    codecVersion: string;
    expectedSemanticHash: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<VerifiedEditableArtifactMaterialization>;
}

export interface EditableArtifactMaterializationSemanticVerifierPort {
  verify(input: {
    format: EditableArtifactMaterializationFormat;
    codecId: string;
    codecVersion: string;
    expectedSemanticHash: string;
    byteSize: number;
    chunks: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface EditableArtifactMaterializerSchedulerPort {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface EditableArtifactMaterializerClockPort {
  now(): Date;
}

export interface EditableArtifactMaterializerLoggerPort {
  warn(message: string, attributes: Readonly<Record<string, unknown>>): void;
}

export type EditableArtifactMaterializerMetricOutcome =
  | "claimed"
  | "succeeded"
  | "dead_lettered"
  | "retry_deferred"
  | "lease_lost"
  | "cancelled"
  | "claim_failed";

export interface EditableArtifactMaterializerMetricsPort {
  increment(outcome: EditableArtifactMaterializerMetricOutcome, count?: number): void;
}

export type EditableArtifactMaterializerOptions = Readonly<{
  owner: string;
  batchSize?: number;
  concurrency?: number;
  leaseDurationMs?: number;
  leaseRenewIntervalMs?: number;
  pollIntervalMs?: number;
  claimBackoffMs?: number;
  maxAttempts?: number;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
}>;

export type EditableArtifactMaterializerDependencies = Readonly<{
  store: EditableArtifactMaterializationStorePort;
  sourceReader: BoundedObjectReadPort;
  outputWriter: BoundedImmutableObjectWritePort;
  outputVerifier: EditableArtifactMaterializationVerifierPort;
  kernel: NativeEditableArtifactMaterializerPort;
  scheduler: EditableArtifactMaterializerSchedulerPort;
  clock: EditableArtifactMaterializerClockPort;
  logger?: EditableArtifactMaterializerLoggerPort;
  metrics?: EditableArtifactMaterializerMetricsPort;
}>;

export type EditableArtifactMaterializerPassSummary = Readonly<{
  claimed: number;
  succeeded: number;
  deadLettered: number;
  retryDeferred: number;
  leaseLost: number;
  cancelled: number;
  claimFailed: boolean;
}>;

type MutableSummary = {
  claimed: number;
  succeeded: number;
  deadLettered: number;
  retryDeferred: number;
  leaseLost: number;
  cancelled: number;
  claimFailed: boolean;
};

type NormalizedOptions = Required<EditableArtifactMaterializerOptions>;

const DEFAULT_OPTIONS = Object.freeze({
  batchSize: 8,
  concurrency: 2,
  leaseDurationMs: 120_000,
  leaseRenewIntervalMs: 30_000,
  pollIntervalMs: 1_000,
  claimBackoffMs: 5_000,
  maxAttempts: EDITABLE_ARTIFACT_MATERIALIZER_MAX_ATTEMPTS,
  maxSourceBytes: EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES,
  maxOutputBytes: EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES,
});

/** Closed, diagnostics-free terminal failure codes persisted in Postgres. */
export type EditableArtifactMaterializerDeadLetterCode =
  | "invalid_job_manifest"
  | "source_identity_mismatch"
  | "source_size_limit"
  | "kernel_incompatible"
  | "kernel_result_mismatch"
  | "unsupported_semantics"
  | "output_size_limit"
  | "output_verification_failed"
  | "retry_exhausted";

export type EditableArtifactMaterializerFailureDiagnostic = Readonly<{
  stage: "source_reader" | "native";
  subcode:
    | "open"
    | "content_type"
    | "stream_identity"
    | "revalidate"
    | "input_framing"
    | "snapshot_open"
    | "state_mismatch"
    | "revision_mismatch";
}>;

export class EditableArtifactMaterializerPermanentError extends Error {
  constructor(
    readonly code: EditableArtifactMaterializerDeadLetterCode,
    readonly diagnostic?: EditableArtifactMaterializerFailureDiagnostic,
  ) {
    super(`Editable artifact materialization cannot continue: ${code}`);
    this.name = "EditableArtifactMaterializerPermanentError";
  }
}

export class EditableArtifactMaterializerLeaseLostError extends Error {
  constructor() {
    super("Editable artifact materialization lease was lost");
    this.name = "EditableArtifactMaterializerLeaseLostError";
  }
}

/**
 * At-least-once materialization loop. Immutable content-addressed output makes
 * recomputation safe; owner + attemptCount fences make DB settlement exact.
 */
export class EditableArtifactMaterializer {
  readonly #options: NormalizedOptions;
  #activePass: Promise<EditableArtifactMaterializerPassSummary> | null = null;

  constructor(
    private readonly dependencies: EditableArtifactMaterializerDependencies,
    options: EditableArtifactMaterializerOptions,
    securityPolicy: Readonly<{ allowUnsandboxedDevelopment?: boolean }> = {},
  ) {
    this.#options = normalizeOptions(options);
    assertNativeKernelIdentity(
      dependencies.kernel.identity,
      securityPolicy.allowUnsandboxedDevelopment === true,
    );
  }

  async run(signal: AbortSignal): Promise<void> {
    let claimFailed = false;
    while (!signal.aborted) {
      const summary = await this.dispatchOnce(signal);
      claimFailed = summary.claimFailed;
      if (signal.aborted) break;
      const delay = claimFailed
        ? this.#options.claimBackoffMs
        : summary.claimed === 0
          ? this.#options.pollIntervalMs
          : 0;
      if (delay > 0 && !(await sleepOrAbort(this.dependencies.scheduler, delay, signal))) break;
    }
    await this.drain();
  }

  /** Concurrent triggers share one bounded claim pass. */
  dispatchOnce(signal?: AbortSignal): Promise<EditableArtifactMaterializerPassSummary> {
    if (this.#activePass) return this.#activePass;
    const pass = this.#dispatchBatch(signal);
    this.#activePass = pass;
    void pass.then(
      () => {
        if (this.#activePass === pass) this.#activePass = null;
      },
      () => {
        if (this.#activePass === pass) this.#activePass = null;
      },
    );
    return pass;
  }

  async drain(): Promise<void> {
    await this.#activePass;
  }

  async #dispatchBatch(
    parentSignal: AbortSignal | undefined,
  ): Promise<EditableArtifactMaterializerPassSummary> {
    const summary = mutableSummary();
    if (parentSignal?.aborted) {
      return freezeSummary(summary);
    }
    let jobs: readonly ClaimedEditableArtifactMaterialization[];
    try {
      jobs = await this.dependencies.store.claim({
        owner: this.#options.owner,
        leaseDurationMs: this.#options.leaseDurationMs,
        limit: this.#options.batchSize,
      });
      if (!Array.isArray(jobs) || jobs.length > this.#options.batchSize) {
        throw new TypeError("Materialization store returned an invalid claim batch");
      }
    } catch (error) {
      summary.claimFailed = true;
      this.#metric("claim_failed");
      this.#warn("Editable artifact materialization claim failed", "claim_failed", error);
      return freezeSummary(summary);
    }
    summary.claimed = jobs.length;
    if (jobs.length > 0) this.#metric("claimed", jobs.length);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const job = jobs[index];
        if (!job) return;
        await this.#processJob(job, summary, parentSignal);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(jobs.length, this.#options.concurrency) }, worker),
    );
    return freezeSummary(summary);
  }

  async #processJob(
    job: ClaimedEditableArtifactMaterialization,
    summary: MutableSummary,
    parentSignal: AbortSignal | undefined,
  ): Promise<void> {
    let lease: EditableArtifactMaterializationLease;
    try {
      lease = validateClaimedJob(job, this.#options.owner, this.dependencies.kernel.identity);
    } catch (error) {
      await this.#deadLetterBestEffort(job, "invalid_job_manifest", summary, error);
      return;
    }

    if (job.attemptCount >= this.#options.maxAttempts) {
      await this.#settlePermanent(lease, "retry_exhausted", summary, null);
      return;
    }

    const operationAbort = new AbortController();
    const renewalAbort = new AbortController();
    const combined = combineAbortSignals(parentSignal, operationAbort.signal);
    let leaseLost = false;
    const renewal = this.#renewLease(lease, renewalAbort.signal, operationAbort, () => {
      leaseLost = true;
    });

    let source: BoundedObjectRead | null = null;
    try {
      throwIfAborted(combined.signal);
      assertJobKernelCompatibility(job, this.dependencies.kernel.identity);
      const optionsBytes = canonicalOptionsBytes(job.normalizedOptions, job.optionsHash);
      if (job.sourceByteSize > this.#options.maxSourceBytes) {
        throw new EditableArtifactMaterializerPermanentError("source_size_limit");
      }
      try {
        source = await this.dependencies.sourceReader.open({
          opaqueReference: job.sourceObjectReference,
          maxBytes: this.#options.maxSourceBytes,
          expectedByteSize: job.sourceByteSize,
          signal: combined.signal,
        });
      } catch (error) {
        throw diagnoseSourceReaderFailure(error, "open");
      }
      if (source.contentType !== undefined && source.contentType !== job.sourceMimeType) {
        throw new EditableArtifactMaterializerPermanentError("source_identity_mismatch", {
          stage: "source_reader",
          subcode: "content_type",
        });
      }
      let sourceChunks: AsyncIterable<Uint8Array>;
      try {
        sourceChunks = source.chunks({ signal: combined.signal });
      } catch (error) {
        throw diagnoseSourceReaderFailure(error, "stream_identity");
      }
      const trackedSource = trackExactStream(
        sourceChunks,
        job.sourceByteSize,
        job.sourceContentHash,
        "source_identity_mismatch",
        { stage: "source_reader", subcode: "stream_identity" },
      );
      let output: NativeEditableArtifactMaterializationResult;
      try {
        output = await this.dependencies.kernel.materialize({
          job,
          normalizedOptions: optionsBytes,
          snapshot: trackedSource.chunks,
          signal: combined.signal,
        });
        await trackedSource.done;
      } catch (error) {
        // The source wrapper can reject concurrently with the native adapter
        // that is consuming it. Observe both promises so corrupt input never
        // becomes an unhandled rejection after the adapter exits.
        void trackedSource.done.catch(() => undefined);
        throw error;
      }
      try {
        await source.assertUnchanged(combined.signal);
      } catch (error) {
        throw diagnoseSourceReaderFailure(error, "revalidate");
      }
      validateKernelResult(job, output);

      const written = await this.dependencies.outputWriter.write({
        chunks: output.chunks,
        contentType: output.mimeType,
        maxBytes: this.#options.maxOutputBytes,
        ...(output.byteSize !== undefined ? { expectedByteSize: output.byteSize } : {}),
        ...(output.contentHash !== undefined ? { expectedContentHash: output.contentHash } : {}),
        signal: combined.signal,
      });
      const verified = await this.dependencies.outputVerifier.verify({
        objectReference: written.opaqueReference,
        expectedByteSize: written.byteSize,
        expectedContentHash: written.contentHash,
        expectedMimeType: output.mimeType,
        format: job.format,
        codecId: job.codecId,
        codecVersion: job.codecVersion,
        expectedSemanticHash: output.semanticHash,
        maxBytes: this.#options.maxOutputBytes,
        signal: combined.signal,
      });
      validateIndependentVerification(job, written, verified);

      renewalAbort.abort();
      await renewal;
      if (leaseLost) throw new EditableArtifactMaterializerLeaseLostError();
      throwIfAborted(combined.signal);
      await this.dependencies.store.renew({
        ...lease,
        leaseDurationMs: this.#options.leaseDurationMs,
      });
      const ids = deterministicResultIds(job, written.contentHash);
      await this.dependencies.store.succeed({
        ...lease,
        ...ids,
        objectReference: written.opaqueReference,
        byteSize: written.byteSize,
        contentHash: written.contentHash,
        mimeType: output.mimeType,
        verifiedAt: this.dependencies.clock.now().toISOString(),
      });
      summary.succeeded += 1;
      this.#metric("succeeded");
    } catch (error) {
      renewalAbort.abort();
      await renewal;
      if (leaseLost || isLeaseFence(error)) {
        summary.leaseLost += 1;
        this.#metric("lease_lost");
        this.#warn("Editable artifact materialization lease was lost", "lease_lost", error);
      } else if (combined.signal.aborted || isAbortError(error)) {
        summary.cancelled += 1;
        this.#metric("cancelled");
      } else {
        const permanent = permanentDependencyFailure(error);
        if (permanent) {
          await this.#settlePermanent(lease, permanent, summary, error);
        } else {
          // Unknown provider/kernel failures are retryable. Do not terminally
          // settle: expiry lets another owner reclaim the exact immutable input.
          summary.retryDeferred += 1;
          this.#metric("retry_deferred");
          this.#warn(
            "Editable artifact materialization will retry after lease expiry",
            "retry_deferred",
            error,
          );
        }
      }
    } finally {
      renewalAbort.abort();
      combined.dispose();
      if (source) await source.close();
    }
  }

  async #renewLease(
    lease: EditableArtifactMaterializationLease,
    signal: AbortSignal,
    operationAbort: AbortController,
    onLeaseLost: () => void,
  ): Promise<void> {
    while (
      await sleepOrAbort(this.dependencies.scheduler, this.#options.leaseRenewIntervalMs, signal)
    ) {
      try {
        await this.dependencies.store.renew({
          ...lease,
          leaseDurationMs: this.#options.leaseDurationMs,
        });
      } catch (error) {
        onLeaseLost();
        operationAbort.abort(error);
        return;
      }
    }
  }

  async #settlePermanent(
    lease: EditableArtifactMaterializationLease,
    code: EditableArtifactMaterializerDeadLetterCode,
    summary: MutableSummary,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.dependencies.store.renew({
        ...lease,
        leaseDurationMs: this.#options.leaseDurationMs,
      });
      await this.dependencies.store.fail({ ...lease, errorCode: code });
      summary.deadLettered += 1;
      this.#metric("dead_lettered");
      if (cause) this.#warn("Editable artifact materialization was dead-lettered", code, cause);
    } catch (error) {
      summary.leaseLost += 1;
      this.#metric("lease_lost");
      this.#warn("Editable artifact dead-letter settlement was fenced", "lease_lost", error);
    }
  }

  async #deadLetterBestEffort(
    job: ClaimedEditableArtifactMaterialization,
    code: EditableArtifactMaterializerDeadLetterCode,
    summary: MutableSummary,
    cause: unknown,
  ): Promise<void> {
    try {
      const lease = rawLease(job, this.#options.owner);
      await this.#settlePermanent(lease, code, summary, cause);
    } catch (error) {
      summary.leaseLost += 1;
      this.#metric("lease_lost");
      this.#warn("Invalid materialization claim could not be settled", "lease_lost", error);
    }
  }

  #metric(outcome: EditableArtifactMaterializerMetricOutcome, count = 1): void {
    try {
      this.dependencies.metrics?.increment(outcome, count);
    } catch {
      // Observability is never part of the correctness boundary.
    }
  }

  #warn(message: string, code: string, error: unknown): void {
    try {
      this.dependencies.logger?.warn(message, {
        code,
        errorClass: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof EditableArtifactMaterializerPermanentError && error.diagnostic
          ? {
              failureStage: error.diagnostic.stage,
              failureSubcode: error.diagnostic.subcode,
            }
          : {}),
      });
    } catch {
      // Logging is never part of the correctness boundary.
    }
  }
}

export type ConfiguredEditableArtifactMaterializerInput = Readonly<{
  enabled: boolean;
  databaseRole: string | null | undefined;
  objectStorageConfigured: boolean;
  dependencies?: Partial<EditableArtifactMaterializerDependencies>;
  options?: EditableArtifactMaterializerOptions;
  /** Explicit local-development exception; production callers must omit it. */
  allowUnsandboxedDevelopment?: boolean;
}>;

/**
 * Production gate. Disabled is the default. Once enabled, every privileged
 * dependency and the dedicated database role are mandatory—there is no
 * reference-kernel, mutable-storage, or tenant-role fallback.
 */
export function createConfiguredEditableArtifactMaterializer(
  input: ConfiguredEditableArtifactMaterializerInput,
): EditableArtifactMaterializer | null {
  if (!input.enabled) return null;
  if (input.databaseRole !== EDITABLE_ARTIFACT_MATERIALIZER_DATABASE_ROLE) {
    throw new Error("Editable artifact materializer requires its dedicated database role");
  }
  if (!input.objectStorageConfigured) {
    throw new Error("Editable artifact materializer requires immutable object storage");
  }
  const dependencies = input.dependencies;
  if (
    !dependencies?.store ||
    !dependencies.sourceReader ||
    !dependencies.outputWriter ||
    !dependencies.outputVerifier ||
    !dependencies.kernel ||
    !dependencies.scheduler ||
    !dependencies.clock
  ) {
    throw new Error("Editable artifact materializer dependencies are incomplete");
  }
  assertNativeKernelIdentity(
    dependencies.kernel.identity,
    input.allowUnsandboxedDevelopment === true,
  );
  if (!input.options) throw new Error("Editable artifact materializer options are required");
  return new EditableArtifactMaterializer(
    dependencies as EditableArtifactMaterializerDependencies,
    input.options,
    input.allowUnsandboxedDevelopment === undefined
      ? {}
      : { allowUnsandboxedDevelopment: input.allowUnsandboxedDevelopment },
  );
}

export const systemEditableArtifactMaterializerScheduler: EditableArtifactMaterializerSchedulerPort =
  Object.freeze({
    sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? abortError());
          return;
        }
        const complete = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(complete, milliseconds);
        timer.unref?.();
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(signal.reason ?? abortError());
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  });

export const systemEditableArtifactMaterializerClock: EditableArtifactMaterializerClockPort =
  Object.freeze({ now: () => new Date() });

function normalizeOptions(options: EditableArtifactMaterializerOptions): NormalizedOptions {
  const normalized: NormalizedOptions = Object.freeze({
    owner: validateOwner(options.owner),
    batchSize: options.batchSize ?? DEFAULT_OPTIONS.batchSize,
    concurrency: options.concurrency ?? DEFAULT_OPTIONS.concurrency,
    leaseDurationMs: options.leaseDurationMs ?? DEFAULT_OPTIONS.leaseDurationMs,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs ?? DEFAULT_OPTIONS.leaseRenewIntervalMs,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
    claimBackoffMs: options.claimBackoffMs ?? DEFAULT_OPTIONS.claimBackoffMs,
    maxAttempts: options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts,
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_OPTIONS.maxSourceBytes,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OPTIONS.maxOutputBytes,
  });
  for (const [label, value] of Object.entries(normalized)) {
    if (label === "owner") continue;
    positiveInteger(value, label);
  }
  if (normalized.batchSize > 64) throw new TypeError("materializer batch size exceeds 64");
  if (normalized.concurrency > normalized.batchSize) {
    throw new TypeError("materializer concurrency exceeds its batch size");
  }
  if (normalized.leaseDurationMs < 10_000 || normalized.leaseDurationMs > 86_400_000) {
    throw new TypeError("materializer lease duration must be 10 seconds to 24 hours");
  }
  if (normalized.leaseRenewIntervalMs * 2 >= normalized.leaseDurationMs) {
    throw new TypeError("materializer renewal interval must be less than half its lease");
  }
  if (normalized.maxAttempts > 1_000) throw new TypeError("materializer attempts exceed 1000");
  if (normalized.maxSourceBytes > EDITABLE_ARTIFACT_MATERIALIZER_MAX_SOURCE_BYTES) {
    throw new TypeError("materializer source limit exceeds the protocol maximum");
  }
  if (normalized.maxOutputBytes > EDITABLE_ARTIFACT_MATERIALIZER_MAX_OUTPUT_BYTES) {
    throw new TypeError("materializer output limit exceeds the protocol maximum");
  }
  return normalized;
}

function validateClaimedJob(
  job: ClaimedEditableArtifactMaterialization,
  owner: string,
  kernel: NativeEditableArtifactMaterializerIdentity,
): EditableArtifactMaterializationLease {
  const lease = rawLease(job, owner);
  if (job.leaseOwner !== owner) throw new TypeError("claimed job belongs to another owner");
  positiveInteger(job.targetHeadSequence + 1, "target head sequence + 1");
  positiveInteger(job.sourceByteSize, "source byte size");
  positiveInteger(job.modelSchemaVersion, "model schema version");
  positiveInteger(job.operationProtocolVersion, "operation protocol version");
  positiveInteger(job.snapshotProtocolVersion, "snapshot protocol version");
  positiveInteger(job.attemptCount, "attempt count");
  stableId(job.artifactId, "artifact id");
  stableId(job.jobId, "job id");
  stableId(job.inputSnapshotId, "input snapshot id");
  if (job.versionId !== null) stableId(job.versionId, "version id");
  canonicalHash(job.stateHash, "state hash");
  canonicalHash(job.sourceContentHash, "source content hash");
  canonicalHash(job.optionsHash, "options hash");
  canonicalHash(job.fontRegistryHash, "font registry hash");
  canonicalHash(job.policyHash, "policy hash");
  boundedText(job.sourceObjectReference, "source object reference", 2_048);
  boundedText(job.sourceMimeType, "source mime type", 256);
  boundedText(job.codecId, "codec id", 128);
  boundedText(job.codecVersion, "codec version", 128);
  boundedText(job.kernelVersion, "kernel version", EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES);
  validateFormatForModality(job.modality, job.format);
  assertJobKernelCompatibility(job, kernel);
  return lease;
}

function rawLease(
  job: ClaimedEditableArtifactMaterialization,
  owner: string,
): EditableArtifactMaterializationLease {
  boundedText(job.scope?.accountId, "account id", 128);
  boundedText(job.scope?.workspaceId, "workspace id", 128);
  stableId(job.artifactId, "artifact id");
  stableId(job.jobId, "job id");
  positiveInteger(job.attemptCount, "attempt count");
  validateOwner(owner);
  return Object.freeze({
    scope: Object.freeze({ ...job.scope }),
    artifactId: job.artifactId,
    jobId: job.jobId,
    owner,
    attemptCount: job.attemptCount,
  });
}

function assertNativeKernelIdentity(
  identity: NativeEditableArtifactMaterializerIdentity,
  allowUnsandboxedDevelopment = false,
): void {
  if (
    identity.kind !== "native" ||
    identity.isolation !== "subprocess" ||
    identity.officeAutomation !== false
  ) {
    throw new Error("Editable artifact materializer requires an isolated native kernel");
  }
  if (identity.processProtocolVersion !== 1) {
    throw new Error("Editable artifact materializer subprocess protocol is not enforced");
  }
  if (identity.sandboxEnforced) {
    if (identity.network !== "denied") {
      throw new Error("Editable artifact materializer sandbox network policy is invalid");
    }
    positiveInteger(identity.memoryLimitBytes, "kernel memory limit");
    positiveInteger(identity.cpuTimeLimitMs, "kernel CPU time limit");
    positiveInteger(identity.fileDescriptorLimit, "kernel file descriptor limit");
    positiveInteger(identity.processLimit, "kernel process limit");
    positiveInteger(identity.fileSizeLimitBytes, "kernel file size limit");
  } else if (
    !allowUnsandboxedDevelopment ||
    identity.network !== "host" ||
    identity.memoryLimitBytes !== 0 ||
    identity.cpuTimeLimitMs !== 0 ||
    identity.fileDescriptorLimit !== 0 ||
    identity.processLimit !== 0 ||
    identity.fileSizeLimitBytes !== 0
  ) {
    throw new Error("Editable artifact materializer subprocess protocol is not enforced");
  }
  positiveInteger(identity.maxOutputBytes, "kernel output limit");
  boundedText(identity.kernelVersion, "kernel version", EDITABLE_ARTIFACT_KERNEL_VERSION_MAX_BYTES);
  boundedText(identity.runtimeTarget, "kernel runtime target", 128);
  canonicalHash(identity.fontRegistryHash, "font registry hash");
  canonicalHash(identity.policyHash, "policy hash");
  if (!identity.codecVersions || typeof identity.codecVersions !== "object") {
    throw new Error("Editable artifact materializer codec registry is unavailable");
  }
  for (const [codecId, version] of Object.entries(identity.codecVersions)) {
    boundedText(codecId, "codec id", 128);
    boundedText(version, "codec version", 128);
  }
  for (const [label, values] of [
    ["model schema versions", identity.supportedModelSchemaVersions],
    ["operation protocol versions", identity.supportedOperationProtocolVersions],
    ["snapshot protocol versions", identity.supportedSnapshotProtocolVersions],
  ] as const) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
      throw new Error(`Editable artifact kernel ${label} are invalid`);
    }
    const unique = new Set<number>();
    for (const value of values) {
      positiveInteger(value, label);
      if (unique.has(value)) throw new Error(`Editable artifact kernel ${label} repeat`);
      unique.add(value);
    }
  }
}

function assertJobKernelCompatibility(
  job: ClaimedEditableArtifactMaterialization,
  identity: NativeEditableArtifactMaterializerIdentity,
): void {
  const compatible =
    identity.kernelVersion === job.kernelVersion &&
    identity.codecVersions[job.codecId] === job.codecVersion &&
    identity.fontRegistryHash === job.fontRegistryHash &&
    identity.policyHash === job.policyHash &&
    identity.supportedModelSchemaVersions.includes(job.modelSchemaVersion) &&
    identity.supportedOperationProtocolVersions.includes(job.operationProtocolVersion) &&
    identity.supportedSnapshotProtocolVersions.includes(job.snapshotProtocolVersion);
  if (!compatible) throw new EditableArtifactMaterializerPermanentError("kernel_incompatible");
}

function validateKernelResult(
  job: ClaimedEditableArtifactMaterialization,
  result: NativeEditableArtifactMaterializationResult,
): void {
  if (
    result.headSequence !== job.targetHeadSequence ||
    result.stateHash !== job.stateHash ||
    result.format !== job.format ||
    result.mimeType !== mimeTypeForFormat(job.format) ||
    result.codecId !== job.codecId ||
    result.codecVersion !== job.codecVersion ||
    result.kernelVersion !== job.kernelVersion ||
    result.fontRegistryHash !== job.fontRegistryHash ||
    result.policyHash !== job.policyHash ||
    !result.chunks ||
    typeof result.chunks[Symbol.asyncIterator] !== "function"
  ) {
    throw new EditableArtifactMaterializerPermanentError("kernel_result_mismatch");
  }
  if (result.byteSize !== undefined) positiveInteger(result.byteSize, "kernel output bytes");
  if (result.contentHash !== undefined) canonicalHash(result.contentHash, "kernel output hash");
  canonicalHash(result.semanticHash, "kernel semantic hash");
}

function validateIndependentVerification(
  job: ClaimedEditableArtifactMaterialization,
  written: {
    opaqueReference: string;
    byteSize: number;
    contentHash: string;
    contentType: string;
  },
  verified: VerifiedEditableArtifactMaterialization,
): void {
  if (
    verified.objectReference !== written.opaqueReference ||
    verified.byteSize !== written.byteSize ||
    verified.contentHash !== written.contentHash ||
    verified.mimeType !== written.contentType ||
    verified.format !== job.format ||
    verified.codecId !== job.codecId ||
    verified.codecVersion !== job.codecVersion
  ) {
    throw new EditableArtifactMaterializerPermanentError("output_verification_failed");
  }
}

function canonicalOptionsBytes(value: string, expectedHash: string): Uint8Array {
  if (typeof value !== "string") {
    throw new EditableArtifactMaterializerPermanentError("invalid_job_manifest");
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > EDITABLE_ARTIFACT_MATERIALIZER_MAX_OPTIONS_BYTES) {
    throw new EditableArtifactMaterializerPermanentError("invalid_job_manifest");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (JSON.stringify(parsed) !== value) {
      throw new Error("non-canonical options");
    }
  } catch {
    throw new EditableArtifactMaterializerPermanentError("invalid_job_manifest");
  }
  if (hashBytes(bytes) !== expectedHash) {
    throw new EditableArtifactMaterializerPermanentError("invalid_job_manifest");
  }
  return bytes;
}

function trackExactStream(
  source: AsyncIterable<Uint8Array>,
  expectedByteSize: number,
  expectedContentHash: string,
  code: EditableArtifactMaterializerDeadLetterCode,
  diagnostic?: EditableArtifactMaterializerFailureDiagnostic,
): { chunks: AsyncIterable<Uint8Array>; done: Promise<void> } {
  let settle!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  let claimed = false;
  const chunks: AsyncIterable<Uint8Array> = Object.freeze({
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
      if (claimed) {
        const error = new EditableArtifactMaterializerPermanentError(code, diagnostic);
        reject(error);
        throw error;
      }
      claimed = true;
      const digest = createHash("sha256");
      let byteSize = 0;
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new EditableArtifactMaterializerPermanentError(code, diagnostic);
          }
          byteSize += chunk.byteLength;
          if (byteSize > expectedByteSize) {
            throw new EditableArtifactMaterializerPermanentError(code, diagnostic);
          }
          digest.update(chunk);
          yield chunk.slice();
        }
        if (byteSize !== expectedByteSize) {
          throw new EditableArtifactMaterializerPermanentError(code, diagnostic);
        }
        const contentHash = `sha256:${digest.digest("hex")}`;
        if (contentHash !== expectedContentHash) {
          throw new EditableArtifactMaterializerPermanentError(code, diagnostic);
        }
        settle();
      } catch (error) {
        const diagnosed = diagnoseSourceReaderFailure(error, "stream_identity");
        reject(diagnosed);
        throw diagnosed;
      }
    },
  });
  return { chunks, done };
}

function diagnoseSourceReaderFailure(
  error: unknown,
  subcode: Extract<
    EditableArtifactMaterializerFailureDiagnostic["subcode"],
    "open" | "stream_identity" | "revalidate"
  >,
): unknown {
  const code = permanentDependencyFailure(error);
  return code
    ? new EditableArtifactMaterializerPermanentError(code, { stage: "source_reader", subcode })
    : error;
}

function deterministicResultIds(
  job: ClaimedEditableArtifactMaterialization,
  contentHash: string,
): { resultId: string; blobRefId: string } {
  return {
    resultId: deterministicStableId("result", job, contentHash),
    blobRefId: deterministicStableId("blob", job, contentHash),
  };
}

function deterministicStableId(
  kind: "result" | "blob",
  job: ClaimedEditableArtifactMaterialization,
  contentHash: string,
): string {
  const digest = createHash("sha256");
  digest.update(`OpenGeni editable artifact materialization ${kind}\0v1\0`, "utf8");
  for (const value of [
    job.scope.accountId,
    job.scope.workspaceId,
    job.artifactId,
    job.jobId,
    contentHash,
  ]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    digest.update(length);
    digest.update(bytes);
  }
  const id = digest.digest("hex").slice(0, 32);
  return /^0+$/u.test(id) ? `1${id.slice(1)}` : id;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateFormatForModality(
  modality: EditableArtifactMaterializationModality,
  format: EditableArtifactMaterializationFormat,
): void {
  const allowed: Readonly<Record<EditableArtifactMaterializationModality, readonly string[]>> = {
    spreadsheet: ["xlsx", "pdf", "png", "webp"],
    presentation: ["pptx", "pdf", "png", "webp"],
    document: ["docx", "pdf", "png", "webp"],
  };
  if (!allowed[modality]?.includes(format)) {
    throw new TypeError("materialization format does not match artifact modality");
  }
}

export function mimeTypeForFormat(
  format: EditableArtifactMaterializationFormat,
): EditableArtifactMaterializationMimeType {
  switch (format) {
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
  }
}

function validateOwner(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new TypeError("materializer owner is invalid");
  }
  return value;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value) || /^0+$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function isLeaseFence(error: unknown): boolean {
  return (
    error instanceof EditableArtifactMaterializerLeaseLostError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "lease_fenced")
  );
}

function permanentDependencyFailure(
  error: unknown,
): EditableArtifactMaterializerDeadLetterCode | null {
  if (error instanceof EditableArtifactMaterializerPermanentError) return error.code;
  if (error instanceof BoundedObjectReadError) {
    if (error.code === "size_limit") return "source_size_limit";
    if (
      error.code === "object_changed" ||
      error.code === "truncated" ||
      error.code === "object_missing" ||
      error.code === "invalid_request"
    ) {
      return "source_identity_mismatch";
    }
  }
  if (error instanceof BoundedObjectWriteError) {
    if (error.code === "size_limit") return "output_size_limit";
    if (
      error.code === "content_hash_mismatch" ||
      error.code === "readback_mismatch" ||
      error.code === "truncated" ||
      error.code === "invalid_request"
    ) {
      return "output_verification_failed";
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError();
}

function abortError(): DOMException {
  return new DOMException("Operation aborted", "AbortError");
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const sources = first ? [first, second] : [second];
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const source of sources) {
    const listener = () => controller.abort(source.reason);
    if (source.aborted) listener();
    else {
      source.addEventListener("abort", listener, { once: true });
      listeners.push([source, listener]);
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    },
  };
}

async function sleepOrAbort(
  scheduler: EditableArtifactMaterializerSchedulerPort,
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await scheduler.sleep(milliseconds, signal);
    return true;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return false;
    throw error;
  }
}

function mutableSummary(): MutableSummary {
  return {
    claimed: 0,
    succeeded: 0,
    deadLettered: 0,
    retryDeferred: 0,
    leaseLost: 0,
    cancelled: 0,
    claimFailed: false,
  };
}

function freezeSummary(summary: MutableSummary): EditableArtifactMaterializerPassSummary {
  return Object.freeze({ ...summary });
}
