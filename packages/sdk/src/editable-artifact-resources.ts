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
  /**
   * Who can open it: everyone in the workspace, or only its owner ("Only
   * me"). Absent on older servers, which share every artifact.
   */
  visibility?: "private" | "workspace";
  /** The signed-in viewer owns it, so they can share or limit it. */
  ownedByViewer?: boolean;
}>;

export type EditableArtifactListResource = Readonly<{
  artifacts: readonly EditableArtifactResource[];
}>;

export type CreateEditableArtifactResourceRequest = Readonly<{
  /** Stable across transport retries; conflicting reuse is rejected. */
  idempotencyKey: string;
  /** Exact writer replica that will open the first live editing session. */
  replicaId: string;
  modality: EditableArtifactModality;
  title: string;
  /** Who can open it. Without one, it is shared with the workspace. */
  visibility?: "private" | "workspace";
}>;

export type ImportEditableArtifactResourceRequest = Readonly<{
  idempotencyKey: string;
  replicaId: string;
  modality: EditableArtifactModality;
  title: string;
  sourceFileId: string;
  /** Who can open it. Without one, it follows the file: an Only me file stays Only me. */
  visibility?: "private" | "workspace";
}>;

export type UpdateEditableArtifactVisibilityRequest = Readonly<{
  visibility: "private" | "workspace";
}>;

export type ReadEditableArtifactResourceOptions = OpenGeniRequestOptions &
  Readonly<{
    /** Writer/read replica used to mint artifact-scoped authority. */
    replicaId: string;
  }>;

export type ListSessionEditableArtifactResourcesOptions = OpenGeniRequestOptions &
  Readonly<{
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
