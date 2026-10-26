import type { OpenGeniClient as OpenGeniCoreClient } from "./client";
import type {
  AcceptAgentProfileProposalRequest,
  AgentProfile,
  AgentProfileProposal,
  AgentProfileProposalListResponse,
  AgentProfileProposalStatus,
  AgentProfileSessionListResponse,
  SetAgentProfileHomeRequest,
  AgentProfileListResponse,
  AgentProfileStatus,
  AgentProfileVersionListResponse,
  ApplySessionAgentProfileRequest,
  CreateAgentProfileRequest,
  Session,
  UpdateAgentProfileRequest,
  UpdateSessionAgentIdentityRequest,
} from "./types";

export type OpenGeniAgentProfilesTransport = Pick<OpenGeniCoreClient, "requestJson">;

/**
 * Reusable, workspace-shared agents and per-chat agent identity (agent
 * profiles flag; every route answers 404 when it is off). Isolated from the
 * eager core client graph. `sessions:read` gates reads; `sessions:create`
 * gates create / update / archive; `sessions:control` gates naming or
 * switching a chat's agent.
 */
export class OpenGeniAgentProfilesClient {
  constructor(private readonly client: OpenGeniAgentProfilesTransport) {}

  async listAgentProfiles(
    workspaceId: string,
    options: { status?: AgentProfileStatus | "all" } = {},
  ): Promise<AgentProfileListResponse> {
    return await this.client.requestJson<AgentProfileListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/agent-profiles`,
      undefined,
      options.status ? { status: options.status } : undefined,
    );
  }

  async getAgentProfile(workspaceId: string, profileId: string): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "GET",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}`,
    );
  }

  async listAgentProfileVersions(
    workspaceId: string,
    profileId: string,
  ): Promise<AgentProfileVersionListResponse> {
    return await this.client.requestJson<AgentProfileVersionListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/versions`,
    );
  }

  async createAgentProfile(
    workspaceId: string,
    request: CreateAgentProfileRequest,
  ): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "POST",
      `/v1/workspaces/${workspaceId}/agent-profiles`,
      request,
    );
  }

  async updateAgentProfile(
    workspaceId: string,
    profileId: string,
    request: UpdateAgentProfileRequest,
  ): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}`,
      request,
    );
  }

  async archiveAgentProfile(workspaceId: string, profileId: string): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "POST",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/archive`,
    );
  }

  async restoreAgentProfile(workspaceId: string, profileId: string): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "POST",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/restore`,
    );
  }

  /** Name only this chat's agent (null clears it). Display only. */
  async updateSessionAgentIdentity(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionAgentIdentityRequest,
  ): Promise<Session> {
    return await this.client.requestJson<Session>(
      "PUT",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/agent-identity`,
      request,
    );
  }

  /** Switch a chat to a saved agent profile, from its next message. */
  async applySessionAgentProfile(
    workspaceId: string,
    sessionId: string,
    request: ApplySessionAgentProfileRequest,
  ): Promise<Session> {
    return await this.client.requestJson<Session>(
      "PUT",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/agent-profile`,
      request,
    );
  }

  /** Chats that wear this agent and that the caller can see, newest first. */
  async listAgentProfileSessions(
    workspaceId: string,
    profileId: string,
  ): Promise<AgentProfileSessionListResponse> {
    return await this.client.requestJson<AgentProfileSessionListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/sessions`,
    );
  }

  /** Set (or clear, with null) the agent's home chat. The chat must wear the agent. */
  async setAgentProfileHome(
    workspaceId: string,
    profileId: string,
    request: SetAgentProfileHomeRequest,
  ): Promise<AgentProfile> {
    return await this.client.requestJson<AgentProfile>(
      "PUT",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/home`,
      request,
    );
  }

  /** Instruction updates proposed by the agent's chats (pending by default). */
  async listAgentProfileProposals(
    workspaceId: string,
    profileId: string,
    options: { status?: AgentProfileProposalStatus | "all"; sessionId?: string } = {},
  ): Promise<AgentProfileProposalListResponse> {
    return await this.client.requestJson<AgentProfileProposalListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/proposals`,
      undefined,
      {
        ...(options.status ? { status: options.status } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      },
    );
  }

  /** Accept a proposal as a new profile version (409 when the profile changed since review). */
  async acceptAgentProfileProposal(
    workspaceId: string,
    profileId: string,
    proposalId: string,
    request: AcceptAgentProfileProposalRequest,
  ): Promise<{ profile: AgentProfile; proposal: AgentProfileProposal }> {
    return await this.client.requestJson<{ profile: AgentProfile; proposal: AgentProfileProposal }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/proposals/${proposalId}/accept`,
      request,
    );
  }

  async dismissAgentProfileProposal(
    workspaceId: string,
    profileId: string,
    proposalId: string,
  ): Promise<AgentProfileProposal> {
    return await this.client.requestJson<AgentProfileProposal>(
      "POST",
      `/v1/workspaces/${workspaceId}/agent-profiles/${profileId}/proposals/${proposalId}/dismiss`,
    );
  }
}
