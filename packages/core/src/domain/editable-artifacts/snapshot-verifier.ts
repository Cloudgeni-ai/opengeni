import { createHash } from "node:crypto";
import {
  BoundedObjectReadError,
  MAX_BOUNDED_OBJECT_CHUNK_BYTES,
  type BoundedObjectRead,
  type BoundedObjectReadPort,
} from "@opengeni/storage";
import type { EditableArtifactSnapshotVerifierPort } from "./ports";
import { decodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import { EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES } from "@opengeni/contracts/editable-artifacts";
import {
  causalFrontiersEqual,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactStateHash,
  type EditableArtifactCausalFrontier,
  type EditableArtifactContentHash,
  type EditableArtifactId,
  type EditableArtifactScope,
  type EditableArtifactModality,
  type EditableArtifactStateHash,
  type PublishEditableArtifactSnapshotRequest,
} from "./types";

export const MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES = EDITABLE_ARTIFACT_PRODUCT_MAX_SNAPSHOT_BYTES;
export const MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_BYTES = 256 * 1024 * 1024;
export const MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_SEGMENTS = 100_000;
export const MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_SEGMENT_BYTES = 8 * 1024 * 1024;

export type EditableArtifactSnapshotVerificationErrorCode =
  | "cancelled"
  | "canonical_mismatch"
  | "content_hash_mismatch"
  | "content_type_mismatch"
  | "coverage_mismatch"
  | "frontier_mismatch"
  | "identity_mismatch"
  | "kernel_rejected"
  | "limit_exceeded"
  | "object_changed"
  | "object_missing"
  | "replay_invalid"
  | "state_hash_mismatch"
  | "storage_failure"
  | "truncated"
  | "version_mismatch";

/** Intentionally contains no provider diagnostic, reference, key, or URL. */
export class EditableArtifactSnapshotVerificationError extends Error {
  readonly code: EditableArtifactSnapshotVerificationErrorCode;

  constructor(code: EditableArtifactSnapshotVerificationErrorCode) {
    super(snapshotErrorMessage(code));
    this.name = "EditableArtifactSnapshotVerificationError";
    this.code = code;
  }
}

type EditableArtifactSnapshotReplaySegmentCommon = Readonly<{
  sequenceStart: number;
  sequenceEnd: number;
  contentHash: EditableArtifactContentHash;
  bytes: Uint8Array;
}>;

export type EditableArtifactSnapshotReplaySegment =
  | (EditableArtifactSnapshotReplaySegmentCommon &
      Readonly<{ modality: "spreadsheet"; operationProtocolVersion: number }>)
  | (EditableArtifactSnapshotReplaySegmentCommon &
      Readonly<{ modality: "document" | "presentation" }>);

type EditableArtifactSnapshotReplayPlanCommon = Readonly<{
  modality: EditableArtifactModality;
  /** Must equal the verified snapshot's coverage boundary. */
  baseHeadSequence: number;
  targetHeadSequence: number;
  targetStateHash: EditableArtifactStateHash;
  segments: AsyncIterable<EditableArtifactSnapshotReplaySegment>;
}>;

export type EditableArtifactSnapshotReplayPlan =
  | (EditableArtifactSnapshotReplayPlanCommon &
      Readonly<{
        modality: "spreadsheet";
        targetCausalFrontier: EditableArtifactCausalFrontier;
      }>)
  | (EditableArtifactSnapshotReplayPlanCommon &
      Readonly<{
        modality: "document" | "presentation";
        targetNativeRevision: number;
      }>);

/** Optional authoritative tail used to prove reconstruction to a later head. */
export interface EditableArtifactSnapshotReplayPlanPort {
  resolve(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    snapshot: PublishEditableArtifactSnapshotRequest;
    signal?: AbortSignal;
  }): Promise<EditableArtifactSnapshotReplayPlan | null>;
}

type IsolatedEditableArtifactSnapshotKernelResultCommon = Readonly<{
  modality: EditableArtifactModality;
  /** True only when canonical re-encoding was byte-equivalent to the input. */
  canonicalReencodeVerified: true;
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  canonicalByteSize: number;
  canonicalContentHash: EditableArtifactContentHash;
  coveredHeadSequence: number;
  stateHash: EditableArtifactStateHash;
  modelSchemaVersion: number;
  kernelVersion: string;
}>;

