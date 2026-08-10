/** Artifact-only API client entry; keeps unrelated SDK surfaces out of editor bundles. */
export { OpenGeniClient } from "./artifact-client";
export type {
  CreateEditableArtifactMaterializationRequest,
  CreateEditableArtifactResourceRequest,
  EditableArtifactMaterializationFormat,
  EditableArtifactMaterializationJobResource,
  EditableArtifactMaterializationResultResource,
  EditableArtifactPinnedVersionResource,
  EditableArtifactResource,
  PinEditableArtifactVersionRequest,
  ReadEditableArtifactMaterializationOptions,
  ReadEditableArtifactResourceOptions,
} from "./editable-artifact-resources";
export type { FetchLike, OpenGeniClientOptions, OpenGeniRequestOptions } from "./client";
