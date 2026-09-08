import { OpenGeniDocumentAuthorityClient } from "./document-authority-client";
import type { FetchResponse } from "./client";
import type {
  CreateEditableArtifactMaterializationRequest,
  CreateEditableArtifactResourceRequest,
  EditableArtifactListResource,
  EditableArtifactMaterializationJobResource,
  EditableArtifactPinnedVersionResource,
  EditableArtifactResource,
  ImportEditableArtifactResourceRequest,
  ListSessionEditableArtifactResourcesOptions,
  PinEditableArtifactVersionRequest,
  ReadEditableArtifactMaterializationOptions,
  ReadEditableArtifactResourceOptions,
} from "./editable-artifact-resources";

/** Public SDK client. Optional operator and artifact operations stay out of the console core. */
export class OpenGeniClient extends OpenGeniDocumentAuthorityClient {
  async createEditableArtifact(
    workspaceId: string,
    request: CreateEditableArtifactResourceRequest,
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<EditableArtifactResource> {
    return await this.requestJson<EditableArtifactResource>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts`,
      request,
      {},
      options,
    );
  }

  async importEditableArtifact(
    workspaceId: string,
    request: ImportEditableArtifactResourceRequest,
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<EditableArtifactResource> {
    return await this.requestJson<EditableArtifactResource>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/imports`,
      request,
      {},
      options,
    );
  }

  async getEditableArtifact(
    workspaceId: string,
    artifactId: string,
    options: ReadEditableArtifactResourceOptions,
  ): Promise<EditableArtifactResource> {
    return await this.requestJson<EditableArtifactResource>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      { replicaId: options.replicaId },
      options,
    );
  }

  async listSessionEditableArtifacts(
    workspaceId: string,
    sourceSessionId: string,
    options: ListSessionEditableArtifactResourcesOptions,
  ): Promise<EditableArtifactListResource> {
    return await this.requestJson<EditableArtifactListResource>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts`,
      undefined,
      { sourceSessionId, replicaId: options.replicaId },
      options,
    );
  }

  async pinEditableArtifactVersion(
    workspaceId: string,
    artifactId: string,
    request: PinEditableArtifactVersionRequest,
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<EditableArtifactPinnedVersionResource> {
    return await this.requestJson<EditableArtifactPinnedVersionResource>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/versions`,
      request,
      {},
      options,
    );
  }

  async createEditableArtifactMaterialization(
    workspaceId: string,
    artifactId: string,
    request: CreateEditableArtifactMaterializationRequest,
    options: Readonly<{ signal?: AbortSignal | undefined }> = {},
  ): Promise<EditableArtifactMaterializationJobResource> {
    return await this.requestJson<EditableArtifactMaterializationJobResource>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/materializations`,
      request,
      {},
      options,
    );
  }

  async getEditableArtifactMaterialization(
    workspaceId: string,
    artifactId: string,
    jobId: string,
    options: ReadEditableArtifactMaterializationOptions,
  ): Promise<EditableArtifactMaterializationJobResource> {
    return await this.requestJson<EditableArtifactMaterializationJobResource>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/materializations/${encodeURIComponent(jobId)}`,
      undefined,
      { replicaId: options.replicaId },
      options,
    );
  }

  /** The caller owns the returned bounded response stream. */
  async downloadEditableArtifactMaterialization(
    workspaceId: string,
    artifactId: string,
    jobId: string,
    options: ReadEditableArtifactMaterializationOptions,
  ): Promise<FetchResponse> {
    return await this.requestResponse(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/materializations/${encodeURIComponent(jobId)}/download`,
      { replicaId: options.replicaId },
      options,
    );
  }
}
