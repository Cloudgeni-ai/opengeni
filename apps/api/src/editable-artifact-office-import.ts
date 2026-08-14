import { createHash } from "node:crypto";
import {
  ArtifactOfficeSourceUnsupportedError,
  prepareArtifactOfficeImport,
  type ArtifactOfficeMimeType,
} from "@opengeni/artifact-tool/office-import";
import {
  MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
  EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES,
  editableArtifactCausalFrontier,
  editableArtifactContentHash,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  EditableArtifactOfficeImportError,
  type EditableArtifactActor,
  type EditableArtifactOfficeImportPort,
  type EditableArtifactModality,
  type EditableArtifactScope,
} from "@opengeni/core/editable-artifacts";
import { requireLiveAgentAttemptAuthorization } from "@opengeni/core";
import { getFilesForSubject } from "@opengeni/db";
import {
  MAX_BOUNDED_OBJECT_CHUNK_BYTES,
  type BoundedImmutableObjectWritePort,
  type ObjectStorage,
} from "@opengeni/storage";
import type { Database } from "@opengeni/db";
import type { VerifiedNativeArtifactRuntimeBinding } from "./editable-artifact-native-kernel";

const SNAPSHOT_MIME = "application/vnd.opengeni.editable-artifact-snapshot" as const;

export type EditableArtifactOfficeImportAdapterDependencies = Readonly<{
  db: Database;
  objectStorage: ObjectStorage;
  runtime: VerifiedNativeArtifactRuntimeBinding;
  sourceObjects: BoundedImmutableObjectWritePort;
  snapshotObjects: BoundedImmutableObjectWritePort;
  readFiles?: typeof getFilesForSubject;
  resolveFileAuthoritySubjectId?: typeof editableArtifactFileAuthoritySubjectId;
  prepareOffice?: typeof prepareArtifactOfficeImport;
}>;

/** Trusted import boundary from one ready workspace file into native sequence-zero state. */
export class EditableArtifactOfficeImportAdapter implements EditableArtifactOfficeImportPort {
  private readonly readFiles: typeof getFilesForSubject;
  private readonly resolveFileAuthoritySubjectId: typeof editableArtifactFileAuthoritySubjectId;

  constructor(private readonly dependencies: EditableArtifactOfficeImportAdapterDependencies) {
    this.readFiles = dependencies.readFiles ?? getFilesForSubject;
    this.resolveFileAuthoritySubjectId =
      dependencies.resolveFileAuthoritySubjectId ?? editableArtifactFileAuthoritySubjectId;
  }

