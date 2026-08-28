import { OpenGeniDocumentAuthorityClient } from "./document-authority-client";
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
import type {
  CreateWorkspaceArtifactRequest,
  PublishWorkspaceArtifactVersionRequest,
  RollbackWorkspaceArtifactRequest,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListOptions,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
} from "./workspace-artifacts";
import type {
  ArchiveSiteRequest,
  CreateSiteRuntimeSessionRequest,
  PublishSiteRequest,
  RollbackSiteRequest,
  SendSiteRuntimeMessageRequest,
  SiteDetailResponse,
  SiteListResponse,
  SiteMutationResponse,
  SiteRuntimeSessionReceipt,
  SiteUsageResponse,
} from "./sites";

/** Public SDK client. Optional operator and artifact operations stay out of the console core. */
export class OpenGeniClient extends OpenGeniDocumentAuthorityClient {
  async listSites(workspaceId: string): Promise<SiteListResponse> {
    return await this.requestJson("GET", `/v1/workspaces/${workspaceId}/sites`);
  }

  async getSite(workspaceId: string, siteId: string): Promise<SiteDetailResponse> {
    return await this.requestJson(
      "GET",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}`,
    );
  }

  async publishSite(
    workspaceId: string,
    siteId: string,
    request: PublishSiteRequest,
  ): Promise<SiteMutationResponse> {
    return await this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/releases`,
      request,
    );
  }

  async rollbackSite(
    workspaceId: string,
    siteId: string,
    request: RollbackSiteRequest,
  ): Promise<SiteMutationResponse> {
    return await this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/rollback`,
      request,
    );
  }

  async archiveSite(
    workspaceId: string,
    siteId: string,
    request: ArchiveSiteRequest,
  ): Promise<SiteDetailResponse> {
    return await this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/archive`,
      request,
    );
  }

  async getSiteUsage(workspaceId: string, siteId: string): Promise<SiteUsageResponse> {
    return await this.requestJson(
      "GET",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/usage`,
    );
  }

  async createSiteRuntimeSession(
    workspaceId: string,
    siteId: string,
    request: CreateSiteRuntimeSessionRequest,
  ): Promise<SiteRuntimeSessionReceipt> {
    return await this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/runtime/sessions`,
      request,
    );
  }

  async sendSiteRuntimeMessage(
    workspaceId: string,
    siteId: string,
    runtimeSessionId: string,
    request: SendSiteRuntimeMessageRequest,
  ): Promise<unknown> {
    return await this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sites/${encodeURIComponent(siteId)}/runtime/sessions/${encodeURIComponent(runtimeSessionId)}/messages`,
      request,
    );
  }

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
  ): Promise<Response> {
    return await this.requestResponse(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/editable-artifacts/${encodeURIComponent(artifactId)}/materializations/${encodeURIComponent(jobId)}/download`,
      { replicaId: options.replicaId },
      options,
    );
  }

  async listWorkspaceArtifacts(
    workspaceId: string,
    options: WorkspaceArtifactListOptions = {},
  ): Promise<WorkspaceArtifactListResponse> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return await this.requestJson<WorkspaceArtifactListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/published-artifacts${suffix}`,
    );
  }

  async getWorkspaceArtifact(
    workspaceId: string,
    artifactId: string,
  ): Promise<WorkspaceArtifactDetailResponse> {
    return await this.requestJson<WorkspaceArtifactDetailResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}`,
    );
  }

  async getWorkspaceArtifactContent(
    workspaceId: string,
    artifactId: string,
    versionId?: string,
  ): Promise<WorkspaceArtifactContentResponse> {
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    return await this.requestJson<WorkspaceArtifactContentResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}/content${query}`,
    );
  }

  async createWorkspaceArtifact(
    workspaceId: string,
    request: CreateWorkspaceArtifactRequest,
  ): Promise<WorkspaceArtifactMutationResponse> {
    return await this.requestJson<WorkspaceArtifactMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/published-artifacts`,
      request,
    );
  }

  async publishWorkspaceArtifactVersion(
    workspaceId: string,
    artifactId: string,
    request: PublishWorkspaceArtifactVersionRequest,
  ): Promise<WorkspaceArtifactMutationResponse> {
    return await this.requestJson<WorkspaceArtifactMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}/versions`,
      request,
    );
  }

  async rollbackWorkspaceArtifact(
    workspaceId: string,
    artifactId: string,
    request: RollbackWorkspaceArtifactRequest,
  ): Promise<WorkspaceArtifactMutationResponse> {
    return await this.requestJson<WorkspaceArtifactMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/published-artifacts/${encodeURIComponent(artifactId)}/rollback`,
      request,
    );
  }
}
