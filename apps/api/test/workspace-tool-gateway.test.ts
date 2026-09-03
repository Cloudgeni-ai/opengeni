import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import type { AccessGrant } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { ToolGatewayApprovalRateLimitError } from "@opengeni/db";
import { prepareWorkspaceToolGatewayTools } from "@opengeni/runtime/workspace-tool-gateway";
import { testSettings } from "@opengeni/testing";
import { createWorkspaceToolGateway, type ToolGatewayAuthorization } from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";
import { mcpOAuthConsentToolIdentities } from "../src/mcp-oauth";
import {
  buildWorkspaceToolGatewayMcpServer,
  approveWorkspaceToolGatewayCall,
  callWorkspaceToolGateway,
  requireWorkspaceToolGatewayGrant,
  workspaceToolGatewayDefinitionFilter,
  workspaceToolGatewaySettingsForGrant,
  workspaceToolGatewayDeclarations,
  type PreparedWorkspaceToolGateway,
} from "../src/workspace-tool-gateway";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "user:workspace-tool-gateway-test";

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read"],
    principalKind: "human_session",
    ...overrides,
  };
}

function preparedGateway(
  calls: Array<{ kind: string; argumentsValue: Record<string, unknown> }>,
  approval: "human" | "none" = "none",
  options: {
    authorize?: ToolGatewayAuthorization;
    onPreflight?: () => void;
    onExecute?: (context: { transportMeta?: Record<string, unknown> | null }) => void;
  } = {},
): PreparedWorkspaceToolGateway {
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId,
    workspaceId,
    generation: 1,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    definitions: [
      {
        identity: { serverId: "inventory", toolName: "lookup" },
        modelName: "inventory__lookup",
        codemodePath: ["inventory", "lookup"],
        title: "Inventory lookup",
        inputSchema: {
          type: "object",
          properties: { sku: { type: "string" } },
          required: ["sku"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
          additionalProperties: false,
        },
        source: "mcp",
        approval,
        ...(options.onPreflight
          ? {
              preflightCall: async () => {
                options.onPreflight?.();
              },
            }
          : {}),
        execute: async (argumentsValue, context) => {
          options.onExecute?.(context);
          calls.push({ kind: context.caller.kind, argumentsValue });
          return {
            content: [{ type: "text", text: JSON.stringify({ count: 7 }) }],
            structuredContent: { count: 7 },
          };
        },
      },
    ],
    requireApproval: (entry, _caller, context) =>
      entry.approval === "human" &&
      context.transportMeta?.approvalConfirmed !== true &&
      context.transportMeta?.siteApprovalBypass !== true,
    ...(options.authorize ? { authorize: options.authorize } : {}),
  });
  return {
    toolGateway: gateway,
    toolGatewayCatalog: catalog,
    close: async () => undefined,
  };
}

async function policyCeilingGateway(
  calls: Array<{ serverId: string; toolName: string }>,
): Promise<PreparedWorkspaceToolGateway> {
  const toolsByServer = {
    opengeni: ["session_get", "session_create"],
    files: ["files_get_download_url"],
    docs: ["search_documents"],
  } as const;
  const settings = testSettings({
    allowedFirstPartyMcpTools: ["session_get"],
    mcpServers: Object.keys(toolsByServer).map((id) => ({
      id,
      url: `https://${id}.example.test/mcp`,
      cacheToolsList: true,
    })),
  });
  const localMcpServers = Object.entries(toolsByServer).map(([serverId, toolNames]) => ({
    id: serverId,
    server: {
      name: `${serverId}-gateway-policy-test`,
      cacheToolsList: true,
      async connect() {},
      async close() {},
      async listTools() {
        return toolNames.map((toolName) => ({
          name: toolName,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        }));
      },
      async callTool(toolName) {
        calls.push({ serverId, toolName });
        return [{ type: "text" as const, text: `${serverId}:${toolName}` }];
      },
      async invalidateToolsCache() {},
    } satisfies MCPServer,
  }));
  const prepared = await prepareWorkspaceToolGatewayTools(
    settings,
    settings.mcpServers.map((server) => ({
      kind: "mcp" as const,
      id: server.id,
    })),
    {
      accountId,
      workspaceId,
      subjectId,
      localMcpServers,
      workspaceToolGateway: {
        createdAt: new Date("2026-09-03T00:00:00.000Z"),
        filterDefinition: workspaceToolGatewayDefinitionFilter(settings, [
          { serverId: "opengeni", toolName: "session_get" },
          { serverId: "opengeni", toolName: "session_create" },
          { serverId: "files", toolName: "files_get_download_url" },
          { serverId: "docs", toolName: "search_documents" },
        ]),
      },
    },
  );
  if (!prepared.toolGateway || !prepared.toolGatewayCatalog) {
    await prepared.close();
    throw new Error("test gateway preparation failed");
  }
  return {
    toolGateway: prepared.toolGateway,
    toolGatewayCatalog: prepared.toolGatewayCatalog,
    close: prepared.close,
  };
}

