import { describe, expect, test } from "bun:test";
import type { ApiIntegrationRuntime, ResolveConnectionCredentialResult } from "@opengeni/db";
import { prepareAgentTools } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";

import { buildApiIntegrationServersForTurn } from "../src/activities/api-integrations";

function integration(): ApiIntegrationRuntime {
  return {
    capabilityId: "api:inventory",
    pluginKey: "integration/inventory",
    pluginInstallationId: "11111111-2222-4333-8444-555555555555",
    installationVersion: 1,
    instanceId: "22222222-3333-4444-8555-666666666666",
    instanceKey: "default",
    displayName: "Inventory API",
    instanceVersion: 1,
    serverId: "inventory_api",
    name: "Inventory API",
    description: "Inventory operations.",
    protocol: "openapi",
    definitionId: "inventory",
    definitionProvenance: "workspace",
    baseUrl: "https://127.0.0.1/v1/",
    sourceUrl: "https://127.0.0.1/openapi.json",
    providerDomain: "127.0.0.1",
    authScheme: { kind: "oauth2" },
    connectionRef: {
      connectionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      providerDomain: "127.0.0.1",
      kind: "oauth2",
      scopes: ["inventory.read"],
      subjectScope: "workspace",
    },
    allowedTools: ["list_items"],
    requireApproval: [],
    revision: {
      id: "openapi:111111111111111111111111",
      protocol: "openapi",
      definitionId: "inventory",
      contentSha256: "1".repeat(64),
      source: { url: "https://127.0.0.1/openapi.json" },
      title: "Inventory API",
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List items.",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: "https://127.0.0.1/v1/",
          parameters: [],
        },
      },
    },
  };
}

const authority = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  rootSessionId: "session-root",
  turnId: "turn-1",
  attemptId: "attempt-1",
};