export type IsolatedEditableArtifactSnapshotKernelResult =
  | (IsolatedEditableArtifactSnapshotKernelResultCommon &
      Readonly<{
        modality: "spreadsheet";
        /** True only after decoding dots, vectors, tombstones, and undo metadata. */
        fullCrdtStateVerified: true;
        coveredCausalFrontier: EditableArtifactCausalFrontier;
        operationProtocolVersion: number;
        crdtStateVersion: number;
        replayedTarget?: Readonly<{
          headSequence: number;
          causalFrontier: EditableArtifactCausalFrontier;
          stateHash: EditableArtifactStateHash;
        }>;
      }>)
  | (IsolatedEditableArtifactSnapshotKernelResultCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
        replayedTarget?: Readonly<{
          headSequence: number;
          nativeRevision: number;
          stateHash: EditableArtifactStateHash;
        }>;
      }>);

/** Adapter to the exact no-network native kernel; JavaScript models are never authority. */
export interface IsolatedEditableArtifactSnapshotKernelPort {
  verifyAndReconstruct(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    modality: EditableArtifactModality;
    /** Durable coverage/version metadata stays distinct from native revision. */
    expectedSnapshot: PublishEditableArtifactSnapshotRequest;
    snapshotChunks: AsyncIterable<Uint8Array>;
    expectedSnapshotByteSize: number;
    replayPlan?: EditableArtifactSnapshotReplayPlan;
    signal?: AbortSignal;
  }): Promise<IsolatedEditableArtifactSnapshotKernelResult>;
}

export type ProductionEditableArtifactSnapshotVerifierDependencies = Readonly<{
  objects: BoundedObjectReadPort;
  kernel: IsolatedEditableArtifactSnapshotKernelPort;
  replayPlans?: EditableArtifactSnapshotReplayPlanPort;
  maxSnapshotBytes?: number;
  maxReplayBytes?: number;
  maxReplaySegments?: number;
  snapshotChunkBytes?: number;
}>;

/**
 * Production verifier for the existing domain port. Publication remains a
 * separate, short forward-only database CAS after this method succeeds.
 */
