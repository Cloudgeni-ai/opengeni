import type { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  CreatePrReviewAppRegistrationRequest,
  CreatePrReviewRepositoryBindingRequest,
  PrReviewAppRegistration,
  PrReviewRepositoryBinding,
  ListPrReviewConfigurationResponse,
  PrReviewManagedGitHubSetup,
  UpdatePrReviewAppRegistrationRequest,
  UpdatePrReviewRepositoryBindingRequest,
} from "./types";

export type OpenGeniPrReviewTransport = Pick<OpenGeniCoreClient, "requestJson" | "requestVoid">;

/** Optional OpenGeni Review Bot API surface, isolated from the eager core client graph. */
export class OpenGeniPrReviewClient {
  constructor(private readonly client: OpenGeniPrReviewTransport) {}

  async listConfiguration(workspaceId: string): Promise<ListPrReviewConfigurationResponse> {
    return await this.client.requestJson<ListPrReviewConfigurationResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/pr-review/registrations`,
    );
  }

  async getManagedGitHubSetup(workspaceId: string): Promise<PrReviewManagedGitHubSetup> {
    return await this.client.requestJson<PrReviewManagedGitHubSetup>(
      "GET",
      `/v1/workspaces/${workspaceId}/pr-review/github`,
    );
  }

  async createAppRegistration(
    workspaceId: string,
    request: CreatePrReviewAppRegistrationRequest,
  ): Promise<PrReviewAppRegistration> {
    return await this.client.requestJson<PrReviewAppRegistration>(
      "POST",
      `/v1/workspaces/${workspaceId}/pr-review/registrations`,
      request,
    );
  }

  async updateAppRegistration(
    workspaceId: string,
    registrationId: string,
    request: UpdatePrReviewAppRegistrationRequest,
  ): Promise<PrReviewAppRegistration> {
    return await this.client.requestJson<PrReviewAppRegistration>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/pr-review/registrations/${encodeURIComponent(registrationId)}`,
      request,
    );
  }

  async deleteAppRegistration(workspaceId: string, registrationId: string): Promise<void> {
    await this.client.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/pr-review/registrations/${encodeURIComponent(registrationId)}`,
    );
  }

  async createRepositoryBinding(
    workspaceId: string,
    request: CreatePrReviewRepositoryBindingRequest,
  ): Promise<PrReviewRepositoryBinding> {
    return await this.client.requestJson<PrReviewRepositoryBinding>(
      "POST",
      `/v1/workspaces/${workspaceId}/pr-review/repositories`,
      request,
    );
  }

  async updateRepositoryBinding(
    workspaceId: string,
    bindingId: string,
    request: UpdatePrReviewRepositoryBindingRequest,
  ): Promise<PrReviewRepositoryBinding> {
    return await this.client.requestJson<PrReviewRepositoryBinding>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/pr-review/repositories/${encodeURIComponent(bindingId)}`,
      request,
    );
  }

  async deleteRepositoryBinding(workspaceId: string, bindingId: string): Promise<void> {
    await this.client.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/pr-review/repositories/${encodeURIComponent(bindingId)}`,
    );
  }
}
