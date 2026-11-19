import type {
  ApplyOrgAgentRequest,
  ApplyOrgAgentResponse,
  CreateOrgAgentRequest,
  CreateOrgToolServerRequest,
  EndUserToolCredential,
  ListOrgAgentComputeResponse,
  ListOrgAgentSessionsResponse,
  ListOrgAgentsResponse,
  ListOrgAgentPublishOperationsResponse,
  ListOrgAgentVersionsResponse,
  ListOrgToolServersResponse,
  OrgAgent,
  OrgAgentDefinitionInput,
  OrgAgentFileInput,
  OrgAgentComputeOption,
  OrgAgentPublishOperation,
  OrgAgentResponse,
  OrgAgentRunsOn,
  OrgAgentUsageResponse,
  OrgAgentVersion,
  OrgToolServer,
  OrgToolServerToolsResponse,
  PublishOrgAgentRequest,
  PublishOrgAgentResponse,
  PutEndUserToolCredentialRequest,
  SaveOrgAgentDraftRequest,
  SetOrgAgentManagementRequest,
  UpdateOrgAgentRequest,
  UpdateOrgToolServerRequest,
} from "@opengeni/contracts";
import type { OpenGeniClient } from "./client";

/**
 * Console agents (organization agents): server-side administration and code
 * deploys. Opt-in like the integration helpers, outside the browser client.
 * See docs/agents.md "Console agents".
 */
export type {
  ApplyOrgAgentRequest,
  ApplyOrgAgentResponse,
  CreateOrgAgentRequest,
  CreateOrgToolServerRequest,
  EndUserToolCredential,
  ListOrgAgentComputeResponse,
  ListOrgAgentSessionsResponse,
  ListOrgAgentsResponse,
  ListOrgAgentVersionsResponse,
  ListOrgToolServersResponse,
  OrgAgent,
  OrgAgentDefinitionInput,
  OrgAgentFileInput,
  OrgAgentComputeOption,
  OrgAgentPublishOperation,
  OrgAgentResponse,
  OrgAgentRunsOn,
  OrgAgentUsageResponse,
  OrgAgentVersion,
  OrgToolServer,
  OrgToolServerToolsResponse,
  PublishOrgAgentRequest,
  PublishOrgAgentResponse,
  PutEndUserToolCredentialRequest,
  SaveOrgAgentDraftRequest,
  SetOrgAgentManagementRequest,
  UpdateOrgAgentRequest,
  UpdateOrgToolServerRequest,
};

type Client = Pick<OpenGeniClient, "requestJson">;

const segment = encodeURIComponent;
const agentsPath = (organizationId: string) =>
  `/v1/organizations/${segment(organizationId)}/agents`;
const agentPath = (organizationId: string, agentId: string) =>
  `${agentsPath(organizationId)}/${segment(agentId)}`;
const toolServersPath = (organizationId: string) => `${agentsPath(organizationId)}/tool-servers`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const credentialPath = (workspaceId: string, externalUserId: string, toolServerKey: string) =>
  `/v1/workspaces/${segment(workspaceId)}/end-users/${segment(externalUserId)}/tool-credentials/${segment(toolServerKey)}`;

function query(
  values: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = String(value);
  }
  return result;
}

/* ---------------------------------------------------------------- agents */

