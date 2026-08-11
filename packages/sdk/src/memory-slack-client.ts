import type { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  MemorySlackPublication,
  MemorySlackPublicationActionRequest,
  MemorySlackPublicationConfiguration,
  MemorySlackPublicationConfigurationResponse,
  MemorySlackPublicationHistoryResponse,
  SlackPublicationChannelListResponse,
  UpdateMemorySlackPublicationConfigurationRequest,
} from "./memory-slack-delivery";

export type OpenGeniMemorySlackTransport = Pick<OpenGeniCoreClient, "requestJson">;

/** Optional Memory-to-Slack API surface, isolated from the eager core client graph. */
export class OpenGeniMemorySlackClient {
  constructor(private readonly client: OpenGeniMemorySlackTransport) {}

  async getMemorySlackPublicationConfiguration(
    workspaceId: string,
  ): Promise<MemorySlackPublicationConfigurationResponse> {
    return await this.client.requestJson<MemorySlackPublicationConfigurationResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/memory-slack-publications/configuration`,
    );
  }

  async updateMemorySlackPublicationConfiguration(
    workspaceId: string,
    request: UpdateMemorySlackPublicationConfigurationRequest,
  ): Promise<MemorySlackPublicationConfiguration> {
    return await this.client.requestJson<MemorySlackPublicationConfiguration>(
      "PUT",
      `/v1/workspaces/${workspaceId}/memory-slack-publications/configuration`,
      request,
    );
  }

  async listMemorySlackPublicationChannels(
    workspaceId: string,
    connectionId: string,
    cursor?: string,
  ): Promise<SlackPublicationChannelListResponse> {
    const query = new URLSearchParams({ connectionId });
    if (cursor) query.set("cursor", cursor);
    return await this.client.requestJson<SlackPublicationChannelListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/memory-slack-publications/channels?${query}`,
    );
  }

  async listMemorySlackPublications(
    workspaceId: string,
  ): Promise<MemorySlackPublicationHistoryResponse> {
    return await this.client.requestJson<MemorySlackPublicationHistoryResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/memory-slack-publications`,
    );
  }

  async actOnMemorySlackPublication(
    workspaceId: string,
    publicationId: string,
    request: MemorySlackPublicationActionRequest,
  ): Promise<MemorySlackPublication> {
    return await this.client.requestJson<MemorySlackPublication>(
      "POST",
      `/v1/workspaces/${workspaceId}/memory-slack-publications/${encodeURIComponent(publicationId)}/action`,
      request,
    );
  }
}
