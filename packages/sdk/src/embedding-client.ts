import { OpenGeniClient as OpenGeniArtifactClient } from "./artifact-client";
import type { OpenGeniClientOptions } from "./client";
import type { AddWorkspaceMemberRequest, ApiKey, UpdateOrganizationApiKeyRequest } from "./types";
import type {
  ExternalIdentityLink,
  BeginExternalIdentityLinkRequest,
  BeginExternalIdentityLinkResponse,
  ConfirmExternalIdentityLinkRequest,
  ExternalIdentityLinkPreview,
  ExternalIdentityLinkPage,
} from "@opengeni/contracts/external-identities";

/** Non-secret service attribution, serialized as a flat JSON object of at most 2 KiB. */
export type ServiceContext = Record<string, string | number | boolean>;

function hasStaticHeader(options: OpenGeniClientOptions, names: string[]): boolean {
  return (
    typeof options.headers !== "function" &&
    Object.keys(options.headers ?? {}).some((key) => names.includes(key.toLowerCase()))
  );
}

function serializeServiceContext(context: ServiceContext): string {
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    (Object.getPrototypeOf(context) !== Object.prototype && Object.getPrototypeOf(context) !== null)
  )
    throw new Error("Invalid service context: expected a flat JSON object");
  const snapshot: ServiceContext = Object.create(null);
  for (const [key, value] of Object.entries(context)) {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      throw new Error(
        "Invalid service context: values must be strings, finite numbers, or booleans",
      );
    snapshot[key] = value;
  }
  // HTTP Headers require byte strings. JSON escapes preserve Unicode without
  // percent-encoding the object or passing non-byte characters to fetch.
  const json = JSON.stringify(snapshot).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (new TextEncoder().encode(json).byteLength > 2048)
    throw new Error("Invalid service context: serialized JSON must not exceed 2 KiB");
  return json;
}

/** Public product embedding administration, kept out of the native browser client. */
export class OpenGeniEmbeddingClient extends OpenGeniArtifactClient {
  /** Read organization-key metadata and policy; never returns the secret token. */
  async getOrganizationApiKey(organizationId: string, apiKeyId: string): Promise<ApiKey> {
    return await this.requestJson<ApiKey>(
      "GET",
      `/v1/organizations/${organizationId}/api-keys/${apiKeyId}`,
    );
  }

  /** Update metadata or replace the policy. Policy narrowing applies on the next request. */
  async updateOrganizationApiKey(
    organizationId: string,
    apiKeyId: string,
    request: UpdateOrganizationApiKeyRequest,
  ): Promise<ApiKey> {
    return await this.requestJson<ApiKey>(
      "PATCH",
      `/v1/organizations/${organizationId}/api-keys/${apiKeyId}`,
      request,
    );
  }

