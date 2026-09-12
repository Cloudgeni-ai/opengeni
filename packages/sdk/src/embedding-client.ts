import { OpenGeniClient as OpenGeniArtifactClient } from "./artifact-client";
import type { OpenGeniClientOptions, OpenGeniRequestOptions } from "./client";
import type { AddWorkspaceMemberRequest } from "./types";
import type {
  ExternalIdentityLink,
  BeginExternalIdentityLinkRequest,
  BeginExternalIdentityLinkResponse,
  ConfirmExternalIdentityLinkRequest,
  ExternalIdentityLinkPreview,
  ExternalIdentityLinkPage,
} from "@opengeni/contracts/external-identities";

/** Public product embedding administration, kept out of the native browser client. */
export class OpenGeniEmbeddingClient extends OpenGeniArtifactClient {
  /** Rotate existing inline credentials only while no credential-consuming work
   * is pending or active. Reuse the operation key and exact request to reconcile
   * a lost response. This operation never schedules or retries model work. */
  async rotateSessionMcpCredentials(
    workspaceId: string,
    sessionId: string,
    request: import("./types").RotateSessionMcpCredentialsRequest,
  ): Promise<import("./types").RotateSessionMcpCredentialsReceipt> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/mcp-credentials/rotate`,
      request,
    );
  }

  /** Server-side organization-key client scoped to one host-authenticated user.
   * Does not mutate this client, provision workspace membership, or link native
   * identities. The API verifies key and membership authority on each request. */
  asUser(externalId: string, options: { source?: string } = {}): this {
    if (typeof window !== "undefined")
      throw new Error("asUser is a server-side API; keep organization keys on your backend");
    const source = options.source ?? "default";
    const validOpaqueText = (value: unknown, maxBytes: number): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxBytes &&
      !value.includes("\0") &&
      !/[\uD800-\uDFFF]/u.test(value) &&
      new TextEncoder().encode(value).byteLength <= maxBytes;
    if (!validOpaqueText(externalId, 1024) || !validOpaqueText(source, 200)) {
      throw new Error("Invalid external identity reference");
    }
    const Client = this.constructor as new (options: OpenGeniClientOptions) => this;
    const client = new Client({ ...this.options });
    client.externalActorHeader = encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId, source } }),
    );
    return client;
  }

  /** Explicitly use a confirmed native delegation. Unlike asUser, new resources
   * belong to the native user. Existing external resources are never reassigned.
   * A stale, expired or revoked link is rejected by the server on every request. */
  asLinkedUser(
    externalId: string,
    options: { source?: string; linkId: string; expectedLinkRevision: number },
  ): this {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.linkId) ||
      !Number.isSafeInteger(options.expectedLinkRevision) ||
      options.expectedLinkRevision < 1
    )
      throw new Error("A confirmed identity link and its exact revision are required");
    const client = this.asUser(
      externalId,
      options.source === undefined ? {} : { source: options.source },
    );
    const identity = JSON.parse(decodeURIComponent(client.externalActorHeader!)).identity;
    client.externalActorHeader = encodeURIComponent(
      JSON.stringify({
        mode: "linked_native",
        identity,
        linkId: options.linkId,
        expectedLinkRevision: options.expectedLinkRevision,
      }),
    );
    return client;
  }

  /** Optional native-account delegation. Invoke on a server-side asUser client.
   * Pass the one-time challenge to the native consent screen, never a URL query
   * or analytics event. Ordinary external embedding needs none of this. */
  async beginIdentityLink(
    workspaceId: string,
    input: BeginExternalIdentityLinkRequest,
  ): Promise<BeginExternalIdentityLinkResponse> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links`,
      input,
    );
  }

  async getIdentityLink(workspaceId: string, linkId: string): Promise<ExternalIdentityLink> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links/${encodeURIComponent(linkId)}`,
    );
  }

  /** Only links belonging to the effective participant; no organization-wide directory. */
  async listIdentityLinks(workspaceId: string, cursor?: string): Promise<ExternalIdentityLinkPage> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
  }

  /** Requires a canonical native browser session, not an organization API key. */
  async previewIdentityLink(
    workspaceId: string,
    linkId: string,
    challenge: string,
  ): Promise<ExternalIdentityLinkPreview> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links/${encodeURIComponent(linkId)}/preview`,
      { challenge },
    );
  }

  async confirmIdentityLink(
    workspaceId: string,
    linkId: string,
    input: ConfirmExternalIdentityLinkRequest,
  ): Promise<ExternalIdentityLink> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links/${encodeURIComponent(linkId)}/confirm`,
      input,
    );
  }

  async revokeIdentityLink(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<ExternalIdentityLink> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links/${encodeURIComponent(linkId)}/revoke`,
      { expectedRevision },
    );
  }

  /** Service-only lifecycle for an external actor's organization membership.
   * A successful reactivation does not restore revoked workspace grants. */
  async updateExternalIdentityMembership(
    organizationId: string,
    membershipId: string,
    request: import("@opengeni/contracts/external-identities").UpdateExternalIdentityMembershipRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<import("@opengeni/contracts").OrganizationMember> {
    return this.requestJson(
      "PATCH",
      `/v1/organizations/${encodeURIComponent(organizationId)}/external-members/${encodeURIComponent(membershipId)}`,
      request,
      undefined,
      options,
    );
  }

  /** Non-provisioning, content-free service lookup, including inactive identities. */
  async lookupExternalIdentity(
    organizationId: string,
    identity: import("@opengeni/contracts/external-identities").ExternalIdentityReference,
  ): Promise<import("@opengeni/contracts/external-identities").ExternalIdentityLookup> {
    return this.requestJson(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/external-identities/lookup`,
      identity,
    );
  }

  /** Withdraw an external member's shared-workspace access and fence an exact
   * pending keyed grant. Reuse the exact cancellation body after response loss. */
  async cancelExternalWorkspaceMemberGrant(
    organizationId: string,
    workspaceId: string,
    membershipId: string,
    request: import("@opengeni/contracts/external-identities").CancelExternalWorkspaceMemberGrantRequest,
  ): Promise<
    import("@opengeni/contracts/external-identities").CancelExternalWorkspaceMemberGrantResponse
  > {
    return this.requestJson(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}/revoke`,
      request,
    );
  }

  async listConnectProviders(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/connect").ConnectProvider[]> {
    return this.requestJson("GET", `/v1/workspaces/${workspaceId}/connect/catalog`);
  }

  /** Register credential-free, external-owner host authority. Does not itself
   * authorize an execution or install MCP tools. */
  async createHostMcpBinding(
    workspaceId: string,
    request: import("@opengeni/contracts/host-mcp-bindings").CreateHostMcpBindingRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpBinding> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-bindings`,
      request,
      {},
      options,
    );
  }

  async getHostMcpBinding(
    workspaceId: string,
    bindingId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpBinding> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-bindings/${encodeURIComponent(bindingId)}`,
      undefined,
      {},
      options,
    );
  }

  async revokeHostMcpBinding(
    workspaceId: string,
    bindingId: string,
    request: { expectedGeneration: number },
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpBinding> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-bindings/${encodeURIComponent(bindingId)}/revoke`,
      request,
      {},
      options,
    );
  }

  /** Issue owner-scoped grant metadata; accepted execution must separately admit it. */
  async issueHostMcpDelegation(
    workspaceId: string,
    request: import("@opengeni/contracts/host-mcp-bindings").IssueHostMcpDelegationRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpDelegation> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-delegations`,
      request,
      {},
      options,
    );
  }

  async getHostMcpDelegation(
    workspaceId: string,
    delegationId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpDelegation> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-delegations/${encodeURIComponent(delegationId)}`,
      undefined,
      {},
      options,
    );
  }

  async revokeHostMcpDelegation(
    workspaceId: string,
    delegationId: string,
    request: { expectedGeneration: number },
    options: OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/host-mcp-bindings").HostMcpDelegation> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/host-mcp-delegations/${encodeURIComponent(delegationId)}/revoke`,
      request,
      {},
      options,
    );
  }

  async listConnectAccounts(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/connect").ConnectAccount[]> {
    return this.requestJson("GET", `/v1/workspaces/${workspaceId}/connect/accounts`);
  }

  async getConnectAttempt(
    workspaceId: string,
    attemptId: string,
  ): Promise<import("@opengeni/contracts/connect").ConnectAttempt> {
    return this.requestJson("GET", `/v1/workspaces/${workspaceId}/connect/attempts/${attemptId}`);
  }

  async listPendingConnectAttempts(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/connect").ConnectAttempt[]> {
    return this.requestJson("GET", `/v1/workspaces/${workspaceId}/connect/attempts`);
  }

  async advanceConnectAttempt(
    workspaceId: string,
    attemptId: string,
    request: {
      expectedRevision: number;
      idempotencyKey: string;
      action: import("@opengeni/contracts/connect").ConnectAdvance;
    },
  ): Promise<import("@opengeni/contracts/connect").ConnectAttempt> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/connect/attempts/${attemptId}/advance`,
      request,
    );
  }

  /** Stops setup; does not revoke already committed provider credentials. */
  async cancelConnectAttempt(
    workspaceId: string,
    attemptId: string,
    request: {
      expectedRevision: number;
      idempotencyKey: string;
    },
  ): Promise<import("@opengeni/contracts/connect").ConnectAttempt> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${workspaceId}/connect/attempts/${attemptId}/cancel`,
      request,
    );
  }

  /** Explicit organization-service-key onboarding; asUser never grants membership. */
  async addExternalWorkspaceMember(
    workspaceId: string,
    request: {
      identity: { externalId: string; source?: string };
      permissions: AddWorkspaceMemberRequest["permissions"];
      operationId?: string;
    },
  ): Promise<import("@opengeni/contracts/external-identities").ExternalIdentity> {
    return this.requestJson("POST", `/v1/workspaces/${workspaceId}/external-members`, request);
  }
}
