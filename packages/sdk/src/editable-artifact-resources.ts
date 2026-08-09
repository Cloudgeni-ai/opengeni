import type { OpenGeniRequestOptions } from "./client";
import type { EditableArtifactModality } from "./editable-artifacts/types";

/** Durable metadata returned by the editable-artifact product API. */
export type EditableArtifactResource = Readonly<{
  id: string;
  modality: EditableArtifactModality;
  title: string;
  lifecycle: "active" | "archived";
  headSequence: number;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateEditableArtifactResourceRequest = Readonly<{
  /** Stable across transport retries; conflicting reuse is rejected. */
  idempotencyKey: string;
  /** Exact writer replica that will open the first live editing session. */
  replicaId: string;
  modality: EditableArtifactModality;
  title: string;
}>;

type ImportEditableArtifactSnapshotCommon = Readonly<{
  blobReference: string;
  byteSize: number;
  contentHash: string;
  mimeType: "application/vnd.opengeni.editable-artifact-snapshot";
  coveredHeadSequence: 0;
  stateHash: string;
  modelSchemaVersion: number;
  kernelVersion: string;
}>;

export type ImportEditableArtifactSnapshot =
  | (ImportEditableArtifactSnapshotCommon &
      Readonly<{
        modality: "spreadsheet";
        coveredCausalFrontier: readonly Readonly<{ replicaId: string; counter: number }>[];
        operationProtocolVersion: number;
        crdtStateVersion: number;
      }>)
  | (ImportEditableArtifactSnapshotCommon &
      Readonly<{
        modality: "document" | "presentation";
        nativeRevision: number;
      }>);

export type ImportEditableArtifactResourceRequest = Readonly<{
  idempotencyKey: string;
  replicaId: string;
  modality: EditableArtifactModality;
  title: string;
  sourceFileId: string;
  snapshot: ImportEditableArtifactSnapshot;
}>;

export type ReadEditableArtifactResourceOptions = OpenGeniRequestOptions &
  Readonly<{
    /** Writer/read replica used to mint artifact-scoped authority. */
    replicaId: string;
  }>;

export type EditableArtifactMaterializationFormat =
  | "xlsx"
  | "pptx"
  | "docx"
  | "pdf"
  | "png"
  | "webp";

export type EditableArtifactPinnedVersionResource = Readonly<{
  id: string;
  artifactId: string;
  modality: EditableArtifactModality;
  snapshotId: string;
  headSequence: number;
  causalFrontier: readonly Readonly<{ replicaId: string; counter: number }>[] | null;
  nativeRevision: number | null;
  stateHash: string;
  name: string;
  pinned: true;
  createdAt: string;
  replayed: boolean;
}>;

export type PinEditableArtifactVersionRequest = Readonly<{
  replicaId: string;
  idempotencyKey: string;
  name: string;
}>;

export type EditableArtifactMaterializationResultResource = Readonly<{
  id: string;
  byteSize: number;
  contentHash: string;
  mimeType:
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/pdf"
    | "image/png"
    | "image/webp";
  verifiedAt: string;
  createdAt: string;
}>;

export type EditableArtifactMaterializationJobResource = Readonly<{
  id: string;
  artifactId: string;
  versionId: string;
  inputSnapshotId: string;
  targetHeadSequence: number;
  stateHash: string;
  format: EditableArtifactMaterializationFormat;
  state: "pending" | "running" | "succeeded" | "failed";
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: EditableArtifactMaterializationResultResource | null;
  replayed?: boolean;
}>;

export type CreateEditableArtifactMaterializationRequest = Readonly<{
  replicaId: string;
  idempotencyKey: string;
  versionId: string;
  format: EditableArtifactMaterializationFormat;
  options?: Readonly<Record<string, unknown>>;
}>;

export type ReadEditableArtifactMaterializationOptions = OpenGeniRequestOptions &
  Readonly<{ replicaId: string }>;
