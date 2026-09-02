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
  ToolGatewayDeclarationsResponse,
  type AccessGrant,
  type ToolGatewayCatalog,
  type ToolRef,
} from "@opengeni/contracts";
import {
  buildApiIntegrationMcpServers,
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
  type ApiIntegrationRuntime,
} from "@opengeni/db";
import {
  prepareAgentTools,
  type LocalMcpServerRegistration,
  type PreparedAgentTools,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/runtime";
import {
  ToolGatewayApprovalRequiredError,
  ToolGatewayCatalogStaleError,
  ToolGatewayInputValidationError,
  ToolGatewayToolNotFoundError,
  generateToolGatewayDeclarations,
} from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";

import { buildDocumentsMcpServer } from "./mcp/documents";
import { buildFilesMcpServer } from "./mcp/files";
import { buildOpenGeniMcpServer } from "./mcp/server";

export type PreparedWorkspaceToolGateway = Pick<
  PreparedAgentTools,
  "toolGateway" | "toolGatewayCatalog" | "close"
> & {
  toolGateway: NonNullable<PreparedAgentTools["toolGateway"]>;
  toolGatewayCatalog: NonNullable<PreparedAgentTools["toolGatewayCatalog"]>;
};

export function grantUsesAttemptScopedMcp(grant: AccessGrant): boolean {
  return (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.delegated === true ||
    typeof grant.metadata?.sessionId === "string"
  );
}

export function requireWorkspaceToolGatewayGrant(grant: AccessGrant): void {
  if (grantUsesAttemptScopedMcp(grant) || grant.principalKind === "service") {
    throw new HTTPException(403, { message: "current-human tool access required" });
  }
}

export async function prepareWorkspaceToolGateway(
  routeDeps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
): Promise<PreparedWorkspaceToolGateway> {
  const grant = requireResolvedAccessGrantAuthorization(
    authorization,
    authorization.grant.workspaceId,
  );
  requireWorkspaceToolGatewayGrant(grant);
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
  const deps = { ...routeDeps, catalogSourceSettings, settings };
  const resolveConnection = buildConnectionTokenResolver(routeDeps.db, settings);
  const resolveCredential = async (
    input: ResolveConnectionCredentialInput,
  ): Promise<ResolveConnectionCredentialResult> =>
    await resolveConnection({
      ...input,
      ...(input.connectionRef.subjectScope === "subject" ? { subjectId: grant.subjectId } : {}),
    });
  const firstPartyServers = await Promise.all([
    inMemoryMcpRegistration("opengeni", buildOpenGeniMcpServer(deps, grant)),
    inMemoryMcpRegistration("files", buildFilesMcpServer(deps, grant)),
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
  ]);
  const apiIntegrationServers = buildApiIntegrationMcpServers({
    settings,
    integrations,
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
  const codexAppsCredentialId = await resolveCodexAppsCredentialIdForRun(
    routeDeps.db,
    grant.workspaceId,
  );
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
  const prepared = await prepareAgentTools(settings, allGatewayToolRefs(settings), {
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
    },
  });
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

export function buildWorkspaceToolGatewayMcpServer(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
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
    return (await prepared.toolGateway.call(
      {
        operationId: crypto.randomUUID(),
        catalogDigest: prepared.toolGatewayCatalog.digest,
        identity: entry.identity,
        arguments: request.params.arguments ?? {},
        caller: { kind: "mcp", subjectId: grant.subjectId },
      },
      { signal: extra.signal },
    )) as CallToolResult;
  });
  return server;
}

export async function callWorkspaceToolGateway(
  prepared: PreparedWorkspaceToolGateway,
  grant: AccessGrant,
  input: unknown,
) {
  const request = ToolGatewayCallRequest.parse(input);
  const operationId = request.operationId ?? crypto.randomUUID();
  try {
    const result = await prepared.toolGateway.call(
      {
        operationId,
        catalogDigest: request.catalogDigest,
        identity: request.identity,
        arguments: request.arguments,
        caller: { kind: "http", subjectId: grant.subjectId },
      },
      {
        transportMeta: { approvalConfirmed: request.approvalConfirmed === true },
      },
    );
    return ToolGatewayCallResponse.parse({
      operationId,
      catalogDigest: prepared.toolGatewayCatalog.digest,
      result,
    });
  } catch (error) {
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
