import { slackRestMcpToolsForScopes } from "@opengeni/contracts/slack-rest-mcp";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { mcpAccountBindingsFromVisibleConnections } from "./mcp-account-bindings";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  boundMcpResponseBody,
  MCP_MAX_RESPONSE_BYTES,
  assertMcpToolListWithinBounds,
} from "@opengeni/runtime/mcp-network";
import { createPinnedIntegrationTransport } from "@opengeni/capabilities";
import type { Settings } from "@opengeni/config";
import type {
  AccessGrant,
  ConnectorToolPermissionEntry,
  ConnectorToolPermissionsResponse,
  UpdateConnectorToolPermissionsRequest,
  ConnectionMetadata,
  McpServerConnectionRef,
} from "@opengeni/contracts";
import {
  buildConnectionTokenResolver,
  getConnectionMetadata,
  listEnabledMcpCapabilityServers,
  listConnectorToolPermissionPolicies,
  listChangedConnectorToolPermissions,
  updateConnectorToolPermissionPolicies,
  projectConnectorToolPermission,
  connectorToolPolicyRevision,
  ConnectorToolPermissionConflictError,
  listInstalledApiIntegrations,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  GMAIL_REST_MCP_TOOLS,
  gmailToolSupportsScopes,
  isOfficialGmailMcpConfig,
  isOfficialSlackMcpConfig,
} from "@opengeni/runtime";
import { hasPermission } from "../access";
import {
  personalConnectionDelegationSourceForGrant,
  visibleMcpAccountConnections,
} from "./personal-connection-delegations";
import {
  buildCapabilityCatalog,
  settingsWithMcpCapabilityServers,
  settingsWithApiIntegrationServers,
} from "./capabilities";

type Input = {
  db: Database;
  settings: Settings;
  workspaceId: string;
  grant: AccessGrant;
  capabilityId: string;
  personalOwnerVerified: boolean;
  connectionId?: string;
  instanceKey?: string;
};
type ListedTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  annotations?:
    | {
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        title?: string | undefined;
      }
    | undefined;
};

export function connectorToolGroup(tool: ListedTool): "read" | "write" | "other" {
  if (tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false)
    return "write";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "other";
}

/** A selector can supply discovery credentials only when one visible account
 * matches. Never apply one account's approval choices to an arbitrary sibling. */
export function unpinnedConnectorToolPermissionAccount<T extends ConnectionMetadata>(
  ref: McpServerConnectionRef,
  visible: T[],
  subjectId: string,
): T | null {
  const matches = visible.filter(
    (candidate) =>
      candidate.subjectId === (ref.subjectScope === "subject" ? subjectId : null) &&
      candidate.providerDomain === ref.providerDomain &&
      (!ref.kind || candidate.kind === ref.kind) &&
      candidate.status === "active",
  );
  if (matches.length > 1)
    throw new HTTPException(409, {
      message: "Choose one account to manage its tool permissions",
    });
  return matches[0] ?? null;
}

export function connectorToolPermissionReference(
  ref: McpServerConnectionRef,
  connectionId: string,
): McpServerConnectionRef {
  return { ...ref, accountSelection: undefined, connectionId };
}

