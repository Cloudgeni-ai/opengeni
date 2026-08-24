/** Artifact-only API client entry; keeps unrelated SDK surfaces out of editor bundles. */
export { OpenGeniClient } from "./artifact-client";
export type {
  CreateEditableArtifactMaterializationRequest,
  CreateEditableArtifactResourceRequest,
  EditableArtifactListResource,
  EditableArtifactMaterializationFormat,
  EditableArtifactMaterializationJobResource,
  EditableArtifactMaterializationResultResource,
  EditableArtifactPinnedVersionResource,
  EditableArtifactResource,
  ListSessionEditableArtifactResourcesOptions,
  PinEditableArtifactVersionRequest,
  ReadEditableArtifactMaterializationOptions,
  ReadEditableArtifactResourceOptions,
} from "./editable-artifact-resources";
export type {
  FetchLike,
  FetchResponse,
  OpenGeniClientOptions,
  OpenGeniRequestOptions,
} from "./client";
