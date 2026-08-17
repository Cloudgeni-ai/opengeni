import type { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  CreateLensAppRegistrationRequest,
  CreateLensRepositoryBindingRequest,
  LensAppRegistration,
  LensRepositoryBinding,
  ListLensConfigurationResponse,
  UpdateLensAppRegistrationRequest,
  UpdateLensRepositoryBindingRequest,
} from "./types";

export type OpenGeniLensTransport = Pick<OpenGeniCoreClient, "requestJson" | "requestVoid">;

/** Optional OpenGeni Lens API surface, isolated from the eager core client graph. */
export class OpenGeniLensClient {
  constructor(private readonly client: OpenGeniLensTransport) {}

  async listConfiguration(workspaceId: string): Promise<ListLensConfigurationResponse> {
    return await this.client.requestJson<ListLensConfigurationResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/lens/registrations`,
    );
  }

  async createAppRegistration(
    workspaceId: string,
    request: CreateLensAppRegistrationRequest,
  ): Promise<LensAppRegistration> {
    return await this.client.requestJson<LensAppRegistration>(
      "POST",
      `/v1/workspaces/${workspaceId}/lens/registrations`,
      request,
    );
  }

  async updateAppRegistration(
    workspaceId: string,
    registrationId: string,
    request: UpdateLensAppRegistrationRequest,
  ): Promise<LensAppRegistration> {
    return await this.client.requestJson<LensAppRegistration>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/lens/registrations/${encodeURIComponent(registrationId)}`,
      request,
    );
  }

  async deleteAppRegistration(workspaceId: string, registrationId: string): Promise<void> {
    await this.client.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/lens/registrations/${encodeURIComponent(registrationId)}`,
    );
  }

  async createRepositoryBinding(
    workspaceId: string,
    request: CreateLensRepositoryBindingRequest,
  ): Promise<LensRepositoryBinding> {
    return await this.client.requestJson<LensRepositoryBinding>(
      "POST",
      `/v1/workspaces/${workspaceId}/lens/repositories`,
      request,
    );
  }

  async updateRepositoryBinding(
    workspaceId: string,
    bindingId: string,
    request: UpdateLensRepositoryBindingRequest,
  ): Promise<LensRepositoryBinding> {
    return await this.client.requestJson<LensRepositoryBinding>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/lens/repositories/${encodeURIComponent(bindingId)}`,
      request,
    );
  }

  async deleteRepositoryBinding(workspaceId: string, bindingId: string): Promise<void> {
    await this.client.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/lens/repositories/${encodeURIComponent(bindingId)}`,
    );
  }
}