async function resolveTarget(input: Input) {
  if (input.capabilityId.startsWith("api:")) {
    const integrations = (
      await listInstalledApiIntegrations(
        input.db,
        input.workspaceId,
        input.personalOwnerVerified ? input.grant.subjectId : undefined,
      )
    ).filter((integration) => integration.capabilityId === input.capabilityId);
    const accountId = (integration: (typeof integrations)[number]) =>
      integration.connectionRef?.connectionId ??
      `session-mcp:${integration.serverId}:${createHash("sha256").update(integration.baseUrl, "utf8").digest("hex")}`;
    const integration = integrations.find(
      (candidate) =>
        (!input.instanceKey || candidate.instanceKey === input.instanceKey) &&
        (!input.connectionId || accountId(candidate) === input.connectionId),
    );
    if (!integration) throw new HTTPException(404, { message: "Integration account unavailable" });
    const server = settingsWithApiIntegrationServers({ ...input.settings, mcpServers: [] }, [
      integration,
    ]).mcpServers[0]!;
    const connection = integration.connectionRef?.connectionId
      ? await getConnectionMetadata(
          input.db,
          input.workspaceId,
          integration.connectionRef.connectionId,
          input.grant.subjectId,
        )
      : null;
    const accounts = integrations.map((candidate) => ({
      connectionId: accountId(candidate),
      label: candidate.displayName,
      scope:
        candidate.connectionRef?.subjectScope === "subject"
          ? ("personal" as const)
          : candidate.connectionRef
            ? ("workspace" as const)
            : ("none" as const),
      instanceKey: candidate.instanceKey,
    }));
    return {
      server,
      connection,
      connectionId: accountId(integration),
      accountLabel: connection
        ? connectionAccountIdentityLabel(connection.metadata, integration.displayName)
        : integration.displayName,
      accounts,
      instanceKey: integration.instanceKey,
      listedTools: integration.revision.tools
        .filter((tool) => integration.allowedTools.includes(tool.id))
        .map(
          (tool): ListedTool => ({
            name: tool.id,
            title: tool.name,
            description: tool.description,
            annotations: {
              readOnlyHint: tool.safety === "read",
              destructiveHint: tool.safety === "destructive",
            },
          }),
        ),
    };
  }
  const catalog = await buildCapabilityCatalog(input);
  const item = catalog.items.find((candidate) => candidate.id === input.capabilityId);
  if (
    !item ||
    !item.enabled ||
    item.kind !== "mcp" ||
    !item.runtime.mcpServerId ||
    item.source === "built_in"
  ) {
    throw new HTTPException(404, { message: "Connected MCP connector not found" });
  }
  const enabled = await listEnabledMcpCapabilityServers(input.db, input.workspaceId);
  const settings = settingsWithMcpCapabilityServers(input.settings, enabled);
  const server = settings.mcpServers.find((candidate) => candidate.id === item.runtime.mcpServerId);
  if (!server || server.url !== item.endpointUrl)
    throw new HTTPException(409, { message: "Connector configuration is unavailable" });
  const ref = server.connectionRef;
  if (
    ref?.subjectScope === "subject" &&
    ref.accountSelection !== "all_eligible" &&
    !input.personalOwnerVerified
  )
    throw new HTTPException(403, {
      message: "Only the authenticated connection owner may manage personal tool permissions",
    });
  const source = personalConnectionDelegationSourceForGrant(input.grant);
  const visible = ref
    ? await visibleMcpAccountConnections(input.db, {
        accountId: input.grant.accountId,
        workspaceId: input.workspaceId,
        source:
          input.personalOwnerVerified && source.kind === "subject" ? source : { kind: "none" },
      })
    : [];
  const bindings = mcpAccountBindingsFromVisibleConnections({
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.personalOwnerVerified ? input.grant.subjectId : null,
    servers: [server],
    // Runtime admission can enumerate every eligible account. A permission
    // selector must also preserve the installation's explicit owner scope.
    connections:
      ref?.accountSelection === "all_eligible"
        ? visible
        : visible.filter((candidate) =>
            ref?.subjectScope === "subject"
              ? candidate.subjectId === input.grant.subjectId
              : candidate.subjectId === null,
          ),
  });
  const binding = bindings.find(
    (candidate) => !input.connectionId || candidate.connectionId === input.connectionId,
  );
  const connection = visible.find((candidate) => candidate.id === binding?.connectionId) ?? null;
  if (ref && !connection) {
    throw new HTTPException(409, { message: "Reconnect this connector to manage its tools" });
  }
  if (connection?.subjectId && !input.personalOwnerVerified)
    throw new HTTPException(403, {
      message: "Only the authenticated connection owner may manage personal tool permissions",
    });
  // Same secret-free target identity used by runtime sessionMcpApprovalConnectionId.
  const connectionId =
    connection?.id ??
    `session-mcp:${server.id}:${createHash("sha256").update(server.url, "utf8").digest("hex")}`;
  if (input.connectionId && input.connectionId !== connectionId)
    throw new HTTPException(409, {
      message: "Connector account unavailable. Reload its permissions.",
    });
  return {
    server: binding ? { ...server, connectionRef: binding.connectionRef } : server,
    connection,
    connectionId,
    accountLabel: binding?.accountLabel ?? server.name ?? server.id,
    accounts: bindings.map((candidate) => ({
      connectionId: candidate.connectionId,
      label: candidate.accountLabel,
      scope: candidate.subjectScope === "subject" ? ("personal" as const) : ("workspace" as const),
    })),
    instanceKey: undefined,
    listedTools: null,
  };
}