export class ProductionEditableArtifactSnapshotVerifier implements EditableArtifactSnapshotVerifierPort {
  readonly #dependencies: Readonly<{
    objects: BoundedObjectReadPort;
    kernel: IsolatedEditableArtifactSnapshotKernelPort;
    replayPlans: EditableArtifactSnapshotReplayPlanPort | undefined;
    maxSnapshotBytes: number;
    maxReplayBytes: number;
    maxReplaySegments: number;
    snapshotChunkBytes: number;
  }>;

  constructor(dependencies: ProductionEditableArtifactSnapshotVerifierDependencies) {
    const maxSnapshotBytes = dependencies.maxSnapshotBytes ?? MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES;
    const maxReplayBytes = dependencies.maxReplayBytes ?? MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_BYTES;
    const maxReplaySegments =
      dependencies.maxReplaySegments ?? MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_SEGMENTS;
    const snapshotChunkBytes = dependencies.snapshotChunkBytes ?? 1024 * 1024;
    for (const value of [maxSnapshotBytes, maxReplayBytes, maxReplaySegments, snapshotChunkBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError("Snapshot verifier limits must be positive safe integers");
      }
    }
    if (
      maxSnapshotBytes > MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES ||
      maxReplayBytes > MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_BYTES ||
      maxReplaySegments > MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_SEGMENTS ||
      snapshotChunkBytes > MAX_BOUNDED_OBJECT_CHUNK_BYTES
    ) {
      throw new TypeError("Snapshot verifier limits exceed absolute safety bounds");
    }
    this.#dependencies = Object.freeze({
      objects: dependencies.objects,
      kernel: dependencies.kernel,
      replayPlans: dependencies.replayPlans,
      maxSnapshotBytes,
      maxReplayBytes,
      maxReplaySegments,
      snapshotChunkBytes,
    });
  }

  async verify(
    input: Parameters<EditableArtifactSnapshotVerifierPort["verify"]>[0] & {
      signal?: AbortSignal;
    },
  ): Promise<void> {
    throwIfCancelled(input.signal);
    const scope = validateScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    const snapshot = input.snapshot;
    if (snapshot.byteSize > this.#dependencies.maxSnapshotBytes) {
      throw new EditableArtifactSnapshotVerificationError("limit_exceeded");
    }

    let object: BoundedObjectRead | undefined;
    try {
      object = await this.#dependencies.objects.open({
        opaqueReference: snapshot.blobReference,
        maxBytes: this.#dependencies.maxSnapshotBytes,
        expectedByteSize: snapshot.byteSize,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (object.contentType !== undefined && object.contentType !== snapshot.mimeType) {
        throw new EditableArtifactSnapshotVerificationError("content_type_mismatch");
      }

      const sourceDigest = createHash("sha256");
      let sourceBytes = 0;
      let sourceFinished = false;
      const sourceChunks = meterSnapshotChunks(
        object.chunks({
          chunkBytes: this.#dependencies.snapshotChunkBytes,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
        snapshot.byteSize,
        (chunk) => {
          sourceBytes += chunk.byteLength;
          sourceDigest.update(chunk);
        },
        () => {
          sourceFinished = true;
        },
      );

      const replayPlan = this.#dependencies.replayPlans
        ? await this.#dependencies.replayPlans.resolve({
            scope,
            artifactId,
            snapshot,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : null;
      const normalizedReplay = replayPlan
        ? validateReplayPlan(
            replayPlan,
            snapshot,
            this.#dependencies.maxReplayBytes,
            this.#dependencies.maxReplaySegments,
            input.signal,
          )
        : undefined;

      const result = await this.#dependencies.kernel.verifyAndReconstruct({
        scope,
        artifactId,
        modality: snapshot.modality,
        expectedSnapshot: snapshot,
        snapshotChunks: sourceChunks,
        expectedSnapshotByteSize: snapshot.byteSize,
        ...(normalizedReplay ? { replayPlan: normalizedReplay.replayPlan } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      throwIfCancelled(input.signal);
      if (!sourceFinished || sourceBytes !== snapshot.byteSize) {
        throw new EditableArtifactSnapshotVerificationError("truncated");
      }
      const sourceHash = editableArtifactContentHash(`sha256:${sourceDigest.digest("hex")}`);
      if (sourceHash !== snapshot.contentHash) {
        throw new EditableArtifactSnapshotVerificationError("content_hash_mismatch");
      }
      normalizedReplay?.assertConsumed();
      validateKernelResult(result, scope, artifactId, snapshot, normalizedReplay?.replayPlan);

      // The provider version is pinned during every range read and checked
      // once more after native reconstruction. The underlying opaque reference
      // is required to be immutable beyond this point.
      await object.assertUnchanged(input.signal);
    } catch (error) {
      throw mapVerificationFailure(error, input.signal);
    } finally {
      await object?.close();
    }
  }
}

function meterSnapshotChunks(
  chunks: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  onChunk: (chunk: Uint8Array) => void,
  onFinished: () => void,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let bytes = 0;
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
          throw new EditableArtifactSnapshotVerificationError("truncated");
        }
        bytes += chunk.byteLength;
        if (bytes > expectedBytes) {
          throw new EditableArtifactSnapshotVerificationError("limit_exceeded");
        }
        onChunk(chunk);
        yield chunk;
      }
      if (bytes !== expectedBytes) {
        throw new EditableArtifactSnapshotVerificationError("truncated");
      }
      onFinished();
    },
  };
}

