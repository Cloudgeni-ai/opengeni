import { OpenGeniClient as OpenGeniCoreClient } from "./client";
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

/** Public SDK client. Artifact operations stay out of the console's eager core graph. */
export class OpenGeniClient extends OpenGeniCoreClient {
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