/** Use the same adapter-owned identities as execution for reviewed local catalogs. */
export function reviewedConnectorToolCatalog(
  server: Pick<Settings["mcpServers"][number], "url" | "connectionRef" | "allowedTools">,
  grantedScopes: readonly string[],
): ListedTool[] | null {
  const tools = isOfficialGmailMcpConfig(server.url, server.connectionRef)
    ? GMAIL_REST_MCP_TOOLS.filter((tool) => gmailToolSupportsScopes(tool.name, grantedScopes))
    : isOfficialSlackMcpConfig(server.url, server.connectionRef)
      ? slackRestMcpToolsForScopes(grantedScopes)
      : null;
  return (
    tools?.filter((tool) => !server.allowedTools || server.allowedTools.includes(tool.name)) ?? null
  );
}

async function listTools(
  input: Input,
  target: Awaited<ReturnType<typeof resolveTarget>>,
): Promise<ListedTool[]> {
  if (target.listedTools !== null) return target.listedTools;
  const reviewed = reviewedConnectorToolCatalog(
    target.server,
    target.connection?.grantedScopes ?? [],
  );
  if (reviewed !== null) return reviewed;
  let headers = { ...target.server.headers };
  if (target.server.connectionRef) {
    const result = await buildConnectionTokenResolver(
      input.db,
      input.settings,
    )({
      // The selected account's credentials remain in its origin workspace;
      // approval preferences remain scoped to the workspace being configured.
      workspaceId: target.connection?.workspaceId ?? input.workspaceId,
      ...(target.connection?.subjectId ? { subjectId: input.grant.subjectId } : {}),
      serverId: target.server.id,
      toolName: "tools/list",
      connectionRef: connectorToolPermissionReference(
        target.server.connectionRef,
        target.connectionId,
      ),
      destinationUrl: target.server.url,
    });
    if (result.status !== "ok") throw new Error("Reconnect this connector to load its tools.");
    headers = { ...headers, ...result.headers };
  }
  const pinned = createPinnedIntegrationTransport({ network: input.settings });
  const deadline = AbortSignal.timeout(15_000);
  const client = new Client(
    { name: "opengeni-tool-permissions", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    const transport = new StreamableHTTPClientTransport(new URL(target.server.url), {
      requestInit: { headers },
      fetch: async (url, init) =>
        boundMcpResponseBody(
          await pinned.fetch(url.toString(), {
            ...init,
            signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
          }),
          MCP_MAX_RESPONSE_BYTES,
        ),
    });
    await client.connect(transport as unknown as Transport, {
      timeout: 15_000,
      maxTotalTimeout: 15_000,
    });
    const tools = await collectConnectorToolPages(client, deadline);
    return tools.filter(
      (tool) => !target.server.allowedTools || target.server.allowedTools.includes(tool.name),
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Collect discovery pages without changing the caller's connection or authority. */
export async function collectConnectorToolPages(
  client: Pick<Client, "listTools">,
  deadline: AbortSignal,
): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: 15_000,
      maxTotalTimeout: 15_000,
      signal: deadline,
    });
    tools.push(...page.tools);
    assertMcpToolListWithinBounds(tools);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new Error("The connector returned duplicate tool names.");
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error("The connector returned an invalid or oversized tool catalog.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

export async function getConnectorToolPermissions(
  input: Input,
): Promise<ConnectorToolPermissionsResponse> {
  const target = await resolveTarget(input);
  const policies = await listConnectorToolPermissionPolicies(input.db, {
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    connectionId: target.connectionId,
  });
  const changedTools = new Set(
    await listChangedConnectorToolPermissions(input.db, {
      accountId: input.grant.accountId,
      workspaceId: input.workspaceId,
      connectionId: target.connectionId,
      serverId: target.server.id,
    }),
  );
  const defaultPolicy = policies.find(
    (row) => row.serverId === target.server.id && row.toolName === "*" && row.actionName === "*",
  );
  let tools: ListedTool[] = [];
  let discoveryError: string | null = null;
  try {
    tools = await listTools(input, target);
    if (tools.some((tool) => tool.name === "*" || tool.name !== tool.name.trim())) {
      tools = tools.filter((tool) => tool.name !== "*" && tool.name === tool.name.trim());
      discoveryError =
        "The connector exposes a reserved or whitespace-padded tool name. Individual permissions for these names are unsupported, so they are omitted from tool groups. The connector default still applies.";
    }
  } catch {
    discoveryError =
      "Could not load the connector's tools. Try again or reconnect. Your saved permissions still apply.";
  }
  return {
    connectionId: target.connectionId,
    serverId: target.server.id,
    defaultPermission: defaultPolicy?.policy ?? null,
    tools: tools.map(
      (tool): ConnectorToolPermissionEntry => ({
        name: tool.name,
        ...(changedTools.has(tool.name) ? { resetReason: "operation_changed" as const } : {}),
        ...((tool.title ?? tool.annotations?.title)
          ? { title: tool.title ?? tool.annotations?.title }
          : {}),
        ...(tool.description ? { description: tool.description } : {}),
        group: connectorToolGroup(tool),
        ...projectConnectorToolPermission(policies, {
          connectionId: target.connectionId,
          serverId: target.server.id,
          toolName: tool.name,
          defaultDecision:
            target.server.requireApproval === true ||
            (Array.isArray(target.server.requireApproval) &&
              target.server.requireApproval.includes(tool.name))
              ? "ask"
              : "allow",
        }),
      }),
    ),
    discoveryError,
    canManage: canManageConnectorPermissions(input.grant),
    appliesTo: "next_attempt",
    revision: connectorToolPolicyRevision(policies, target.connectionId, target.server.id),
    accountLabel: target.accountLabel,
    accounts: target.accounts,
    ...(target.instanceKey ? { instanceKey: target.instanceKey } : {}),
  };
}

function canManageConnectorPermissions(grant: AccessGrant): boolean {
  return (
    hasPermission(grant.permissions, "capabilities:manage") &&
    grant.principalKind !== "agent_attempt" &&
    grant.principalKind !== "service" &&
    !grant.serviceInitiator &&
    !grant.serviceInitiatorContext
  );
}

export async function updateConnectorToolPermissions(
  input: Input & { payload: UpdateConnectorToolPermissionsRequest },
): Promise<void> {
  if (!canManageConnectorPermissions(input.grant))
    throw new HTTPException(403, { message: "Connector management permission required" });
  if (
    input.payload.target === "tools" &&
    input.payload.toolNames.some((name) => name === "*" || name !== name.trim())
  )
    throw new HTTPException(400, {
      message: "Tool names must be exact and cannot use the connector-default wildcard.",
    });
  const target = await resolveTarget({
    ...input,
    connectionId: input.payload.connectionId,
    ...(input.payload.instanceKey ? { instanceKey: input.payload.instanceKey } : {}),
  });
  // Prevent a reconnect while the sheet is open from applying old choices to a new account.
  if (target.connectionId !== input.payload.connectionId)
    throw new HTTPException(409, {
      message: "The connector account changed. Reload its permissions.",
    });
  try {
    await updateConnectorToolPermissionPolicies(input.db, {
      accountId: input.grant.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.grant.subjectId,
      connectionId: target.connectionId,
      serverId: target.server.id,
      toolNames:
        input.payload.target === "default"
          ? ["*"]
          : input.payload.target === "action"
            ? [input.payload.toolName]
            : input.payload.toolNames,
      ...(input.payload.target === "action" ? { actionName: input.payload.actionName } : {}),
      ...(input.payload.expectedRevision
        ? { expectedRevision: input.payload.expectedRevision }
        : {}),
      policy: input.payload.permission,
    });
  } catch (error) {
    if (error instanceof ConnectorToolPermissionConflictError)
      throw new HTTPException(409, { message: error.message });
    throw error;
  }
}
