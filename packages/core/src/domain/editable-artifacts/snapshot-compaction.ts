import { type BoundedImmutableObjectWritePort, BoundedObjectWriteError } from "@opengeni/storage";

import type { EditableArtifactCompactionPort, EditableArtifactKernelState } from "./ports";
import {
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  EditableArtifactSnapshotVerificationError,
} from "./snapshot-verifier";
import {
  assertBoundedKernelVersion,
  causalFrontiersEqual,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactId,
  editableArtifactScope,
  editableArtifactSnapshotId,
  editableArtifactStateHash,
  type EditableArtifactCausalFrontier,
  type EditableArtifactContentHash,
  type EditableArtifactId,
  type EditableArtifactModality,
  type EditableArtifactScope,
  type EditableArtifactStateHash,
  type PublishEditableArtifactSnapshotRequest,
} from "./types";

const SNAPSHOT_MIME_TYPE = "application/vnd.opengeni.editable-artifact-snapshot" as const;

type AuthoritativeEditableArtifactCompactionKernelResultCommon = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  canonicalChunks: AsyncIterable<Uint8Array>;
  canonicalByteSize: number;
  canonicalContentHash: EditableArtifactContentHash;
  stateHash: EditableArtifactStateHash;
  coveredHeadSequence: number;
  modelSchemaVersion: number;
  kernelVersion: string;
}>;

export type AuthoritativeEditableArtifactCompactionKernelResult =
  | (AuthoritativeEditableArtifactCompactionKernelResultCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontier: EditableArtifactCausalFrontier;
        operationProtocolVersion: number;
        crdtStateVersion: number;
      }>)
  | (AuthoritativeEditableArtifactCompactionKernelResultCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

/** Native authority that replays one detached durable basis without network access. */
export interface AuthoritativeEditableArtifactCompactionKernelPort {
  createCanonicalSnapshot(input: {
    state: EditableArtifactKernelState;
    signal?: AbortSignal;
  }): Promise<AuthoritativeEditableArtifactCompactionKernelResult>;
}

export type EditableArtifactCompactionPipelineDependencies = Readonly<{
  kernel: AuthoritativeEditableArtifactCompactionKernelPort;
  objects: BoundedImmutableObjectWritePort;
  now: () => Date;
  maxSnapshotBytes?: number;
}>;

/** Reconstruct, canonicalize, and upload an exact-head state-neutral snapshot. */
export class EditableArtifactCompactionPipeline implements EditableArtifactCompactionPort {
  readonly #dependencies: Readonly<{
    kernel: AuthoritativeEditableArtifactCompactionKernelPort;
    objects: BoundedImmutableObjectWritePort;
    now: () => Date;
    maxSnapshotBytes: number;
  }>;

  constructor(dependencies: EditableArtifactCompactionPipelineDependencies) {
    const maxSnapshotBytes = dependencies.maxSnapshotBytes ?? MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES;
    if (
      !Number.isSafeInteger(maxSnapshotBytes) ||
      maxSnapshotBytes <= 0 ||
      maxSnapshotBytes > MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES
    ) {
      throw new TypeError("Compaction snapshot limit is invalid");
    }
    this.#dependencies = Object.freeze({ ...dependencies, maxSnapshotBytes });
  }

  async prepare(
    input: Parameters<EditableArtifactCompactionPort["prepare"]>[0],
  ): Promise<PublishEditableArtifactSnapshotRequest> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    const snapshotId = editableArtifactSnapshotId(input.snapshotId);
    validateBasis(input.state, scope, artifactId);
    throwIfCancelled(input.signal);
    try {
      const generated = await this.#dependencies.kernel.createCanonicalSnapshot({
        state: input.state,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      validateGenerated(generated, input.state, scope, artifactId);
      const stored = await this.#dependencies.objects.write({
        chunks: generated.canonicalChunks,
        contentType: SNAPSHOT_MIME_TYPE,
        maxBytes: this.#dependencies.maxSnapshotBytes,
        expectedByteSize: generated.canonicalByteSize,
        expectedContentHash: generated.canonicalContentHash,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const common = {
        snapshotId,
        blobReference: stored.opaqueReference,
        byteSize: stored.byteSize,
        contentHash: editableArtifactContentHash(stored.contentHash),
        mimeType: SNAPSHOT_MIME_TYPE,
        modality: generated.modality,
        coveredHeadSequence: generated.coveredHeadSequence,
        stateHash: generated.stateHash,
        modelSchemaVersion: generated.modelSchemaVersion,
        kernelVersion: generated.kernelVersion,
        verifiedAt: canonicalTimestamp(this.#dependencies.now()),
      } as const;
      return generated.modality === "spreadsheet"
        ? Object.freeze({
            ...common,
            modality: generated.modality,
            coveredCausalFrontier: generated.coveredCausalFrontier,
            operationProtocolVersion: generated.operationProtocolVersion,
            crdtStateVersion: generated.crdtStateVersion,
          })
        : Object.freeze({
            ...common,
            modality: generated.modality,
            nativeRevision: generated.nativeRevision,
          });
    } catch (error) {
      if (
        error instanceof EditableArtifactSnapshotVerificationError ||
        error instanceof BoundedObjectWriteError
      ) {
        throw error;
      }
      if (input.signal?.aborted) {
        throw new EditableArtifactSnapshotVerificationError("cancelled");
      }
      throw new EditableArtifactSnapshotVerificationError("kernel_rejected");
    }
  }
}

