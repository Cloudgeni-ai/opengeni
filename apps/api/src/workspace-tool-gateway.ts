import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CODEX_CLIENT_VERSION } from "@opengeni/codex";
import type { Settings } from "@opengeni/config";
import {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayApprovalRequest,
  ToolGatewayApprovalResponse,
  ToolGatewayDeclarationsResponse,
  type AccessGrant,
  type ToolGatewayCatalog,
  type ToolRef,
} from "@opengeni/contracts";
import {
  buildApiIntegrationMcpServers,
  hasPermission,
  requireResolvedAccessGrantAuthorization,
  resolveCodexAppsCredentialIdForRun,
  resolveWorkspaceCatalogSettings,
  settingsWithEnabledCapabilityMcpServers,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  buildCodexTokenResolver,
  buildConnectionTokenResolver,
  withCodexAppsRequestAuthorization,
  consumeToolGatewayApproval,
  getWorkspaceArtifact,
  issueToolGatewayApproval,
  ToolGatewayApprovalRateLimitError,
  WorkspaceArtifactNotFoundError,
  type ApiIntegrationRuntime,
} from "@opengeni/db";
import {
  type LocalMcpServerRegistration,
  type PreparedWorkspaceToolGatewayTools,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  prepareWorkspaceToolGatewayTools,
} from "@opengeni/runtime/workspace-tool-gateway";
import {
  ToolGatewayApprovalRequiredError,
  ToolGatewayCatalogStaleError,
  ToolGatewayInputValidationError,
  ToolGatewayToolNotFoundError,
  digestCanonicalJson,
  generateToolGatewayDeclarations,
} from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";

import { buildDocumentsMcpServer } from "./mcp/documents";
import { buildFilesMcpServer } from "./mcp/files";
import { buildOpenGeniMcpServer } from "./mcp/server";
import { startWorkspaceToolGatewayObservation } from "./workspace-tool-gateway-observability";
import type { Observability } from "@opengeni/observability";

export type PreparedWorkspaceToolGateway = Pick<
  PreparedWorkspaceToolGatewayTools,
  "toolGateway" | "toolGatewayCatalog" | "close"
> & {
  toolGateway: NonNullable<PreparedWorkspaceToolGatewayTools["toolGateway"]>;
  toolGatewayCatalog: NonNullable<PreparedWorkspaceToolGatewayTools["toolGatewayCatalog"]>;
};

type WorkspaceSiteToolContext = {
  siteArtifactId: string;
  siteVersionId: string;
  identity: { serverId: string; toolName: string };
};

type AuthorizeWorkspaceSiteTool = (
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  context: WorkspaceSiteToolContext,
) => Promise<void>;

export function grantUsesAttemptScopedMcp(grant: AccessGrant): boolean {
  return (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.delegated === true ||
    typeof grant.metadata?.sessionId === "string"
  );
}

export function requireWorkspaceToolGatewayGrant(grant: AccessGrant): void {
  if (
    grantUsesAttemptScopedMcp(grant) ||
    (grant.principalKind !== undefined && grant.principalKind !== "human_session")
  ) {
    throw new HTTPException(403, { message: "current-human tool access required" });
  }
}

export function requireWorkspaceToolGatewayAuthorization(
  authorization: AccessGrantAuthorization,
): AccessGrant {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  requireWorkspaceToolGatewayGrant(grant);
  if (!authorization.canonicalManagedHumanSession && !authorization.canonicalLocalHumanSession) {
    throw new HTTPException(403, { message: "current-human tool access required" });
  }
  return grant;
}

export async function prepareWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
): Promise<PreparedWorkspaceToolGateway> {
  const grant = requireWorkspaceToolGatewayAuthorization(authorization);
  return await prepareWorkspaceToolGatewayForGrant(routeDeps, grant);
}

export async function prepareMcpOAuthWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  grant: AccessGrant,
  allowedIdentities: readonly { serverId: string; toolName: string }[],
): Promise<PreparedWorkspaceToolGateway> {
  if (grant.metadata?.mcpOAuth !== true || grant.principalKind !== "human_session") {
    throw new HTTPException(403, { message: "MCP OAuth authority is invalid" });
  }
  return await prepareWorkspaceToolGatewayForGrant(routeDeps, grant, allowedIdentities);
}