function validateReplayPlan(
  plan: EditableArtifactSnapshotReplayPlan,
  snapshot: PublishEditableArtifactSnapshotRequest,
  maxBytes: number,
  maxSegments: number,
  signal: AbortSignal | undefined,
): Readonly<{
  replayPlan: NonNullable<
    Parameters<IsolatedEditableArtifactSnapshotKernelPort["verifyAndReconstruct"]>[0]["replayPlan"]
  >;
  assertConsumed(): void;
}> {
  if (
    plan.modality !== snapshot.modality ||
    !Number.isSafeInteger(plan.baseHeadSequence) ||
    !Number.isSafeInteger(plan.targetHeadSequence) ||
    plan.baseHeadSequence !== snapshot.coveredHeadSequence ||
    plan.targetHeadSequence < plan.baseHeadSequence
  ) {
    throw new EditableArtifactSnapshotVerificationError("replay_invalid");
  }
  const targetStateHash = editableArtifactStateHash(plan.targetStateHash);
  if (
    plan.modality !== "spreadsheet" &&
    (!Number.isSafeInteger(plan.targetNativeRevision) || plan.targetNativeRevision < 0)
  ) {
    throw new EditableArtifactSnapshotVerificationError("replay_invalid");
  }
  let consumed = false;
  const segments = meterReplaySegments(
    plan.segments,
    snapshot,
    plan,
    maxBytes,
    maxSegments,
    signal,
    () => {
      consumed = true;
    },
  );
  const replayPlan: EditableArtifactSnapshotReplayPlan =
    plan.modality === "spreadsheet"
      ? Object.freeze({
          modality: "spreadsheet",
          baseHeadSequence: plan.baseHeadSequence,
          targetHeadSequence: plan.targetHeadSequence,
          targetCausalFrontier: editableArtifactCausalFrontier(plan.targetCausalFrontier),
          targetStateHash,
          segments,
        })
      : Object.freeze({
          modality: plan.modality,
          baseHeadSequence: plan.baseHeadSequence,
          targetHeadSequence: plan.targetHeadSequence,
          targetNativeRevision: plan.targetNativeRevision,
          targetStateHash,
          segments,
        });
  return Object.freeze({
    replayPlan,
    assertConsumed() {
      if (!consumed) {
        throw new EditableArtifactSnapshotVerificationError("replay_invalid");
      }
    },
  });
}

function meterReplaySegments(
  segments: AsyncIterable<EditableArtifactSnapshotReplaySegment>,
  snapshot: PublishEditableArtifactSnapshotRequest,
  plan: EditableArtifactSnapshotReplayPlan,
  maxBytes: number,
  maxSegments: number,
  signal: AbortSignal | undefined,
  onFinished: () => void,
): AsyncIterable<EditableArtifactSnapshotReplaySegment> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<EditableArtifactSnapshotReplaySegment> {
      let expectedSequence = plan.baseHeadSequence + 1;
      let nativeRevision = snapshot.modality === "spreadsheet" ? null : snapshot.nativeRevision;
      let priorStateHash = snapshot.stateHash;
      let totalBytes = 0;
      let count = 0;
      for await (const segment of segments) {
        throwIfCancelled(signal);
        count += 1;
        if (count > maxSegments) {
          throw new EditableArtifactSnapshotVerificationError("limit_exceeded");
        }
        if (
          !Number.isSafeInteger(segment.sequenceStart) ||
          !Number.isSafeInteger(segment.sequenceEnd) ||
          segment.sequenceStart !== expectedSequence ||
          segment.sequenceEnd < segment.sequenceStart ||
          segment.sequenceEnd > plan.targetHeadSequence ||
          segment.modality !== snapshot.modality ||
          !(segment.bytes instanceof Uint8Array) ||
          segment.bytes.byteLength < 1 ||
          segment.bytes.byteLength > MAX_EDITABLE_ARTIFACT_SNAPSHOT_TAIL_SEGMENT_BYTES
        ) {
          throw new EditableArtifactSnapshotVerificationError("replay_invalid");
        }
        totalBytes += segment.bytes.byteLength;
        if (totalBytes > maxBytes) {
          throw new EditableArtifactSnapshotVerificationError("limit_exceeded");
        }
        const hash = editableArtifactContentHash(
          `sha256:${createHash("sha256").update(segment.bytes).digest("hex")}`,
        );
        if (hash !== segment.contentHash) {
          throw new EditableArtifactSnapshotVerificationError("replay_invalid");
        }
        if (snapshot.modality === "spreadsheet") {
          if (
            segment.modality !== "spreadsheet" ||
            segment.operationProtocolVersion !== snapshot.operationProtocolVersion
          ) {
            throw new EditableArtifactSnapshotVerificationError("replay_invalid");
          }
        } else {
          if (
            segment.modality !== snapshot.modality ||
            segment.sequenceEnd !== segment.sequenceStart
          ) {
            throw new EditableArtifactSnapshotVerificationError("replay_invalid");
          }
          try {
            const summary = decodeEditableArtifactSerializedCommit(
              segment.bytes,
              snapshot.modality,
            );
            if (
              summary.parentHeadSequence !== segment.sequenceStart - 1 ||
              summary.resultHeadSequence !== segment.sequenceEnd ||
              summary.priorNativeRevision !== nativeRevision ||
              summary.priorStateHash !== priorStateHash
            ) {
              throw new EditableArtifactSnapshotVerificationError("replay_invalid");
            }
            nativeRevision = summary.nativeReceipt.revision;
            priorStateHash = editableArtifactStateHash(summary.stateHash);
          } catch (error) {
            if (error instanceof EditableArtifactSnapshotVerificationError) throw error;
            throw new EditableArtifactSnapshotVerificationError("replay_invalid");
          }
        }
        expectedSequence = segment.sequenceEnd + 1;
        yield segment.modality === "spreadsheet"
          ? Object.freeze({
              ...segment,
              modality: "spreadsheet" as const,
              bytes: segment.bytes.slice(),
            })
          : Object.freeze({
              ...segment,
              modality: segment.modality,
              bytes: segment.bytes.slice(),
            });
      }
      if (expectedSequence !== plan.targetHeadSequence + 1) {
        throw new EditableArtifactSnapshotVerificationError("replay_invalid");
      }
      if (
        plan.modality !== "spreadsheet" &&
        (nativeRevision !== plan.targetNativeRevision || priorStateHash !== plan.targetStateHash)
      ) {
        throw new EditableArtifactSnapshotVerificationError("replay_invalid");
      }
      onFinished();
    },
  };
}