  async prepare(
    input: Parameters<EditableArtifactOfficeImportPort["prepare"]>[0],
  ): ReturnType<EditableArtifactOfficeImportPort["prepare"]> {
    throwIfAborted(input.signal);
    const subjectId = await this.resolveFileAuthoritySubjectId(
      this.dependencies.db,
      input.scope,
      input.actor,
    );
    const [file] = await this.readFiles(this.dependencies.db, {
      accountId: input.scope.accountId,
      workspaceId: input.scope.workspaceId,
      subjectId,
      fileIds: [input.fileId],
    });
    if (!file || file.status !== "ready") {
      throw new EditableArtifactOfficeImportError("invalid_source");
    }
    const expectedMimeType = officeMimeType(input.modality);
    if (
      file.contentType !== expectedMimeType ||
      !officeFilenameMatches(file.filename, input.modality) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 1 ||
      file.sizeBytes > EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new EditableArtifactOfficeImportError("invalid_source");
    }
    const sourceBytes = await readVerifiedWorkspaceFile(
      this.dependencies.objectStorage,
      file,
      input.signal,
    );
    const prepared = await prepareOfficeImport({
      runtime: this.dependencies.runtime,
      modality: input.modality,
      filename: file.filename,
      mimeType: expectedMimeType,
      bytes: sourceBytes,
      prepare: this.dependencies.prepareOffice ?? prepareArtifactOfficeImport,
    });
    const retainedSource = await this.dependencies.sourceObjects.write({
      chunks: byteChunks(sourceBytes),
      contentType: expectedMimeType,
      maxBytes: EDITABLE_ARTIFACT_ORIGINAL_IMPORT_MAX_BYTES,
      expectedByteSize: prepared.source.byteSize,
      expectedContentHash: prepared.source.contentHash,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const retainedSnapshot = await this.dependencies.snapshotObjects.write({
      chunks: byteChunks(prepared.snapshot.bytes),
      contentType: SNAPSHOT_MIME,
      maxBytes: MAX_EDITABLE_ARTIFACT_SNAPSHOT_BYTES,
      expectedByteSize: prepared.snapshot.byteSize,
      expectedContentHash: prepared.snapshot.contentHash,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const common = {
      modality: prepared.snapshot.modality,
      blobReference: retainedSnapshot.opaqueReference,
      byteSize: prepared.snapshot.byteSize,
      contentHash: editableArtifactContentHash(prepared.snapshot.contentHash),
      mimeType: SNAPSHOT_MIME,
      coveredHeadSequence: 0 as const,
      stateHash: editableArtifactStateHash(prepared.snapshot.stateHash),
      modelSchemaVersion: prepared.snapshot.modelSchemaVersion,
      kernelVersion: prepared.snapshot.kernelVersion,
    };
    return Object.freeze({
      originalImport: Object.freeze({
        fileId: file.id,
        blobReference: retainedSource.opaqueReference,
        byteSize: prepared.source.byteSize,
        contentHash: editableArtifactContentHash(prepared.source.contentHash),
        mimeType: expectedMimeType,
      }),
      snapshot:
        prepared.snapshot.modality === "spreadsheet"
          ? Object.freeze({
              ...common,
              modality: "spreadsheet" as const,
              coveredCausalFrontier: editableArtifactCausalFrontier(
                prepared.snapshot.coveredCausalFrontier.map((entry) => ({
                  replicaId: editableArtifactReplicaId(entry.replicaId),
                  counter: entry.counter,
                })),
              ),
              operationProtocolVersion: prepared.snapshot.operationProtocolVersion,
              crdtStateVersion: prepared.snapshot.crdtStateVersion,
            })
          : Object.freeze({
              ...common,
              modality: prepared.snapshot.modality,
              nativeRevision: prepared.snapshot.nativeRevision,
            }),
    });
  }
}

async function prepareOfficeImport(input: {
  runtime: VerifiedNativeArtifactRuntimeBinding;
  modality: EditableArtifactModality;
  filename: string;
  mimeType: ArtifactOfficeMimeType;
  bytes: Uint8Array;
  prepare: typeof prepareArtifactOfficeImport;
}) {
  try {
    return await input.prepare({
      facade: input.runtime.facade,
      modality: input.modality,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      expectedRuntimeTarget: input.runtime.location.target,
      expectedKernelVersion: input.runtime.runtime.buildIdentity,
    });
  } catch (error) {
    if (error instanceof ArtifactOfficeSourceUnsupportedError) {
      throw new EditableArtifactOfficeImportError("unsupported_content");
    }
    throw error;
  }
}

function officeMimeType(modality: EditableArtifactModality): ArtifactOfficeMimeType {
  if (modality === "spreadsheet") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (modality === "document") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function officeFilenameMatches(filename: string, modality: EditableArtifactModality): boolean {
  const extension =
    modality === "spreadsheet" ? ".xlsx" : modality === "document" ? ".docx" : ".pptx";
  return filename.toLowerCase().endsWith(extension);
}

async function readVerifiedWorkspaceFile(
  storage: ObjectStorage,
  file: NonNullable<Awaited<ReturnType<typeof getFilesForSubject>>>[number],
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const before = await storage.headFile(file);
  if (
    before.ContentLength !== file.sizeBytes ||
    before.ContentType !== file.contentType ||
    before.Metadata?.sha256 !== file.sha256 ||
    typeof before.VersionToken !== "string" ||
    before.VersionToken.length < 1
  ) {
    throw new EditableArtifactOfficeImportError("source_changed");
  }
  const bytes = new Uint8Array(file.sizeBytes);
  const digest = createHash("sha256");
  for (let start = 0; start < file.sizeBytes; start += MAX_BOUNDED_OBJECT_CHUNK_BYTES) {
    throwIfAborted(signal);
    const end = Math.min(file.sizeBytes, start + MAX_BOUNDED_OBJECT_CHUNK_BYTES) - 1;
    const chunk = await storage.getFileRange(file, { start, end });
    if (!chunk || chunk.byteLength !== end - start + 1) {
      throw new EditableArtifactOfficeImportError("source_changed");
    }
    bytes.set(chunk, start);
    digest.update(chunk);
  }
  const after = await storage.headFile(file);
  const sha256 = digest.digest("hex");
  if (
    after.ContentLength !== before.ContentLength ||
    after.ContentType !== before.ContentType ||
    after.Metadata?.sha256 !== before.Metadata?.sha256 ||
    after.VersionToken !== before.VersionToken ||
    sha256 !== file.sha256
  ) {
    throw new EditableArtifactOfficeImportError("source_changed");
  }
  return bytes;
}

export async function editableArtifactFileAuthoritySubjectId(
  db: Database,
  scope: EditableArtifactScope,
  actor: EditableArtifactActor,
): Promise<string | null> {
  if (actor.kind !== "agent") return actor.subjectId;
  const authorization = await requireLiveAgentAttemptAuthorization(
    db,
    {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: actor.subjectId,
      permissions: [],
      principalKind: "agent_attempt",
      metadata: {
        sessionId: actor.sessionId,
        turnId: actor.turnId,
        attemptId: actor.attemptId,
        executionGeneration: actor.generation,
      },
    },
    actor.sessionId,
  );
  return authorization.initiatingHumanSubjectId;
}

async function* byteChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_BOUNDED_OBJECT_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + MAX_BOUNDED_OBJECT_CHUNK_BYTES);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Artifact import aborted");
}
