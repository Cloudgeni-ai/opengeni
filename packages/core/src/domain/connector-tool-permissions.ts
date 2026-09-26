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
  ConnectorToolPermission,
  ConnectorToolPermissionEntry,
  ConnectorToolPermissionsResponse,
  UpdateConnectorToolPermissionsRequest,
} from "@opengeni/contracts";
import {
  buildConnectionTokenResolver,
  getConnectionMetadata,
  listConnectionsMetadata,
  listEnabledMcpCapabilityServers,
  listConnectorToolPermissionPolicies,
  updateConnectorToolPermissionPolicies,
  resolveConnectorActionPolicy,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { GMAIL_REST_MCP_TOOLS, isOfficialGmailMcpConfig } from "@opengeni/runtime";
import { hasPermission } from "../access";
import { buildCapabilityCatalog, settingsWithMcpCapabilityServers } from "./capabilities";

type Input = {
  db: Database;
  settings: Settings;
  workspaceId: string;
  grant: AccessGrant;
  capabilityId: string;
  personalOwnerVerified: boolean;
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

async function resolveTarget(input: Input) {
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
  if (ref?.authoritySource === "host")
    throw new HTTPException(409, {
      message: "Tool permissions for this connection are managed by its host",
    });
  let connection = ref?.connectionId
    ? await getConnectionMetadata(
        input.db,
        input.workspaceId,
        ref.connectionId,
        input.grant.subjectId,
      )
    : null;
  if (ref?.subjectScope === "subject" && !ref.connectionId) {
    const visible = await listConnectionsMetadata(
      input.db,
      input.workspaceId,
      input.grant.subjectId,
    );
    connection =
      visible.find(
        (candidate) =>
          candidate.subjectId === input.grant.subjectId &&
          candidate.providerDomain === ref.providerDomain &&
          (!ref.kind || candidate.kind === ref.kind) &&
          candidate.status === "active",
      ) ?? null;
  }
  if (
    ref &&
    (!connection ||
      connection.providerDomain !== ref.providerDomain ||
      (ref.kind && connection.kind !== ref.kind) ||
      (ref.subjectScope === "subject"
        ? connection.subjectId !== input.grant.subjectId
        : connection.subjectId !== null))
  ) {
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
  return { server, connection, connectionId };
}

async function listTools(
  input: Input,
  target: Awaited<ReturnType<typeof resolveTarget>>,
): Promise<ListedTool[]> {
  // Runtime substitutes the reviewed REST bridge for this exact MCP identity.
  // Its static catalog must not depend on Google's hosted MCP preview.
  if (isOfficialGmailMcpConfig(target.server.url, target.server.connectionRef)) {
    return GMAIL_REST_MCP_TOOLS.filter(
      (tool) => !target.server.allowedTools || target.server.allowedTools.includes(tool.name),
    );
  }
  let headers = { ...target.server.headers };
  if (target.server.connectionRef) {
    const result = await buildConnectionTokenResolver(
      input.db,
      input.settings,
    )({
      workspaceId: input.workspaceId,
      ...(target.connection?.subjectId ? { subjectId: input.grant.subjectId } : {}),
      serverId: target.server.id,
      toolName: "tools/list",
      connectionRef: { ...target.server.connectionRef, connectionId: target.connectionId },
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
  const permission = (
    name: string,
  ): { permission: ConnectorToolPermission; inherited: boolean } => {
    const resolved = resolveConnectorActionPolicy(policies, {
      connectionId: target.connectionId,
      serverId: target.server.id,
      toolName: name,
      actionName: "*",
    });
    if (!resolved.managed) return { permission: "allow", inherited: true };
    return {
      permission: resolved.entry?.policy ?? "block",
      inherited: resolved.entry?.toolName !== name,
    };
  };
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
        ...((tool.title ?? tool.annotations?.title)
          ? { title: tool.title ?? tool.annotations?.title }
          : {}),
        ...(tool.description ? { description: tool.description } : {}),
        group: connectorToolGroup(tool),
        ...permission(tool.name),
        approvalRequired:
          target.server.requireApproval === true ||
          (Array.isArray(target.server.requireApproval) &&
            target.server.requireApproval.includes(tool.name)),
      }),
    ),
    discoveryError,
    canManage: canManageConnectorPermissions(input.grant),
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
  const target = await resolveTarget(input);
  // Prevent a reconnect while the sheet is open from applying old choices to a new account.
  if (target.connectionId !== input.payload.connectionId)
    throw new HTTPException(409, {
      message: "The connector account changed. Reload its permissions.",
    });
  await updateConnectorToolPermissionPolicies(input.db, {
    accountId: input.grant.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.grant.subjectId,
    connectionId: target.connectionId,
    serverId: target.server.id,
    toolNames: input.payload.target === "default" ? ["*"] : input.payload.toolNames,
    policy: input.payload.permission,
  });
}