function validateKernelResult(
  result: IsolatedEditableArtifactSnapshotKernelResult,
  scope: EditableArtifactScope,
  artifactId: EditableArtifactId,
  snapshot: PublishEditableArtifactSnapshotRequest,
  replayPlan:
    | NonNullable<
        Parameters<
          IsolatedEditableArtifactSnapshotKernelPort["verifyAndReconstruct"]
        >[0]["replayPlan"]
      >
    | undefined,
): void {
  if (
    result.canonicalReencodeVerified !== true ||
    result.modality !== snapshot.modality ||
    result.canonicalByteSize !== snapshot.byteSize ||
    result.canonicalContentHash !== snapshot.contentHash
  ) {
    throw new EditableArtifactSnapshotVerificationError("canonical_mismatch");
  }
  if (
    result.scope.accountId !== scope.accountId ||
    result.scope.workspaceId !== scope.workspaceId ||
    result.artifactId !== artifactId
  ) {
    throw new EditableArtifactSnapshotVerificationError("identity_mismatch");
  }
  if (result.coveredHeadSequence !== snapshot.coveredHeadSequence) {
    throw new EditableArtifactSnapshotVerificationError("coverage_mismatch");
  }
  if (editableArtifactStateHash(result.stateHash) !== snapshot.stateHash) {
    throw new EditableArtifactSnapshotVerificationError("state_hash_mismatch");
  }
  if (
    result.modelSchemaVersion !== snapshot.modelSchemaVersion ||
    result.kernelVersion !== snapshot.kernelVersion
  ) {
    throw new EditableArtifactSnapshotVerificationError("version_mismatch");
  }
  if (snapshot.modality === "spreadsheet") {
    if (
      result.modality !== "spreadsheet" ||
      result.fullCrdtStateVerified !== true ||
      !causalFrontiersEqual(
        editableArtifactCausalFrontier(result.coveredCausalFrontier),
        snapshot.coveredCausalFrontier,
      )
    ) {
      throw new EditableArtifactSnapshotVerificationError("frontier_mismatch");
    }
    if (
      result.operationProtocolVersion !== snapshot.operationProtocolVersion ||
      result.crdtStateVersion !== snapshot.crdtStateVersion
    ) {
      throw new EditableArtifactSnapshotVerificationError("version_mismatch");
    }
    if (replayPlan) {
      if (
        replayPlan.modality !== "spreadsheet" ||
        !result.replayedTarget ||
        result.replayedTarget.headSequence !== replayPlan.targetHeadSequence ||
        editableArtifactStateHash(result.replayedTarget.stateHash) !== replayPlan.targetStateHash ||
        !causalFrontiersEqual(
          editableArtifactCausalFrontier(result.replayedTarget.causalFrontier),
          replayPlan.targetCausalFrontier,
        )
      ) {
        throw new EditableArtifactSnapshotVerificationError("replay_invalid");
      }
    } else if (result.replayedTarget !== undefined) {
      throw new EditableArtifactSnapshotVerificationError("replay_invalid");
    }
    return;
  }
  if (result.modality !== snapshot.modality || result.nativeRevision !== snapshot.nativeRevision) {
    throw new EditableArtifactSnapshotVerificationError("version_mismatch");
  }
  if (replayPlan) {
    if (
      replayPlan.modality !== snapshot.modality ||
      !result.replayedTarget ||
      result.replayedTarget.headSequence !== replayPlan.targetHeadSequence ||
      result.replayedTarget.nativeRevision !== replayPlan.targetNativeRevision ||
      editableArtifactStateHash(result.replayedTarget.stateHash) !== replayPlan.targetStateHash
    ) {
      throw new EditableArtifactSnapshotVerificationError("replay_invalid");
    }
  } else if (result.replayedTarget !== undefined) {
    throw new EditableArtifactSnapshotVerificationError("replay_invalid");
  }
}