describe("installed API Integration worker adapters", () => {
  test("uses the exact attempt resolver, local MCP registry, and provider transport", async () => {
    const resolved: Array<{
      destinationUrl: string;
      credentialTarget: string | undefined;
      forceRefresh: boolean;
    }> = [];
    const requests: Array<{
      url: string;
      authorization: string | null;
      cookie: string | null;
    }> = [];
    let providerAuthorizations = 0;
    const item = integration();
    const settings = testSettings({
      mcpServers: [
        {
          id: item.serverId,
          name: item.name,
          url: item.baseUrl,
          allowedTools: item.allowedTools,
          cacheToolsList: true,
          requireApproval: item.requireApproval,
          connectionRef: item.connectionRef!,
        },
      ],
    });
    const localMcpServers = buildApiIntegrationServersForTurn({
      settings,
      integrations: [item],
      authority,
      resolveCredential: async (request): Promise<ResolveConnectionCredentialResult> => {
        resolved.push({
          destinationUrl: request.destinationUrl,
          credentialTarget: request.credentialTarget,
          forceRefresh: request.forceRefresh === true,
        });
        return {
          status: "ok",
          connectionId: item.connectionRef!.connectionId!,
          headers: { Authorization: "Bearer exact-attempt" },
          placements: [
            { carrier: "header", name: "Authorization", value: "Bearer exact-attempt" },
            { carrier: "query", name: "api_key", value: "query-secret" },
            { carrier: "cookie", name: "session_key", value: "cookie-secret" },
          ],
          authorizeProviderRequest: async () => {
            providerAuthorizations += 1;
            return true;
          },
        };
      },
      fetchImpl: async (request, init) => {
        requests.push({
          url: String(request),
          authorization: new Headers(init?.headers).get("authorization"),
          cookie: new Headers(init?.headers).get("cookie"),
        });
        return new Response(JSON.stringify({ items: ["one"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: item.serverId }], {
      localMcpServers,
    });
    try {
      expect(prepared.resolvedMcpConnectionIds.get(item.serverId)).toBe(
        item.connectionRef!.connectionId,
      );
      expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([
        "inventory_api__list_items",
      ]);
      const result = await prepared.mcpServers[0]!.callToolResult!("inventory_api__list_items", {});
      expect(result).toMatchObject({ isError: false });
      expect(resolved).toEqual([
        {
          destinationUrl: "https://127.0.0.1/v1/items",
          credentialTarget: "http_api",
          forceRefresh: false,
        },
      ]);
      expect(requests).toEqual([
        {
          url: "https://127.0.0.1/v1/items?api_key=query-secret",
          authorization: "Bearer exact-attempt",
          cookie: "session_key=cookie-secret",
        },
      ]);
      expect(providerAuthorizations).toBe(requests.length);
    } finally {
      await prepared.close();
    }
  });

  test("revalidates after credential resolution and denies before provider I/O", async () => {
    const item = integration();
    let providerCalls = 0;
    let providerAuthorizations = 0;
    const settings = testSettings({
      mcpServers: [
        {
          id: item.serverId,
          name: item.name,
          url: item.baseUrl,
          allowedTools: item.allowedTools,
          connectionRef: item.connectionRef!,
        },
      ],
    });
    const localMcpServers = buildApiIntegrationServersForTurn({
      settings,
      integrations: [item],
      authority,
      resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
        status: "ok",
        connectionId: item.connectionRef!.connectionId!,
        headers: { Authorization: "Bearer discarded" },
        authorizeProviderRequest: async () => {
          providerAuthorizations += 1;
          return false;
        },
      }),
      fetchImpl: async () => {
        providerCalls += 1;
        return Response.json({ items: [] });
      },
    });
    const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: item.serverId }], {
      localMcpServers,
    });
    try {
      const result = await prepared.mcpServers[0]!.callToolResult!("inventory_api__list_items", {});
      expect(result).toMatchObject({ isError: true });
      expect(providerAuthorizations).toBe(1);
      expect(providerCalls).toBe(0);
    } finally {
      await prepared.close();
    }
  });

  test("publishes bounded auth-needed state without invoking the provider", async () => {
    const item = integration();
    const authNeeded: unknown[] = [];
    let providerCalls = 0;
    const settings = testSettings({
      mcpServers: [
        {
          id: item.serverId,
          name: item.name,
          url: item.baseUrl,
          allowedTools: item.allowedTools,
          connectionRef: item.connectionRef!,
        },
      ],
    });
    const localMcpServers = buildApiIntegrationServersForTurn({
      settings,
      integrations: [item],
      authority,
      resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
        status: "auth_needed",
        reason: "expired",
        providerDomain: item.providerDomain,
        authoritySource: "host",
        connectionId: item.connectionRef!.connectionId,
        scopes: ["inventory.read"],
      }),
      onAuthNeeded: (payload) => {
        authNeeded.push(payload);
      },
      fetchImpl: async () => {
        providerCalls += 1;
        return new Response(null, { status: 500 });
      },
    });
    const prepared = await prepareAgentTools(
      settings,
      [{ kind: "mcp", id: item.serverId, optional: true }],
      { localMcpServers },
    );
    try {
      const result = await prepared.mcpServers[0]!.callToolResult!("inventory_api__list_items", {});
      expect(result).toMatchObject({ isError: true });
      expect(providerCalls).toBe(0);
      expect(authNeeded).toEqual([
        expect.objectContaining({
          serverId: "inventory_api",
          toolName: "list_items",
          reason: "expired",
          providerDomain: "127.0.0.1",
          authoritySource: "host",
        }),
      ]);
    } finally {
      await prepared.close();
    }
  });

  test("routes two instances of one definition through distinct tool namespaces and Connections", async () => {
    const finance = integration();
    const sales: ApiIntegrationRuntime = {
      ...finance,
      instanceId: "33333333-4444-4555-8666-777777777777",
      instanceKey: "sales",
      displayName: "Inventory — Sales",
      serverId: "inventory_sales_api",
      connectionRef: {
        ...finance.connectionRef!,
        connectionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      },
    };
    const settings = testSettings({
      mcpServers: [finance, sales].map((item) => ({
        id: item.serverId,
        name: item.name,
        url: item.baseUrl,
        allowedTools: item.allowedTools,
        connectionRef: item.connectionRef!,
      })),
    });
    const resolutions: Array<{ serverId: string; connectionId: string | undefined }> = [];
    const localMcpServers = buildApiIntegrationServersForTurn({
      settings,
      integrations: [finance, sales],
      authority,
      resolveCredential: async (request): Promise<ResolveConnectionCredentialResult> => {
        resolutions.push({
          serverId: request.serverId,
          connectionId: request.connectionRef.connectionId,
        });
        return {
          status: "ok",
          connectionId: request.connectionRef.connectionId!,
          headers: { Authorization: `Bearer ${request.connectionRef.connectionId}` },
        };
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: ["one"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const prepared = await prepareAgentTools(
      settings,
      [
        { kind: "mcp", id: finance.serverId },
        { kind: "mcp", id: sales.serverId },
      ],
      { localMcpServers },
    );
    try {
      expect(
        await Promise.all(
          prepared.mcpServers.map(async (server) =>
            (await server.listTools()).map((tool) => tool.name),
          ),
        ),
      ).toEqual([[`${finance.serverId}__list_items`], [`${sales.serverId}__list_items`]]);
      await prepared.mcpServers[0]!.callTool(`${finance.serverId}__list_items`, {});
      await prepared.mcpServers[1]!.callTool(`${sales.serverId}__list_items`, {});
      expect(resolutions).toEqual([
        {
          serverId: finance.serverId,
          connectionId: finance.connectionRef!.connectionId,
        },
        { serverId: sales.serverId, connectionId: sales.connectionRef!.connectionId },
      ]);
    } finally {
      await prepared.close();
    }
  });
});