  /** Read configuration (null means no configured ceiling). Requires admin or organization-key read authority. */
  async getWorkspaceAllowance(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceAllowance | null> {
    return this.requestJson("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}/allowance`);
  }

  /**
   * Read the lifecycle version even after clear (config=null). version=0 means
   * never configured. Use the returned version to recreate or reconcile a 409;
   * do not guess a CAS version or silently retry a new mutation.
   * Requires the same budget-read authority as getWorkspaceAllowance.
   */
  async getWorkspaceAllowanceState(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceAllowanceState> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/allowance/state`,
    );
  }

  /**
   * Set a USD-micro ceiling with exact-version CAS (0 only for first creation;
   * after clear reuse its returned version or getWorkspaceAllowanceState). Requires
   * organization key-control authority or account:admin, never workspace admin
   * alone. Shares may oversubscribe the pool; actual post-call settlement can
   * overshoot before the next admission check.
   */
  async setWorkspaceAllowance(
    workspaceId: string,
    request: import("@opengeni/contracts/usage-allowances").SetWorkspaceAllowanceRequest,
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceAllowance> {
    return this.requestJson(
      "PUT",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/allowance`,
      request,
    );
  }

  /**
   * Clear with the exact version; grants and settled usage are not a billing
   * refund. Supply operationId and replay the exact request after a lost response.
   * Replays recheck authority and conflict after a later lifecycle change.
   * On 409 read getWorkspaceAllowanceState before deciding on a new operation.
   */
  async clearWorkspaceAllowance(
    workspaceId: string,
    request: import("@opengeni/contracts/usage-allowances").ClearWorkspaceAllowanceRequest,
  ): Promise<import("@opengeni/contracts/usage-allowances").ClearWorkspaceAllowanceResponse> {
    return this.requestJson(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/allowance`,
      request,
    );
  }

  /** Grant USD micros once. Reuse the operationId and exact request after an uncertain response. */
  async grantWorkspaceCredits(
    workspaceId: string,
    request: import("@opengeni/contracts/usage-allowances").GrantWorkspaceCreditsRequest,
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceCreditGrant> {
    return this.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/allowance/grants`,
      request,
    );
  }

  /**
   * Administer an existing member by canonical subject or external identity.
   * null restores memberDefault; shares >1 are valid ceilings, not reservations.
   * Concurrent calls may exceed the ceiling until their actual cost settles.
   */
  async setMemberAllowance(
    workspaceId: string,
    member: string | { source: string; externalId: string },
    request: import("@opengeni/contracts/usage-allowances").SetMemberAllowanceRequest,
  ): Promise<import("@opengeni/contracts/usage-allowances").MemberAllowance> {
    const path =
      typeof member === "string"
        ? encodeURIComponent(member)
        : `external/${encodeURIComponent(member.source)}/${encodeURIComponent(member.externalId)}`;
    return this.requestJson(
      "PUT",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${path}/allowance`,
      request,
    );
  }

  /** Paginated settled usage, current or YYYY-MM. Requires admin or organization-key read authority. */
  async getUsage(
    workspaceId: string,
    query: import("@opengeni/contracts/usage-allowances").GetUsageRequest = {},
    options: import("./client").OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceUsageResponse> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage`,
      undefined,
      usageQuery(query),
      options,
    );
  }

  /** Own usage only. On your backend use asUser(authenticatedUser); subject selectors are not accepted. */
  async getMyUsage(
    workspaceId: string,
    query: import("@opengeni/contracts/usage-allowances").GetMyUsageRequest = {},
    options: import("./client").OpenGeniRequestOptions = {},
  ): Promise<import("@opengeni/contracts/usage-allowances").WorkspaceUsageResponse> {
    return this.requestJson(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/usage/me`,
      undefined,
      usageQuery(query),
      options,
    );
  }

  /** Recover this actor's connection creation result without resending secrets.
   * A 404 means no visible committed result, not proof that an in-flight write failed. */
  async getConnectionCreationResult(
    workspaceId: string,
    operationId: string,
  ): Promise<import("./types").ConnectionMetadata> {
    const response = await this.requestJson<import("./types").ConnectionResponse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/operations/${encodeURIComponent(operationId)}`,
    );
    return response.connection;
  }

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

  /** Contract-checked successful JSON GET with its headers intact, for same-origin
   * proxies that must forward paging metadata. Non-2xx responses throw. */
  async requestJsonResponse(
    path: string,
    query: Record<string, string> = {},
    options: import("./client").OpenGeniRequestOptions = {},
  ): Promise<import("./client").FetchResponse> {
    return await this.requestResponse("GET", path, query, {
      ...options,
      accept: "application/json",
    });
  }

  /** Server-side organization-key client scoped to one host-authenticated user.
   * Does not mutate this client, provision workspace membership, or link native
   * identities. The API verifies key and membership authority on each request. */
  asUser(externalId: string, options: { source?: string } = {}): this {
    if (typeof window !== "undefined")
      throw new Error("asUser is a server-side API; keep organization keys on your backend");
    if (
      this.serviceInitiatorHeader !== undefined ||
      hasStaticHeader(this.options, ["x-opengeni-service-initiator", "x-opengeni-service-context"])
    )
      throw new Error(
        "asUser and asService are mutually exclusive; start from the unscoped client",
      );
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

  /** Server-side automation attribution under this client's existing credential.
   * Returns a new client of the same class; grants no permissions or human/personal
   * resource authority. Cannot be combined with asUser or asLinkedUser.
   * Reapplying asService replaces the name and context rather than merging them. */
  asService(name: string, context?: ServiceContext): this {
    if (typeof window !== "undefined")
      throw new Error("asService is a server-side API; keep API keys on your backend");
    if (
      this.externalActorHeader !== undefined ||
      hasStaticHeader(this.options, ["x-opengeni-external-actor"])
    )
      throw new Error(
        "asUser and asService are mutually exclusive; start from the unscoped client",
      );
    if (
      typeof name !== "string" ||
      !/^[a-z0-9][a-z0-9:._-]{0,63}$/.test(name) ||
      name.trim() !== name
    )
      throw new Error("Invalid service initiator name");
    const serializedContext = context === undefined ? undefined : serializeServiceContext(context);
    const Client = this.constructor as new (options: OpenGeniClientOptions) => this;
    const client = new Client({ ...this.options });
    client.serviceInitiatorHeader = name;
    client.serviceContextHeader = serializedContext;
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

  /** Replace an existing external member's permissions in one shared
   * workspace. Keyed by `operationId`: reuse the exact body after response
   * loss. Narrowing makes live authority re-check; nothing is cancelled. */
  async updateExternalWorkspaceMember(
    organizationId: string,
    workspaceId: string,
    membershipId: string,
    request: import("@opengeni/contracts/external-identities").UpdateExternalWorkspaceMemberRequest,
  ): Promise<
    import("@opengeni/contracts/external-identities").UpdateExternalWorkspaceMemberResponse
  > {
    return this.requestJson(
      "PATCH",
      `/v1/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/external-members/${encodeURIComponent(membershipId)}`,
      request,
    );
  }

  async listConnectProviders(
    workspaceId: string,
  ): Promise<import("@opengeni/contracts/connect").ConnectProvider[]> {
    return this.requestJson("GET", `/v1/workspaces/${workspaceId}/connect/catalog`);
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

function usageQuery(
  query: import("@opengeni/contracts/usage-allowances").GetUsageRequest,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}