export async function listOrganizationAgents(
  client: Client,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ListOrgAgentsResponse> {
  return await client.requestJson(
    "GET",
    agentsPath(organizationId),
    undefined,
    query({ includeArchived: options.includeArchived }),
  );
}

/** One agent by id or key, with its published version and draft. */
export async function getOrganizationAgent(
  client: Client,
  organizationId: string,
  agentIdOrKey: string,
): Promise<OrgAgentResponse> {
  const path = UUID_PATTERN.test(agentIdOrKey)
    ? agentPath(organizationId, agentIdOrKey)
    : `${agentsPath(organizationId)}/by-key/${segment(agentIdOrKey)}`;
  return await client.requestJson("GET", path);
}

/** A Console-managed agent with an unpublished first version. */
export async function createOrganizationAgent(
  client: Client,
  organizationId: string,
  request: CreateOrgAgentRequest,
): Promise<OrgAgentResponse> {
  return await client.requestJson("POST", agentsPath(organizationId), request);
}

/** Directory fields and the extra workspaces the agent is available in. */
export async function updateOrganizationAgent(
  client: Client,
  organizationId: string,
  agentId: string,
  request: UpdateOrgAgentRequest,
): Promise<OrgAgentResponse> {
  return await client.requestJson("PATCH", agentPath(organizationId, agentId), request);
}

export async function archiveOrganizationAgent(
  client: Client,
  organizationId: string,
  agentId: string,
): Promise<OrgAgentResponse> {
  return await client.requestJson("POST", `${agentPath(organizationId, agentId)}/archive`, {});
}

/** Saves a new version (a draft) unless it equals the newest one. */
export async function saveOrganizationAgentDraft(
  client: Client,
  organizationId: string,
  agentId: string,
  request: SaveOrgAgentDraftRequest,
): Promise<OrgAgentResponse> {
  return await client.requestJson("PUT", `${agentPath(organizationId, agentId)}/draft`, request);
}

export async function listOrganizationAgentVersions(
  client: Client,
  organizationId: string,
  agentId: string,
): Promise<ListOrgAgentVersionsResponse> {
  return await client.requestJson("GET", `${agentPath(organizationId, agentId)}/versions`);
}

export async function getOrganizationAgentVersion(
  client: Client,
  organizationId: string,
  agentId: string,
  version: number,
): Promise<{ version: OrgAgentVersion }> {
  return await client.requestJson(
    "GET",
    `${agentPath(organizationId, agentId)}/versions/${segment(String(version))}`,
  );
}

/** Publishes a version; an older one is a rollback. `moveRunningChats` also moves running chats. */
export async function publishOrganizationAgent(
  client: Client,
  organizationId: string,
  agentId: string,
  request: PublishOrgAgentRequest,
): Promise<PublishOrgAgentResponse> {
  return await client.requestJson("POST", `${agentPath(organizationId, agentId)}/publish`, request);
}

/** Publish and rollback operations for one agent, newest first. */
export async function listOrganizationAgentPublishOperations(
  client: Client,
  organizationId: string,
  agentId: string,
): Promise<ListOrgAgentPublishOperationsResponse> {
  return await client.requestJson(
    "GET",
    `${agentPath(organizationId, agentId)}/publish-operations`,
  );
}

/** One publish operation, read from the agent's operation list. */
export async function getOrganizationAgentPublishOperation(
  client: Client,
  organizationId: string,
  agentId: string,
  operationId: string,
): Promise<{ operation: OrgAgentPublishOperation }> {
  const { operations } = await listOrganizationAgentPublishOperations(
    client,
    organizationId,
    agentId,
  );
  const operation = operations.find((candidate) => candidate.id === operationId);
  if (!operation) {
    throw new Error(`Publish operation ${operationId} was not found for agent ${agentId}.`);
  }
  return { operation };
}

/** Moves an agent between Console and code management (organization owners only). */
export async function setOrganizationAgentManagement(
  client: Client,
  organizationId: string,
  agentId: string,
  request: SetOrgAgentManagementRequest,
): Promise<OrgAgentResponse> {
  return await client.requestJson(
    "POST",
    `${agentPath(organizationId, agentId)}/management`,
    request,
  );
}

/**
 * The code deploy (`PUT .../agents/by-key/:key/apply`): creates a code-managed
 * agent for a new key, saves a version unless one has the same config hash,
 * and publishes it with `publish`. `dryRun` writes nothing. 409
 * `agent_managed_in_console` when the agent is edited in Console.
 */
export async function applyOrganizationAgent(
  client: Client,
  organizationId: string,
  key: string,
  request: ApplyOrgAgentRequest,
): Promise<ApplyOrgAgentResponse> {
  return await client.requestJson(
    "PUT",
    `${agentsPath(organizationId)}/by-key/${segment(key)}/apply`,
    request,
  );
}

export async function listOrganizationAgentSessions(
  client: Client,
  organizationId: string,
  agentId: string,
  options: { version?: number; cursor?: string; limit?: number } = {},
): Promise<ListOrgAgentSessionsResponse> {
  return await client.requestJson(
    "GET",
    `${agentPath(organizationId, agentId)}/sessions`,
    undefined,
    query(options),
  );
}

export async function getOrganizationAgentUsage(
  client: Client,
  organizationId: string,
  agentId: string,
  options: Record<string, string | undefined> = {},
): Promise<OrgAgentUsageResponse> {
  return await client.requestJson(
    "GET",
    `${agentPath(organizationId, agentId)}/usage`,
    undefined,
    query(options),
  );
}

/**
 * The organization machines and Sandbox Environments an agent's `runsOn` can
 * name, with whether each works in product-managed workspaces.
 */
export async function listOrganizationAgentCompute(
  client: Client,
  organizationId: string,
): Promise<ListOrgAgentComputeResponse> {
  return await client.requestJson("GET", `${agentsPath(organizationId)}/compute`);
}

/* ---------------------------------------------------------- tool servers */

export async function listOrganizationToolServers(
  client: Client,
  organizationId: string,
): Promise<ListOrgToolServersResponse> {
  return await client.requestJson("GET", toolServersPath(organizationId));
}

export async function createOrganizationToolServer(
  client: Client,
  organizationId: string,
  request: CreateOrgToolServerRequest,
): Promise<{ toolServer: OrgToolServer }> {
  return await client.requestJson("POST", toolServersPath(organizationId), request);
}

export async function getOrganizationToolServer(
  client: Client,
  organizationId: string,
  key: string,
): Promise<{ toolServer: OrgToolServer }> {
  return await client.requestJson("GET", `${toolServersPath(organizationId)}/${segment(key)}`);
}

export async function updateOrganizationToolServer(
  client: Client,
  organizationId: string,
  key: string,
  request: UpdateOrgToolServerRequest,
): Promise<{ toolServer: OrgToolServer }> {
  return await client.requestJson(
    "PATCH",
    `${toolServersPath(organizationId)}/${segment(key)}`,
    request,
  );
}

export async function deleteOrganizationToolServer(
  client: Client,
  organizationId: string,
  key: string,
): Promise<void> {
  await client.requestJson<void>(
    "DELETE",
    `${toolServersPath(organizationId)}/${segment(key)}`,
    undefined,
    {},
    { responseType: "void" },
  );
}

/** The tools a server offers now. */
export async function listOrganizationToolServerTools(
  client: Client,
  organizationId: string,
  key: string,
): Promise<OrgToolServerToolsResponse> {
  return await client.requestJson(
    "GET",
    `${toolServersPath(organizationId)}/${segment(key)}/tools`,
  );
}

/* ------------------------------------------------------ end-user logins */

/**
 * Stores an end user's own login for a `per_user` tool server (encrypted,
 * never readable back). Used after the credential provider and before a
 * chat's own headers.
 */
export async function putEndUserToolCredential(
  client: Client,
  workspaceId: string,
  externalUserId: string,
  toolServerKey: string,
  request: PutEndUserToolCredentialRequest,
): Promise<{ credential: EndUserToolCredential }> {
  return await client.requestJson(
    "PUT",
    credentialPath(workspaceId, externalUserId, toolServerKey),
    request,
  );
}

/** The stored login's metadata (never the secret). */
export async function getEndUserToolCredential(
  client: Client,
  workspaceId: string,
  externalUserId: string,
  toolServerKey: string,
): Promise<{ credential: EndUserToolCredential }> {
  return await client.requestJson(
    "GET",
    credentialPath(workspaceId, externalUserId, toolServerKey),
  );
}

export async function deleteEndUserToolCredential(
  client: Client,
  workspaceId: string,
  externalUserId: string,
  toolServerKey: string,
): Promise<void> {
  await client.requestJson<void>(
    "DELETE",
    credentialPath(workspaceId, externalUserId, toolServerKey),
    undefined,
    {},
    { responseType: "void" },
  );
}

/* ------------------------------------------------------- agents as code */

/**
 * Types an agent defined in code (the same shape as an `agents/<key>.yaml`
 * file, with `instructions` as text). Deploy it with
 * `organizationAgents(client, organizationId).deploy(agent)`.
 */
export function defineAgent<const Agent extends OrgAgentFileInput>(agent: Agent): Agent {
  return agent;
}

/**
 * Splits an agent file into its key and definition, like the CLI does. The
 * server validates the result.
 */
export function agentFileToDefinition(file: OrgAgentFileInput): {
  key: string;
  definition: OrgAgentDefinitionInput;
} {
  const { key, name, description, instructions, ...config } = file;
  return {
    key,
    definition: {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      config,
    },
  };
}

export type DeployAgentOptions = {
  publish?: boolean;
  moveRunningChats?: boolean;
  dryRun?: boolean;
  expectedVersion?: number;
};

/** One organization's agents, tool servers and end-user logins. */
export function organizationAgents(client: Client, organizationId: string) {
  return {
    list: (options?: { includeArchived?: boolean }) =>
      listOrganizationAgents(client, organizationId, options),
    get: (agentIdOrKey: string) => getOrganizationAgent(client, organizationId, agentIdOrKey),
    create: (request: CreateOrgAgentRequest) =>
      createOrganizationAgent(client, organizationId, request),
    update: (agentId: string, request: UpdateOrgAgentRequest) =>
      updateOrganizationAgent(client, organizationId, agentId, request),
    archive: (agentId: string) => archiveOrganizationAgent(client, organizationId, agentId),
    saveDraft: (agentId: string, request: SaveOrgAgentDraftRequest) =>
      saveOrganizationAgentDraft(client, organizationId, agentId, request),
    versions: (agentId: string) => listOrganizationAgentVersions(client, organizationId, agentId),
    version: (agentId: string, version: number) =>
      getOrganizationAgentVersion(client, organizationId, agentId, version),
    publish: (agentId: string, request: PublishOrgAgentRequest) =>
      publishOrganizationAgent(client, organizationId, agentId, request),
    publishOperations: (agentId: string) =>
      listOrganizationAgentPublishOperations(client, organizationId, agentId),
    publishOperation: (agentId: string, operationId: string) =>
      getOrganizationAgentPublishOperation(client, organizationId, agentId, operationId),
    setManagement: (agentId: string, request: SetOrgAgentManagementRequest) =>
      setOrganizationAgentManagement(client, organizationId, agentId, request),
    /** `PUT .../by-key/:key/apply` with a definition. */
    apply: (key: string, definition: OrgAgentDefinitionInput, options: DeployAgentOptions = {}) =>
      applyOrganizationAgent(client, organizationId, key, { ...definition, ...options }),
    /** Deploys an agent file or {@link defineAgent} result. */
    deploy: (agent: OrgAgentFileInput, options: DeployAgentOptions = {}) => {
      const { key, definition } = agentFileToDefinition(agent);
      return applyOrganizationAgent(client, organizationId, key, { ...definition, ...options });
    },
    sessions: (agentId: string, options?: { version?: number; cursor?: string; limit?: number }) =>
      listOrganizationAgentSessions(client, organizationId, agentId, options),
    usage: (agentId: string, options?: Record<string, string | undefined>) =>
      getOrganizationAgentUsage(client, organizationId, agentId, options),
    /** Machines and Sandbox Environments `runsOn` can name. */
    compute: () => listOrganizationAgentCompute(client, organizationId),
    toolServers: {
      list: () => listOrganizationToolServers(client, organizationId),
      get: (key: string) => getOrganizationToolServer(client, organizationId, key),
      create: (request: CreateOrgToolServerRequest) =>
        createOrganizationToolServer(client, organizationId, request),
      update: (key: string, request: UpdateOrgToolServerRequest) =>
        updateOrganizationToolServer(client, organizationId, key, request),
      delete: (key: string) => deleteOrganizationToolServer(client, organizationId, key),
      tools: (key: string) => listOrganizationToolServerTools(client, organizationId, key),
    },
    /** End users' own logins for `per_user` tool servers, per workspace. */
    toolCredentials: {
      put: (
        workspaceId: string,
        externalUserId: string,
        toolServerKey: string,
        request: PutEndUserToolCredentialRequest,
      ) => putEndUserToolCredential(client, workspaceId, externalUserId, toolServerKey, request),
      get: (workspaceId: string, externalUserId: string, toolServerKey: string) =>
        getEndUserToolCredential(client, workspaceId, externalUserId, toolServerKey),
      delete: (workspaceId: string, externalUserId: string, toolServerKey: string) =>
        deleteEndUserToolCredential(client, workspaceId, externalUserId, toolServerKey),
    },
  };
}

export type OrganizationAgentsClient = ReturnType<typeof organizationAgents>;