async function prepareWorkspaceToolGatewayForGrant(
  routeDeps: ApiRouteDeps,
  grant: AccessGrant,
  allowedIdentities?: readonly { serverId: string; toolName: string }[],
): Promise<PreparedWorkspaceToolGateway> {
  const catalogSourceSettings = routeDeps.catalogSourceSettings ?? routeDeps.settings;
  const resolvedCatalog = await resolveWorkspaceCatalogSettings(
    routeDeps.db,
    catalogSourceSettings,
    {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    },
  );
  let integrations: readonly ApiIntegrationRuntime[] = [];
  const settings = await settingsWithEnabledCapabilityMcpServers(
    routeDeps.db,
    grant.workspaceId,
    resolvedCatalog.settings,
    {
      subjectId: grant.subjectId,
      onResolvedApiIntegrations: (resolved) => {
        integrations = resolved;
      },
    },
  );
  const gatewaySettings = workspaceToolGatewaySettingsForGrant(settings, grant, allowedIdentities);
  const gatewayServerIds = new Set(gatewaySettings.mcpServers.map((server) => server.id));
  const deps = { ...routeDeps, catalogSourceSettings, settings: gatewaySettings };
  const resolveConnection = buildConnectionTokenResolver(routeDeps.db, gatewaySettings);
  const resolveCredential = async (
    input: ResolveConnectionCredentialInput,
  ): Promise<ResolveConnectionCredentialResult> =>
    await resolveConnection({
      ...input,
      ...(input.connectionRef.subjectScope === "subject" ? { subjectId: grant.subjectId } : {}),
    });
  const firstPartyServers = await Promise.all([
    ...(gatewayServerIds.has("opengeni")
      ? [inMemoryMcpRegistration("opengeni", buildOpenGeniMcpServer(deps, grant))]
      : []),
    ...(gatewayServerIds.has("files")
      ? [inMemoryMcpRegistration("files", buildFilesMcpServer(deps, grant))]
      : []),
    ...(gatewayServerIds.has("docs")
      ? [
          inMemoryMcpRegistration(
            "docs",
            buildDocumentsMcpServer(
              routeDeps.db,
              grant.accountId,
              grant.workspaceId,
              routeDeps.getDocumentServices(),
              { initiatingSubjectId: grant.subjectId },
            ),
          ),
        ]
      : []),
  ]);
  const apiIntegrationServers = buildApiIntegrationMcpServers({
    settings: gatewaySettings,
    integrations: integrations.filter((integration) => gatewayServerIds.has(integration.serverId)),
    authority: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initiatingSubjectId: grant.subjectId,
    },
    resolveCredential: async (input) =>
      await resolveConnection({
        ...input,
        ...(input.connectionRef.subjectScope === "subject" ? { subjectId: grant.subjectId } : {}),
      }),
  });
  const codexAppsCredentialId = gatewayServerIds.has("codex_apps")
    ? await resolveCodexAppsCredentialIdForRun(routeDeps.db, grant.workspaceId)
    : null;
  const codexAppsAuth = codexAppsCredentialId
    ? (() => {
        const resolver = buildCodexTokenResolver(
          routeDeps.db,
          settings,
          grant.workspaceId,
          codexAppsCredentialId,
        );
        return {
          clientVersion: CODEX_CLIENT_VERSION,
          withAuthorization: async <T>(
            use: (token: { accessToken: string; chatgptAccountId: string | null }) => Promise<T>,
          ): Promise<T> =>
            await resolver.getToken().then(
              async (token) =>
                await withCodexAppsRequestAuthorization(
                  routeDeps.db,
                  {
                    workspaceId: grant.workspaceId,
                    credentialId: codexAppsCredentialId,
                  },
                  async () => await use(token),
                ),
            ),
        };
      })()
    : undefined;
  const localMcpServers = [...firstPartyServers, ...apiIntegrationServers];
  const prepared = await prepareWorkspaceToolGatewayTools(
    gatewaySettings,
    allGatewayToolRefs(gatewaySettings),
    {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      credentialSubjectId: grant.subjectId,
      resolveCredential,
      localMcpServers,
      ...(codexAppsAuth ? { codexAppsAuth } : {}),
      workspaceToolGateway: {
        requireApproval: (entry, _caller, context) =>
          entry.approval === "human" && context.transportMeta?.approvalConfirmed !== true,
        ...(allowedIdentities
          ? {
              filterDefinition: (definition) =>
                allowedIdentities.some(
                  (identity) =>
                    identity.serverId === definition.identity.serverId &&
                    identity.toolName === definition.identity.toolName,
                ),
            }
          : {}),
      },
    },
  );
  if (!prepared.toolGateway || !prepared.toolGatewayCatalog) {
    await prepared.close().catch(() => undefined);
    throw new Error("workspace tool gateway preparation did not produce a gateway");
  }
  return {
    toolGateway: prepared.toolGateway,
    toolGatewayCatalog: prepared.toolGatewayCatalog,
    close: prepared.close,
  };
}

