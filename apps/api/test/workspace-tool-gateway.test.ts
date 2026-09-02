import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";
import {
  buildWorkspaceToolGatewayMcpServer,
  approveWorkspaceToolGatewayCall,
  callWorkspaceToolGateway,
  requireWorkspaceToolGatewayGrant,
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
        execute: async (argumentsValue, context) => {
          calls.push({ kind: context.caller.kind, argumentsValue });
          return {
            content: [{ type: "text", text: JSON.stringify({ count: 7 }) }],
            structuredContent: { count: 7 },
          };
        },
      },
    ],
    requireApproval: (entry, _caller, context) =>
      entry.approval === "human" && context.transportMeta?.approvalConfirmed !== true,
  });
  return {
    toolGateway: gateway,
    toolGatewayCatalog: catalog,
    close: async () => undefined,
  };
}

describe("workspace tool gateway adapters", () => {
  test("publishes and executes the same callable catalog through MCP and HTTP", async () => {
    const calls: Array<{ kind: string; argumentsValue: Record<string, unknown> }> = [];
    const prepared = preparedGateway(calls);
    const access = grant();
    const server = buildWorkspaceToolGatewayMcpServer(prepared, access);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workspace-tool-gateway-test", version: "1" });
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
      expect(response.result).toMatchObject({ structuredContent: { count: 7 } });
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
    const client = new Client({ name: "workspace-tool-gateway-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([]);
      await expect(
        client.callTool({ name: "inventory__lookup", arguments: { sku: "SKU-1" } }),
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
        async () => true,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  test("issues an opaque approval capability bound to the exact operation", async () => {
    const prepared = preparedGateway([], "human");
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
    });
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

  test("requires viewer approval for every Site call and binds it to the exact Site version", async () => {
    const calls: Array<{ kind: string; argumentsValue: Record<string, unknown> }> = [];
    const prepared = preparedGateway(calls, "none");
    const access = grant();
    const site = {
      siteArtifactId: "44444444-4444-4444-8444-444444444444",
      siteVersionId: "55555555-5555-4555-8555-555555555555",
    };
    const authorizationChecks: unknown[] = [];
    const authorizeSiteTool = async (_db: never, _grant: AccessGrant, context: unknown) => {
      authorizationChecks.push(context);
    };
    const request = {
      operationId: "33333333-3333-4333-8333-333333333333",
      catalogDigest: prepared.toolGatewayCatalog.digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: { sku: "SITE-1" },
      ...site,
    };

    await expect(
      callWorkspaceToolGateway(
        prepared,
        access,
        request,
        {} as never,
        async () => false,
        undefined,
        authorizeSiteTool as never,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const issued: unknown[] = [];
    const approval = await approveWorkspaceToolGatewayCall(
      prepared,
      access,
      {} as never,
      request,
      async (_db, input) => {
        issued.push(input);
      },
      undefined,
      authorizeSiteTool as never,
    );
    expect(issued[0]).toMatchObject({ siteVersionId: site.siteVersionId });

    const response = await callWorkspaceToolGateway(
      prepared,
      access,
      { ...request, approvalToken: approval.approvalToken },
      {} as never,
      async (_db, input) => {
        expect(input).toMatchObject({ siteVersionId: site.siteVersionId });
        return true;
      },
      undefined,
      authorizeSiteTool as never,
    );
    expect(response.result).toMatchObject({ structuredContent: { count: 7 } });
    expect(authorizationChecks).toHaveLength(3);
    expect(calls).toEqual([{ kind: "http", argumentsValue: { sku: "SITE-1" } }]);
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
        grant({ permissions: ["workspace:read", "documents:search", "files:read"] }),
        [{ serverId: "docs", toolName: "search_documents" }],
      ).mcpServers.map((server) => server.id),
    ).toEqual(["docs"]);
  });
});