function validateBasis(
  state: EditableArtifactKernelState,
  scope: EditableArtifactScope,
  artifactId: EditableArtifactId,
): void {
  if (
    state.artifact.scope.accountId !== scope.accountId ||
    state.artifact.scope.workspaceId !== scope.workspaceId ||
    state.artifact.id !== artifactId ||
    state.artifact.modality !== state.modality
  ) {
    throw new EditableArtifactSnapshotVerificationError("identity_mismatch");
  }
  for (const value of [state.tailTransactionCount, state.tailByteSize]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EditableArtifactSnapshotVerificationError("coverage_mismatch");
    }
  }
}

function validateGenerated(
  value: AuthoritativeEditableArtifactCompactionKernelResult,
  state: EditableArtifactKernelState,
  scope: EditableArtifactScope,
  artifactId: EditableArtifactId,
): void {
  if (
    value.scope.accountId !== scope.accountId ||
    value.scope.workspaceId !== scope.workspaceId ||
    value.artifactId !== artifactId ||
    value.modality !== state.modality
  ) {
    throw new EditableArtifactSnapshotVerificationError("identity_mismatch");
  }
  if (
    value.coveredHeadSequence !== state.artifact.headSequence ||
    editableArtifactStateHash(value.stateHash) !== state.artifact.stateHash ||
    (value.modality === "spreadsheet" &&
      (state.modality !== "spreadsheet" ||
        !causalFrontiersEqual(
          editableArtifactCausalFrontier(value.coveredCausalFrontier),
          state.artifact.causalFrontier,
        ))) ||
    (value.modality !== "spreadsheet" &&
      (state.modality === "spreadsheet" || value.nativeRevision !== expectedNativeRevision(state)))
  ) {
    throw new EditableArtifactSnapshotVerificationError("coverage_mismatch");
  }
  if (
    !Number.isSafeInteger(value.canonicalByteSize) ||
    value.canonicalByteSize <= 0 ||
    value.canonicalByteSize > MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES
  ) {
    throw new EditableArtifactSnapshotVerificationError("limit_exceeded");
  }
  editableArtifactContentHash(value.canonicalContentHash);
  const versions =
    value.modality === "spreadsheet"
      ? [value.modelSchemaVersion, value.operationProtocolVersion, value.crdtStateVersion]
      : [value.modelSchemaVersion];
  if (versions.some((version) => !Number.isSafeInteger(version) || version <= 0)) {
    throw new EditableArtifactSnapshotVerificationError("version_mismatch");
  }
  try {
    assertBoundedKernelVersion(value.kernelVersion);
  } catch {
    throw new EditableArtifactSnapshotVerificationError("version_mismatch");
  }
  if (!value.canonicalChunks || typeof value.canonicalChunks[Symbol.asyncIterator] !== "function") {
    throw new EditableArtifactSnapshotVerificationError("kernel_rejected");
  }
}

function expectedNativeRevision(
  state: Extract<EditableArtifactKernelState, { modality: "document" | "presentation" }>,
): number {
  return (
    state.committedTransactionTail.at(-1)?.nativeRevision ??
    state.snapshot?.nativeRevision ??
    state.baseNativeRevision
  );
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Compaction verification clock returned an invalid date");
  }
  return value.toISOString();
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EditableArtifactSnapshotVerificationError("cancelled");
}