export function workspaceToolGatewaySettingsForGrant(
  settings: Settings,
  grant: AccessGrant,
  allowedIdentities?: readonly { serverId: string; toolName: string }[],
): Settings {
  const allowedServerIds = allowedIdentities
    ? new Set(allowedIdentities.map((identity) => identity.serverId))
    : null;
  return {
    ...settings,
    mcpServers: settings.mcpServers.filter((server) => {
      if (allowedServerIds && !allowedServerIds.has(server.id)) return false;
      if (server.id === "docs" && !hasPermission(grant.permissions, "documents:search")) {
        return false;
      }
      if (server.id === "files" && !hasPermission(grant.permissions, "files:read")) return false;
      return true;
    }),
  };
}

export function buildWorkspaceToolGatewayMcpServer(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  observability?: Observability,
): Server {
  const server = new Server(
    { name: "opengeni-tool-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: prepared.toolGatewayCatalog.entries.map((entry) => ({
      name: entry.modelName,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
      ...(entry.icons ? { icons: entry.icons } : {}),
      _meta: {
        "opengeni/identity": entry.identity,
        "opengeni/path": entry.codemodePath,
        "opengeni/source": entry.source,
        "opengeni/approval": entry.approval,
        "opengeni/catalogDigest": prepared.toolGatewayCatalog.digest,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = prepared.toolGatewayCatalog.entries.find(
      (candidate) => candidate.modelName === request.params.name,
    );
    if (!entry) throw new ToolGatewayToolNotFoundError();
    const observation = startWorkspaceToolGatewayObservation(observability, {
      adapter: "mcp",
      operation: "call",
      source: entry.source,
    });
    try {
      const result = (await prepared.toolGateway.call(
        {
          operationId: crypto.randomUUID(),
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: entry.identity,
          arguments: request.params.arguments ?? {},
          caller: { kind: "mcp", subjectId: grant.subjectId },
        },
        { signal: extra.signal },
      )) as CallToolResult;
      observation.end(result.isError ? "tool_error" : "ok");
      return result;
    } catch (error) {
      observation.end(workspaceToolGatewayOutcome(error));
      throw error;
    }
  });
  return server;
}

export async function callWorkspaceToolGateway(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  input: unknown,
  db?: ApiRouteDeps["db"],
  consumeApproval: typeof consumeToolGatewayApproval = consumeToolGatewayApproval,
  observability?: Observability,
  authorizeSiteTool: AuthorizeWorkspaceSiteTool = requireWorkspaceSiteToolAuthorization,
) {
  const request = ToolGatewayCallRequest.parse(input);
  const operationId = request.operationId ?? crypto.randomUUID();
  const entry = prepared.toolGatewayCatalog.entries.find(
    (candidate) =>
      candidate.identity.serverId === request.identity.serverId &&
      candidate.identity.toolName === request.identity.toolName,
  );
  const observation = startWorkspaceToolGatewayObservation(observability, {
    adapter: "http",
    operation: "call",
    source: entry?.source ?? "aggregate",
  });
  try {
    const siteContext =
      request.siteArtifactId && request.siteVersionId
        ? {
            siteArtifactId: request.siteArtifactId,
            siteVersionId: request.siteVersionId,
            identity: request.identity,
          }
        : null;
    if (entry && siteContext) {
      if (!db) throw new HTTPException(409, { message: "tool_gateway_approval_required" });
      await authorizeSiteTool(db, grant, siteContext);
    }
    let approvalConfirmed = false;
    const approvalRequired = entry?.approval === "human" || siteContext !== null;
    if (approvalRequired && request.approvalToken && db) {
      approvalConfirmed = await consumeApproval(db, {
        tokenHash: hashOpaqueValue(request.approvalToken),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        argumentsDigest: digestCanonicalJson(request.arguments),
        ...(siteContext ? { siteVersionId: siteContext.siteVersionId } : {}),
      });
    }
    if (approvalRequired && !approvalConfirmed) {
      throw new HTTPException(409, { message: "tool_gateway_approval_required" });
    }
    const result = await prepared.toolGateway.call(
      {
        operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        arguments: request.arguments,
        caller: { kind: "http", subjectId: grant.subjectId },
      },
      {
        transportMeta: { approvalConfirmed },
      },
    );
    observation.end(result.isError ? "tool_error" : "ok");
    return ToolGatewayCallResponse.parse({
      operationId,
      catalogDigest: prepared.toolGatewayCatalog.digest,
      result,
    });
  } catch (error) {
    observation.end(workspaceToolGatewayOutcome(error));
    if (error instanceof ToolGatewayCatalogStaleError) {
      throw new HTTPException(409, { message: error.code, cause: error });
    }
    if (error instanceof ToolGatewayToolNotFoundError) {
      throw new HTTPException(404, { message: error.code, cause: error });
    }
    if (error instanceof ToolGatewayInputValidationError) {
      throw new HTTPException(422, { message: error.code, cause: error });
    }
    if (error instanceof ToolGatewayApprovalRequiredError) {
      throw new HTTPException(409, { message: error.code, cause: error });
    }
    throw error;
  }
}

export async function approveWorkspaceToolGatewayCall(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  db: ApiRouteDeps["db"],
  input: unknown,
  issueApproval: typeof issueToolGatewayApproval = issueToolGatewayApproval,
  observability?: Observability,
  authorizeSiteTool: AuthorizeWorkspaceSiteTool = requireWorkspaceSiteToolAuthorization,
) {
  const request = ToolGatewayApprovalRequest.parse(input);
  if (request.catalogDigest !== prepared.toolGatewayCatalog.digest) {
    throw new HTTPException(409, { message: "catalog_stale" });
  }
  const entry = prepared.toolGatewayCatalog.entries.find(
    (candidate) =>
      candidate.identity.serverId === request.identity.serverId &&
      candidate.identity.toolName === request.identity.toolName,
  );
  if (!entry) throw new HTTPException(404, { message: "tool_not_found" });
  const siteContext =
    request.siteArtifactId && request.siteVersionId
      ? {
          siteArtifactId: request.siteArtifactId,
          siteVersionId: request.siteVersionId,
          identity: request.identity,
        }
      : null;
  if (siteContext) {
    await authorizeSiteTool(db, grant, siteContext);
  } else if (entry.approval !== "human") {
    throw new HTTPException(422, { message: "tool_does_not_require_human_approval" });
  }
  const observation = startWorkspaceToolGatewayObservation(observability, {
    adapter: "http",
    operation: "approval",
    source: entry.source,
  });
  const approvalToken = `ogta_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  try {
    await issueApproval(db, {
      tokenHash: hashOpaqueValue(approvalToken),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      operationId: request.operationId,
      catalogDigest: request.catalogDigest,
      identity: request.identity,
      argumentsDigest: digestCanonicalJson(request.arguments),
      ...(siteContext ? { siteVersionId: siteContext.siteVersionId } : {}),
      expiresAt,
    });
  } catch (error) {
    if (error instanceof ToolGatewayApprovalRateLimitError) {
      observation.end("rate_limited");
      throw new HTTPException(429, { message: "tool_approval_rate_limited", cause: error });
    }
    observation.end("failed");
    throw error;
  }
  observation.end("ok");
  return ToolGatewayApprovalResponse.parse({
    operationId: request.operationId,
    approvalToken,
    expiresAt: expiresAt.toISOString(),
  });
}

async function requireWorkspaceSiteToolAuthorization(
  db: ApiRouteDeps["db"],
  grant: AccessGrant,
  context: WorkspaceSiteToolContext,
): Promise<void> {
  try {
    const detail = await getWorkspaceArtifact(db, grant.workspaceId, context.siteArtifactId);
    const currentVersion = detail.artifact.currentVersion;
    const requested = currentVersion?.requestedTools.some(
      (identity) =>
        identity.serverId === context.identity.serverId &&
        identity.toolName === context.identity.toolName,
    );
    if (
      detail.artifact.status !== "active" ||
      currentVersion?.id !== context.siteVersionId ||
      !requested
    ) {
      throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
  } catch (error) {
    if (error instanceof WorkspaceArtifactNotFoundError) {
      throw new HTTPException(403, { message: "site_tool_not_authorized" });
    }
    throw error;
  }
}

function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function workspaceToolGatewayOutcome(error: unknown) {
  if (error instanceof ToolGatewayApprovalRequiredError) return "approval_required" as const;
  if (error instanceof ToolGatewayCatalogStaleError) return "catalog_stale" as const;
  if (error instanceof ToolGatewayInputValidationError) return "invalid_input" as const;
  if (error instanceof ToolGatewayToolNotFoundError) return "not_found" as const;
  return "failed" as const;
}

function allGatewayToolRefs(settings: Settings): ToolRef[] {
  return settings.mcpServers.map((server) => ({
    kind: "mcp" as const,
    id: server.id,
    ...(server.connectionRef ? { optional: true } : {}),
  }));
}

async function inMemoryMcpRegistration(
  id: string,
  server: McpServer,
): Promise<LocalMcpServerRegistration> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `opengeni-tool-gateway-${id}`, version: "1.0.0" });
  let connected = false;
  let closed = false;
  type RuntimeMcpServer = LocalMcpServerRegistration["server"];
  type RuntimeMcpTools = Awaited<ReturnType<RuntimeMcpServer["listTools"]>>;
  type RuntimeMcpCallResult = Awaited<ReturnType<NonNullable<RuntimeMcpServer["callToolResult"]>>>;
  return {
    id,
    server: {
      name: `opengeni-tool-gateway-local:${id}`,
      cacheToolsList: false,
      connect: async () => {
        if (closed) throw new Error(`Local MCP server ${id} is closed`);
        if (connected) return;
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        connected = true;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([client.close(), server.close()]);
      },
      listTools: async () => (await client.listTools()).tools as unknown as RuntimeMcpTools,
      callTool: async (toolName, args, _meta, options) =>
        (
          (await client.callTool(
            { name: toolName, arguments: args ?? {} },
            undefined,
            options?.signal ? { signal: options.signal } : undefined,
          )) as CallToolResult
        ).content,
      callToolResult: async (toolName, args, _meta, options) =>
        (await client.callTool(
          { name: toolName, arguments: args ?? {} },
          undefined,
          options?.signal ? { signal: options.signal } : undefined,
        )) as unknown as RuntimeMcpCallResult,
      invalidateToolsCache: async () => undefined,
    },
  };
}

export function toolGatewayCatalogResponse(catalog: ToolGatewayCatalog): ToolGatewayCatalog {
  return catalog;
}

export function workspaceToolGatewayDeclarations(
  prepared: PreparedWorkspaceToolGateway,
): ToolGatewayDeclarationsResponse {
  const moduleSpecifier = "@opengeni/sdk";
  return ToolGatewayDeclarationsResponse.parse({
    catalogDigest: prepared.toolGatewayCatalog.digest,
    moduleSpecifier,
    source: generateToolGatewayDeclarations(prepared.toolGatewayCatalog, { moduleSpecifier }),
  });
}
