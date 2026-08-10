import { describe, expect, test } from "bun:test";
import { type Settings } from "@opengeni/config";
import { CapabilityCatalogItem, CapabilityInstallation } from "@opengeni/contracts";
import type { ApiIntegrationRuntime } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { applyCapabilityEnablement, settingsWithApiIntegrationServers } from "../src";

const revision: ApiIntegrationRuntime["revision"] = {
  id: "openapi:111111111111111111111111",
  protocol: "openapi",
  integrationId: "inventory",
  contentSha256: "1".repeat(64),
  source: { url: "https://inventory.example.com/openapi.json" },
  title: "Inventory API",
  tools: [
    {
      id: "list_items",
      operationKey: "listItems",
      name: "List items",
      description: "List inventory items.",
      inputSchema: { type: "object" },
      safety: "read",
      approvalMode: "never",
      deprecated: false,
    },
  ],
  bindings: {
    list_items: {
      method: "get",
      pathTemplate: "/items",
      serverUrl: "https://inventory.example.com/v1/",
      parameters: [],
    },
  },
};

function runtime(overrides: Partial<ApiIntegrationRuntime> = {}): ApiIntegrationRuntime {
  return {
    capabilityId: "api:inventory",
    pluginKey: "integration/inventory",
    pluginInstallationId: "11111111-1111-4111-8111-111111111111",
    installationVersion: 1,
    serverId: "inventory_api",
    name: "Inventory API",
    description: "Read inventory.",
    protocol: "openapi",
    baseUrl: "https://inventory.example.com/v1/",
    sourceUrl: "https://inventory.example.com/openapi.json",
    providerDomain: "inventory.example.com",
    connectionRef: {
      connectionId: "22222222-2222-4222-8222-222222222222",
      providerDomain: "inventory.example.com",
      kind: "api_key",
      subjectScope: "workspace",
    },
    allowedTools: ["list_items"],
    requireApproval: [],
    revision,
    ...overrides,
  };
}

describe("API Integration capability projection", () => {
  test("adds installed adapters to ordinary MCP settings without overriding deployment config", () => {
    const settings = testSettings({
      mcpServers: [
        {
          id: "deployment_server",
          name: "Deployment server",
          url: "https://deployment.example.com/mcp",
        },
        {
          id: "inventory_api",
          name: "Deployment-owned inventory",
          url: "https://deployment.example.com/inventory",
        },
      ],
    }) as Settings;

    const projected = settingsWithApiIntegrationServers(settings, [
      runtime(),
      runtime({
        capabilityId: "api:orders",
        pluginKey: "integration/orders",
        pluginInstallationId: "33333333-3333-4333-8333-333333333333",
        serverId: "orders_api",
        name: "Orders API",
        baseUrl: "https://orders.example.com/v2/",
        providerDomain: "orders.example.com",
        connectionRef: {
          providerDomain: "orders.example.com",
          kind: "oauth2",
          scopes: ["orders.read"],
          subjectScope: "subject",
        },
        requireApproval: true,
      }),
    ]);

    expect(projected.mcpServers).toHaveLength(settings.mcpServers.length + 1);
    expect(projected.mcpServers.find((server) => server.id === "inventory_api")).toEqual(
      settings.mcpServers.find((server) => server.id === "inventory_api"),
    );
    expect(projected.mcpServers.find((server) => server.id === "orders_api")).toEqual({
      id: "orders_api",
      name: "Orders API",
      url: "https://orders.example.com/v2/",
      allowedTools: ["list_items"],
      cacheToolsList: true,
      requireApproval: true,
      connectionRef: {
        providerDomain: "orders.example.com",
        kind: "oauth2",
        scopes: ["orders.read"],
        subjectScope: "subject",
      },
    });
  });

  test("projects a v2 Integration as enabled only from an executable active installation", () => {
    const item = CapabilityCatalogItem.parse({
      id: "api:inventory",
      kind: "api",
      source: "manual",
      name: "Inventory API",
      category: "integrations",
      runtime: {
        available: true,
        mcpServerId: "inventory_api",
        transport: "local-adapter",
      },
      metadata: {
        platformVersion: 2,
        pluginVersionId: "11111111-1111-4111-8111-111111111111",
        apiFacetId: "22222222-2222-4222-8222-222222222222",
        revisionId: revision.id,
        serverId: "inventory_api",
      },
    });
    const installation = CapabilityInstallation.parse({
      id: "33333333-3333-4333-8333-333333333333",
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "55555555-5555-4555-8555-555555555555",
      capabilityId: item.id,
      kind: "api",
      status: "active",
      config: { serverId: "inventory_api", allowedTools: ["list_items"] },
      metadata: {
        platformVersion: 2,
        pluginVersionId: "11111111-1111-4111-8111-111111111111",
        apiFacetId: "22222222-2222-4222-8222-222222222222",
        revisionId: revision.id,
        serverId: "inventory_api",
        connectionBound: true,
        connectionKind: "api_key",
        connectionOwnership: "subject",
        providerDomain: "inventory.example.com",
      },
      enabledAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(applyCapabilityEnablement(item, installation, new Set())).toMatchObject({
      enabled: true,
      enabledReason: "installed immutable Integration revision",
      connectionRef: {
        providerDomain: "inventory.example.com",
        kind: "api_key",
        subjectScope: "subject",
      },
    });
    expect(
      applyCapabilityEnablement(item, { ...installation, status: "disabled" }, new Set()),
    ).toMatchObject({ enabled: false, connectionRef: null });
  });
});