describe("workspace tool gateway adapters", () => {
  test("enforces the first-party ceiling across the production HTTP, MCP, and consent assembly", async () => {
    const calls: Array<{ serverId: string; toolName: string }> = [];
    const prepared = await policyCeilingGateway(calls);
    const access = grant({
      permissions: ["workspace:read", "documents:search", "files:read"],
    });
    const identities = [
      { serverId: "opengeni", toolName: "session_get" },
      { serverId: "files", toolName: "files_get_download_url" },
      { serverId: "docs", toolName: "search_documents" },
    ];
    expect(prepared.toolGatewayCatalog.entries.map((entry) => entry.identity)).toEqual(identities);
    expect(mcpOAuthConsentToolIdentities(prepared.toolGatewayCatalog)).toEqual(identities);

    const server = buildWorkspaceToolGatewayMcpServer(prepared, access);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "workspace-tool-gateway-policy-test",
      version: "1",
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "opengeni__session_get",
        "files__files_get_download_url",
        "docs__search_documents",
      ]);
      await client.callTool({ name: "opengeni__session_get", arguments: {} });
      await expect(
        client.callTool({ name: "opengeni__session_create", arguments: {} }),
      ).rejects.toThrow("Tool is not present in the active gateway catalog");

      await callWorkspaceToolGateway(prepared, access, {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: prepared.toolGatewayCatalog.digest,
        identity: { serverId: "files", toolName: "files_get_download_url" },
        arguments: {},
      });
      await expect(
        callWorkspaceToolGateway(prepared, access, {
          operationId: "44444444-4444-4444-8444-444444444444",
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: { serverId: "opengeni", toolName: "session_create" },
          arguments: {},
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(calls).toEqual([
        { serverId: "opengeni", toolName: "session_get" },
        { serverId: "files", toolName: "files_get_download_url" },
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close(), prepared.close()]);
    }
  });

  test("publishes and executes the same callable catalog through MCP and HTTP", async () => {
    const calls: Array<{
      kind: string;
      argumentsValue: Record<string, unknown>;
    }> = [];
    const prepared = preparedGateway(calls);
    const access = grant();
    const server = buildWorkspaceToolGatewayMcpServer(prepared, access);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "workspace-tool-gateway-test",
      version: "1",
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(1);
      expect(listed.tools[0]).toMatchObject({
        name: "inventory__lookup",
        title: "Inventory lookup",
        _meta: {
          "opengeni/identity": { serverId: "inventory", toolName: "lookup" },
          "opengeni/path": ["inventory", "lookup"],
          "opengeni/approval": "none",
          "opengeni/catalogDigest": prepared.toolGatewayCatalog.digest,
        },
      });
      const mcpResponse = await client.callTool({
        name: "inventory__lookup",
        arguments: { sku: "SKU-1" },
      });
      expect(mcpResponse).toMatchObject({ structuredContent: { count: 7 } });

      const response = await callWorkspaceToolGateway(prepared, access, {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: prepared.toolGatewayCatalog.digest,
        identity: { serverId: "inventory", toolName: "lookup" },
        arguments: { sku: "SKU-2" },
      });
      expect(response.result).toMatchObject({
        structuredContent: { count: 7 },
      });
      expect(calls).toEqual([
        { kind: "mcp", argumentsValue: { sku: "SKU-1" } },
        { kind: "http", argumentsValue: { sku: "SKU-2" } },
      ]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("does not advertise approval-required tools on MCP without an approval transport", async () => {
    const prepared = preparedGateway([], "human");
    const server = buildWorkspaceToolGatewayMcpServer(prepared, grant());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "workspace-tool-gateway-test",
      version: "1",
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      await expect(
        client.callTool({
          name: "inventory__lookup",
          arguments: { sku: "SKU-1" },
        }),
      ).rejects.toThrow("Tool is not present in the active gateway catalog");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test("keeps stale catalogs, unknown identities, and invalid arguments distinct", async () => {
    const prepared = preparedGateway([]);
    const access = grant();
    const base = {
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "SKU-1" },
    };
    await expect(
      callWorkspaceToolGateway(prepared, access, {
        ...base,
        catalogDigest: "a".repeat(64),
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      retryable: true,
      details: { code: "catalog_stale" },
    });
    await expect(
      callWorkspaceToolGateway(prepared, access, {
        ...base,
        identity: { serverId: "inventory", toolName: "missing" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    let consumedInvalidApproval = false;
    await expect(
      callWorkspaceToolGateway(
        prepared,
        access,
        {
          ...base,
          operationId: "33333333-3333-4333-8333-333333333333",
          arguments: {},
          approvalToken: `ogta_${"a".repeat(43)}`,
        },
        {} as never,
        async () => {
          consumedInvalidApproval = true;
          return true;
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(consumedInvalidApproval).toBe(false);
  });

  test("issues an opaque approval capability bound to the exact operation", async () => {
    const order: string[] = [];
    const prepared = preparedGateway([], "human", {
      authorize: () => {
        order.push("authorize");
      },
      onPreflight: () => {
        order.push("preflight");
      },
    });
    const access = grant();
    const issued: unknown[] = [];
    const response = await approveWorkspaceToolGatewayCall(
      prepared,
      access,
      {} as never,
      {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: prepared.toolGatewayCatalog.digest,
        identity: { serverId: "inventory", toolName: "lookup" },
        arguments: { sku: "SKU-2" },
      },
      async (_db, input) => {
        order.push("issue");
        issued.push(input);
      },
    );
    expect(response.operationId).toBe("33333333-3333-4333-8333-333333333333");
    expect(response.approvalToken).toMatch(/^ogta_[A-Za-z0-9_-]{43}$/u);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      accountId,
      workspaceId,
      subjectId,
      operationId: response.operationId,
      identity: { serverId: "inventory", toolName: "lookup" },
      approvalAuthorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(order).toEqual(["authorize", "preflight", "issue"]);
  });

  test("preflights approval input before issuing a single-use capability", async () => {
    const prepared = preparedGateway([], "human");
    let issueCalls = 0;
    await expect(
      approveWorkspaceToolGatewayCall(
        prepared,
        grant(),
        {} as never,
        {
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: { serverId: "inventory", toolName: "lookup" },
          arguments: {},
        },
        async () => {
          issueCalls += 1;
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(issueCalls).toBe(0);
  });

  test("preserves the approval issuance rate limit after preflight", async () => {
    const order: string[] = [];
    const prepared = preparedGateway([], "human", {
      authorize: () => {
        order.push("authorize");
      },
    });
    await expect(
      approveWorkspaceToolGatewayCall(
        prepared,
        grant(),
        {} as never,
        {
          operationId: "33333333-3333-4333-8333-333333333333",
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity: { serverId: "inventory", toolName: "lookup" },
          arguments: { sku: "RATE-LIMITED-1" },
        },
        async () => {
          order.push("issue");
          throw new ToolGatewayApprovalRateLimitError("Too many live tool approvals");
        },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(order).toEqual(["authorize", "issue"]);
  });

  test("still requires approval for a human-classified non-Site HTTP call", async () => {
    const calls: Array<{
      kind: string;
      argumentsValue: Record<string, unknown>;
    }> = [];
    const order: string[] = [];
    const prepared = preparedGateway(calls, "human", {
      authorize: () => {
        order.push("authorize");
      },
      onPreflight: () => {
        order.push("preflight");
      },
      onExecute: () => {
        order.push("execute");
      },
    });
    const access = grant();
    const request = {
      operationId: "33333333-3333-4333-8333-333333333333",
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "HUMAN-1" },
    };

    await expect(callWorkspaceToolGateway(prepared, access, request)).rejects.toMatchObject({
      status: 409,
    });

    const consumed: unknown[] = [];
    const response = await callWorkspaceToolGateway(
      prepared,
      access,
      { ...request, approvalToken: `ogta_${"a".repeat(43)}` },
      {} as never,
      async (_db, input) => {
        order.push("consume");
        consumed.push(input);
        return true;
      },
    );

    expect(response.result).toMatchObject({ structuredContent: { count: 7 } });
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      approvalAuthorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(calls).toEqual([{ kind: "http", argumentsValue: { sku: "HUMAN-1" } }]);
    expect(order).toEqual([
      "authorize",
      "preflight",
      "authorize",
      "preflight",
      "consume",
      "execute",
    ]);
  });

  test("does not consume or issue approval when gateway authorization fails", async () => {
    const prepared = preparedGateway([], "human", {
      authorize: () => {
        throw new HTTPException(403, { message: "tool_not_authorized" });
      },
    });
    const request = {
      operationId: "33333333-3333-4333-8333-333333333333",
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "DENIED-1" },
    };
    let consumeCalls = 0;
    await expect(
      callWorkspaceToolGateway(
        prepared,
        grant(),
        { ...request, approvalToken: `ogta_${"a".repeat(43)}` },
        {} as never,
        async () => {
          consumeCalls += 1;
          return true;
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(consumeCalls).toBe(0);

    let issueCalls = 0;
    await expect(
      approveWorkspaceToolGatewayCall(prepared, grant(), {} as never, request, async () => {
        issueCalls += 1;
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(issueCalls).toBe(0);
  });

  test("does not consume or issue approval when provider preflight fails", async () => {
    const prepared = preparedGateway([], "human", {
      onPreflight: () => {
        throw new HTTPException(403, {
          message: "provider_authorization_rejected",
        });
      },
    });
    const request = {
      operationId: "33333333-3333-4333-8333-333333333333",
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "DENIED-1" },
    };
    let consumeCalls = 0;
    await expect(
      callWorkspaceToolGateway(
        prepared,
        grant(),
        { ...request, approvalToken: `ogta_${"a".repeat(43)}` },
        {} as never,
        async () => {
          consumeCalls += 1;
          return true;
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(consumeCalls).toBe(0);

    let issueCalls = 0;
    await expect(
      approveWorkspaceToolGatewayCall(prepared, grant(), {} as never, request, async () => {
        issueCalls += 1;
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(issueCalls).toBe(0);
  });

  test("returns a typed retryable conflict when approval uses a stale catalog", async () => {
    const prepared = preparedGateway([], "human");
    await expect(
      approveWorkspaceToolGatewayCall(prepared, grant(), {} as never, {
        operationId: "33333333-3333-4333-8333-333333333333",
        catalogDigest: "a".repeat(64),
        identity: { serverId: "inventory", toolName: "lookup" },
        arguments: { sku: "SKU-2" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      retryable: true,
      details: { code: "catalog_stale" },
    });
  });

  test("lets an authorized Site call its immutable allowlist without per-call approval", async () => {
    const calls: Array<{
      kind: string;
      argumentsValue: Record<string, unknown>;
    }> = [];
    const order: string[] = [];
    let executeTransportMeta: Record<string, unknown> | null | undefined;
    const prepared = preparedGateway(calls, "human", {
      onPreflight: () => {
        order.push("preflight");
      },
      onExecute: (context) => {
        order.push("execute");
        executeTransportMeta = context.transportMeta;
      },
    });
    const access = grant();
    const site = {
      siteArtifactId: "44444444-4444-4444-8444-444444444444",
      siteVersionId: "55555555-5555-4555-8555-555555555555",
    };
    const authorizationChecks: unknown[] = [];
    const authorizeSiteTool = async (_db: never, _grant: AccessGrant, context: unknown) => {
      order.push("site_authorize");
      authorizationChecks.push(context);
    };
    const request = {
      operationId: "33333333-3333-4333-8333-333333333333",
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "SITE-1" },
      ...site,
    };

    const response = await callWorkspaceToolGateway(
      prepared,
      access,
      request,
      {} as never,
      async () => {
        throw new Error("Site calls must not consume approval capabilities");
      },
      undefined,
      authorizeSiteTool as never,
    );
    expect(response.result).toMatchObject({ structuredContent: { count: 7 } });
    expect(authorizationChecks).toEqual([
      {
        siteArtifactId: site.siteArtifactId,
        siteVersionId: site.siteVersionId,
        identity: request.identity,
      },
    ]);
    expect(calls).toEqual([{ kind: "http", argumentsValue: { sku: "SITE-1" } }]);
    expect(order).toEqual(["site_authorize", "preflight", "execute"]);
    expect(executeTransportMeta).toEqual({ siteApprovalBypass: true });
  });

  test("generates SDK declarations from the catalog exposed by the route adapter", () => {
    const prepared = preparedGateway([]);
    const declarations = workspaceToolGatewayDeclarations(prepared);
    expect(declarations.catalogDigest).toBe(prepared.toolGatewayCatalog.digest);
    expect(declarations.moduleSpecifier).toBe("@opengeni/sdk");
    expect(declarations.source).toContain("interface OpenGeniGeneratedTools");
    expect(declarations.source).toContain("readonly inventory:");
    expect(declarations.source).toContain("readonly sku: string");
  });

  test("rejects attempt-scoped and service grants from the human gateway", () => {
    expect(() =>
      requireWorkspaceToolGatewayGrant(
        grant({
          principalKind: "agent_attempt",
          metadata: { sessionId: "44444444-4444-4444-8444-444444444444" },
        }),
      ),
    ).toThrow(HTTPException);
    expect(() => requireWorkspaceToolGatewayGrant(grant({ principalKind: "service" }))).toThrow(
      HTTPException,
    );
    expect(() => requireWorkspaceToolGatewayGrant(grant({ principalKind: "api_key" }))).toThrow(
      HTTPException,
    );
    expect(() =>
      requireWorkspaceToolGatewayGrant(grant({ principalKind: "configured_key" })),
    ).toThrow(HTTPException);
    expect(() => requireWorkspaceToolGatewayGrant(grant())).not.toThrow();
  });

  test("filters unauthorized and out-of-resource servers before provider construction", () => {
    const settings = {
      mcpServers: [
        { id: "opengeni" },
        { id: "files" },
        { id: "docs" },
        { id: "unrelated-integration" },
      ],
    } as Settings;
    expect(
      workspaceToolGatewaySettingsForGrant(settings, grant()).mcpServers.map((server) => server.id),
    ).toEqual(["opengeni", "unrelated-integration"]);
    expect(
      workspaceToolGatewaySettingsForGrant(
        settings,
        grant({
          permissions: ["workspace:read", "documents:search", "files:read"],
        }),
        [{ serverId: "docs", toolName: "search_documents" }],
      ).mcpServers.map((server) => server.id),
    ).toEqual(["docs"]);
    expect(
      workspaceToolGatewayDefinitionFilter({ allowedFirstPartyMcpTools: [] })({
        identity: { serverId: "inventory", toolName: "write" },
        modelName: "inventory__write",
        inputSchema: { type: "object" },
        source: "mcp",
        approval: "human",
        execute: async () => ({ content: [] }),
      }),
    ).toBe(true);
    expect(
      workspaceToolGatewayDefinitionFilter({ allowedFirstPartyMcpTools: [] })({
        identity: { serverId: "inventory", toolName: "write" },
        modelName: "inventory__write",
        inputSchema: { type: "object" },
        source: "mcp",
        approval: "human",
        requiresProviderPreflight: true,
        execute: async () => ({ content: [] }),
      }),
    ).toBe(false);
    expect(
      workspaceToolGatewayDefinitionFilter({ allowedFirstPartyMcpTools: [] })({
        identity: { serverId: "inventory", toolName: "write" },
        modelName: "inventory__write",
        inputSchema: { type: "object" },
        source: "mcp",
        approval: "human",
        requiresProviderPreflight: true,
        preflightCall: async () => undefined,
        execute: async () => ({ content: [] }),
      }),
    ).toBe(true);
  });
});
