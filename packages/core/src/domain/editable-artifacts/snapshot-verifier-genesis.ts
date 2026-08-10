import { type BoundedImmutableObjectWritePort, BoundedObjectWriteError } from "@opengeni/storage";
import type { EditableArtifactGenesisPort } from "./ports";
import {
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  EditableArtifactSnapshotVerificationError,
} from "./snapshot-verifier";
import {
  editableArtifactCausalFrontier,
  assertBoundedKernelVersion,
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

type AuthoritativeEditableArtifactGenesisKernelResultCommon = Readonly<{
  scope: EditableArtifactScope;
  artifactId: EditableArtifactId;
  modality: EditableArtifactModality;
  canonicalChunks: AsyncIterable<Uint8Array>;
  canonicalByteSize: number;
  canonicalContentHash: EditableArtifactContentHash;
  stateHash: EditableArtifactStateHash;
  coveredHeadSequence: 0;
  modelSchemaVersion: number;
  kernelVersion: string;
}>;

export type AuthoritativeEditableArtifactGenesisKernelResult =
  | (AuthoritativeEditableArtifactGenesisKernelResultCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontier: EditableArtifactCausalFrontier;
        operationProtocolVersion: number;
        crdtStateVersion: number;
      }>)
  | (AuthoritativeEditableArtifactGenesisKernelResultCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: 0;
      }>);

/** Trusted no-network native-kernel subprocess; never an HTTP request adapter. */
export interface AuthoritativeEditableArtifactGenesisKernelPort {
  createCanonicalEmptySnapshot(input: {
    scope: EditableArtifactScope;
    artifactId: EditableArtifactId;
    modality: EditableArtifactModality;
    signal?: AbortSignal;
  }): Promise<AuthoritativeEditableArtifactGenesisKernelResult>;
}

export type EditableArtifactGenesisPipelineDependencies = Readonly<{
  kernel: AuthoritativeEditableArtifactGenesisKernelPort;
  objects: BoundedImmutableObjectWritePort;
  now: () => Date;
  maxSnapshotBytes?: number;
}>;

/**
 * Creates the only legal sequence-zero candidate. The domain service passes
 * the result through its unchanged snapshot verifier, then commits artifact +
 * checkpoint-0 + snapshot + blob-ref + receipt + outbox atomically.
 */
export class EditableArtifactGenesisPipeline implements EditableArtifactGenesisPort {
  readonly #dependencies: Readonly<{
    kernel: AuthoritativeEditableArtifactGenesisKernelPort;
    objects: BoundedImmutableObjectWritePort;
    now: () => Date;
    maxSnapshotBytes: number;
  }>;

  constructor(dependencies: EditableArtifactGenesisPipelineDependencies) {
    const maxSnapshotBytes = dependencies.maxSnapshotBytes ?? MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES;
    if (
      !Number.isSafeInteger(maxSnapshotBytes) ||
      maxSnapshotBytes <= 0 ||
      maxSnapshotBytes > MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES
    ) {
      throw new TypeError("Genesis snapshot limit is invalid");
    }
    this.#dependencies = Object.freeze({
      kernel: dependencies.kernel,
      objects: dependencies.objects,
      now: dependencies.now,
      maxSnapshotBytes,
    });
  }

  async prepare(
    input: Parameters<EditableArtifactGenesisPort["prepare"]>[0],
  ): Promise<PublishEditableArtifactSnapshotRequest> {
    const scope = editableArtifactScope(input.scope);
    const artifactId = editableArtifactId(input.artifactId);
    const snapshotId = editableArtifactSnapshotId(input.snapshotId);
    if (!isModality(input.modality)) {
      throw new TypeError("Genesis modality is invalid");
    }
    throwIfGenesisCancelled(input.signal);
    try {
      const generated = await this.#dependencies.kernel.createCanonicalEmptySnapshot({
        scope,
        artifactId,
        modality: input.modality,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      validateGeneratedGenesis(generated, scope, artifactId, input.modality);
      const stored = await this.#dependencies.objects.write({
        chunks: generated.canonicalChunks,
        contentType: SNAPSHOT_MIME_TYPE,
        maxBytes: this.#dependencies.maxSnapshotBytes,
        expectedByteSize: generated.canonicalByteSize,
        expectedContentHash: generated.canonicalContentHash,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const verifiedAt = canonicalTimestamp(this.#dependencies.now());
      const common = {
        snapshotId,
        blobReference: stored.opaqueReference,
        byteSize: stored.byteSize,
        contentHash: editableArtifactContentHash(stored.contentHash),
        mimeType: SNAPSHOT_MIME_TYPE,
        modality: generated.modality,
        coveredHeadSequence: 0,
        stateHash: generated.stateHash,
        modelSchemaVersion: generated.modelSchemaVersion,
        kernelVersion: generated.kernelVersion,
        verifiedAt,
      } as const;
      return generated.modality === "spreadsheet"
        ? Object.freeze({
            ...common,
            modality: "spreadsheet" as const,
            coveredCausalFrontier: editableArtifactCausalFrontier([]),
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
      // Native generation diagnostics may contain internal paths. Preserve no
      // cause across this service boundary.
      throw new EditableArtifactSnapshotVerificationError("kernel_rejected");
    }
  }
}

function validateGeneratedGenesis(
  value: AuthoritativeEditableArtifactGenesisKernelResult,
  scope: EditableArtifactScope,
  artifactId: EditableArtifactId,
  modality: EditableArtifactModality,
): void {
  if (
    value.scope.accountId !== scope.accountId ||
    value.scope.workspaceId !== scope.workspaceId ||
    value.artifactId !== artifactId ||
    value.modality !== modality
  ) {
    throw new EditableArtifactSnapshotVerificationError("identity_mismatch");
  }
  if (
    value.coveredHeadSequence !== 0 ||
    (value.modality === "spreadsheet"
      ? editableArtifactCausalFrontier(value.coveredCausalFrontier).length !== 0
      : value.nativeRevision !== 0)
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
  editableArtifactStateHash(value.stateHash);
  const versions =
    value.modality === "spreadsheet"
      ? [value.modelSchemaVersion, value.operationProtocolVersion, value.crdtStateVersion]
      : [value.modelSchemaVersion];
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new EditableArtifactSnapshotVerificationError("version_mismatch");
    }
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

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Genesis verification clock returned an invalid date");
  }
  return value.toISOString();
}

function isModality(value: unknown): value is EditableArtifactModality {
  return value === "spreadsheet" || value === "presentation" || value === "document";
}

function throwIfGenesisCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new EditableArtifactSnapshotVerificationError("cancelled");
  }
}