function validateScope(scope: EditableArtifactScope): EditableArtifactScope {
  if (
    typeof scope.accountId !== "string" ||
    scope.accountId.length < 1 ||
    typeof scope.workspaceId !== "string" ||
    scope.workspaceId.length < 1
  ) {
    throw new EditableArtifactSnapshotVerificationError("identity_mismatch");
  }
  return Object.freeze({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EditableArtifactSnapshotVerificationError("cancelled");
  }
}

function mapVerificationFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): EditableArtifactSnapshotVerificationError {
  if (error instanceof EditableArtifactSnapshotVerificationError) return error;
  if (signal?.aborted) {
    return new EditableArtifactSnapshotVerificationError("cancelled");
  }
  if (error instanceof BoundedObjectReadError) {
    switch (error.code) {
      case "aborted":
        return new EditableArtifactSnapshotVerificationError("cancelled");
      case "object_changed":
        return new EditableArtifactSnapshotVerificationError("object_changed");
      case "object_missing":
        return new EditableArtifactSnapshotVerificationError("object_missing");
      case "size_limit":
        return new EditableArtifactSnapshotVerificationError("limit_exceeded");
      case "truncated":
        return new EditableArtifactSnapshotVerificationError("truncated");
      case "backend_failure":
      case "invalid_request":
        return new EditableArtifactSnapshotVerificationError("storage_failure");
    }
  }
  return new EditableArtifactSnapshotVerificationError("kernel_rejected");
}

function snapshotErrorMessage(code: EditableArtifactSnapshotVerificationErrorCode): string {
  switch (code) {
    case "cancelled":
      return "Snapshot verification was cancelled";
    case "canonical_mismatch":
      return "Snapshot is not the canonical kernel encoding";
    case "content_hash_mismatch":
      return "Snapshot content digest does not match immutable metadata";
    case "content_type_mismatch":
      return "Snapshot content type does not match immutable metadata";
    case "coverage_mismatch":
      return "Snapshot coverage does not match embedded state";
    case "frontier_mismatch":
      return "Snapshot causal frontier does not match embedded state";
    case "identity_mismatch":
      return "Snapshot authority identity does not match embedded state";
    case "kernel_rejected":
      return "Authoritative kernel rejected the snapshot";
    case "limit_exceeded":
      return "Snapshot exceeds a verification limit";
    case "object_changed":
      return "Snapshot object changed during verification";
    case "object_missing":
      return "Snapshot object is unavailable";
    case "replay_invalid":
      return "Snapshot operation-tail reconstruction is invalid";
    case "state_hash_mismatch":
      return "Snapshot state hash does not match reconstructed state";
    case "storage_failure":
      return "Snapshot object could not be read safely";
    case "truncated":
      return "Snapshot object is truncated";
    case "version_mismatch":
      return "Snapshot kernel or schema versions are incompatible";
  }
}
