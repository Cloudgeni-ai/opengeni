import { afterAll, expect, mock, test } from "bun:test";
import type { AccessGrant, ConnectionMetadata } from "@opengeni/contracts";
import type {
  ApiIntegrationRuntime,
  Database,
  ResolveConnectionCredentialInput,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { startTestMcpServer, testSettings } from "@opengeni/testing";
import { createSiteToolBridge } from "@opengeni/sdk/site";

// Only the fixture DB's inventory/catalog and credential IO are replaced. All
// other handles delegate to captured real functions because Bun module mocks
// persist across files. Gateway assembly, remote MCP, and Site filtering are real.
const core = await import("@opengeni/core");
const dbModule = await import("@opengeni/db");
const real = {
  resolveWorkspaceCatalogSettings: core.resolveWorkspaceCatalogSettings,
  settingsWithEnabledCapabilityMcpServers: core.settingsWithEnabledCapabilityMcpServers,
  availableMcpAccountBindings: core.availableMcpAccountBindings,
  buildConnectionTokenResolver: dbModule.buildConnectionTokenResolver,
  listConnectorToolPermissionPolicies: dbModule.listConnectorToolPermissionPolicies,
};
const fixtures = new Map<
  Database,
  {
    connections: ConnectionMetadata[];
    integrations: ApiIntegrationRuntime[];
    resolved: ResolveConnectionCredentialInput[];
  }
>();
mock.module("@opengeni/core", () => ({
  ...core,
  resolveWorkspaceCatalogSettings: async (
    ...args: Parameters<typeof real.resolveWorkspaceCatalogSettings>
  ) =>
    fixtures.has(args[0])
      ? { settings: args[1], source: "code", version: null, modelNotes: {} }
      : real.resolveWorkspaceCatalogSettings(...args),
  settingsWithEnabledCapabilityMcpServers: async (
    ...args: Parameters<typeof real.settingsWithEnabledCapabilityMcpServers>
  ) =>
    fixtures.has(args[0])
      ? (args[3]?.onResolvedApiIntegrations?.(fixtures.get(args[0])!.integrations), args[2])
      : real.settingsWithEnabledCapabilityMcpServers(...args),
  availableMcpAccountBindings: async (
    input: Parameters<typeof real.availableMcpAccountBindings>[0],
  ) => {
    const fixture = fixtures.get(input.db);
    if (!fixture) return real.availableMcpAccountBindings(input);
    return core.mcpAccountBindingsFromVisibleConnections({
      ...input,
      subjectId: input.source.kind === "subject" ? input.source.subjectId : null,
      servers: input.settings.mcpServers,
      connections: fixture.connections,
    });
  },
}));
mock.module("@opengeni/db", () => ({
  ...dbModule,
  listConnectorToolPermissionPolicies: (
    ...args: Parameters<typeof real.listConnectorToolPermissionPolicies>
  ) =>
    fixtures.has(args[0]) ? Promise.resolve([]) : real.listConnectorToolPermissionPolicies(...args),
  buildConnectionTokenResolver: (...args: Parameters<typeof real.buildConnectionTokenResolver>) => {
    const fixture = fixtures.get(args[0]);
    if (!fixture) return real.buildConnectionTokenResolver(...args);
    return async (input: ResolveConnectionCredentialInput) => {
      fixture.resolved.push(input);
      const connection = fixture.connections.find(
        (candidate) =>
          (candidate.id === input.connectionRef.connectionId ||
            (input.connectionRef.connectionId === undefined && candidate.subjectId === null)) &&
          candidate.status === "active" &&
          (input.expectedAuthorityGeneration === undefined ||
            input.expectedAuthorityGeneration === candidate.connectionAuthorityGeneration) &&
          (candidate.subjectId === null || candidate.subjectId === input.subjectId),
      );
      if (!connection)
        return {
          status: "auth_needed" as const,
          reason: "missing_connection" as const,
          providerDomain: input.connectionRef.providerDomain,
        };
      return {
        status: "ok" as const,
        connectionId: connection.id,
        headers: { authorization: `Bearer ${connection.id}` },
        authorizeProviderRequest: async () => connection.status === "active",
      };
    };
  },
}));
const {
  prepareWorkspaceToolGatewayForGrant,
  prepareMcpOAuthWorkspaceToolGateway,
  callWorkspaceToolGateway,
  approveWorkspaceToolGatewayCall,
} = await import("../src/workspace-tool-gateway");

afterAll(() => mock.restore());
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "human:gateway-account-test";
const artifactId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";
const access: AccessGrant = {
  accountId,
  workspaceId,
  subjectId,
  principalKind: "human_session",
  permissions: ["workspace:read"],
};

function createConnection(id: string, subject: string | null): ConnectionMetadata {
  return {
    id,
    accountId,
    workspaceId,
    subjectId: subject,
    authorityId: crypto.randomUUID(),
    providerDomain: "127.0.0.1",
    kind: "api_key",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { displayName: subject ? "Personal Grafana" : "Shared Grafana" },
    createdBySubjectId: subjectId,
    updatedBySubjectId: subjectId,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  };
}
function createFixture() {
  const authorizations: string[] = [];
  const provider = startTestMcpServer({
    toolsForAuthorization: () => ["query_prometheus"],
    validateAuthorization: (value) => {
      authorizations.push(value ?? "missing");
      return value?.startsWith("Bearer ") === true;
    },
  });
  const database = {} as Database;
  const shared = createConnection("55555555-5555-4555-8555-555555555555", null);
  const personal = createConnection("66666666-6666-4666-8666-666666666666", subjectId);
  const foreign = createConnection("77777777-7777-4777-8777-777777777777", "human:other");
  const state = {
    integrations: [] as ApiIntegrationRuntime[],
    connections: [shared, personal, foreign],
    resolved: [] as ResolveConnectionCredentialInput[],
  };
  fixtures.set(database, state);
  const settings = testSettings({
    mcpServers: [
      {
        id: "grafana",
        url: provider.url,
        cacheToolsList: false,
        allowedTools: ["query_prometheus"],
        connectionRef: {
          providerDomain: "127.0.0.1",
          kind: "api_key",
          accountSelection: "all_eligible",
        },
      },
    ],
  });
  const deps = { db: database, settings } as ApiRouteDeps;
  const identity = (connection: ConnectionMetadata) => ({
    serverId: core.mcpAccountRouteId("grafana", connection.id),
    toolName: "query_prometheus",
  });
  return {
    ...state,
    deps,
    settings,
    shared,
    personal,
    foreign,
    identity,
    authorizations,
    provider,
    close: () => {
      fixtures.delete(database);
      provider.close();
    },
  };
}

test("agent-authored Grafana account identities survive the live Site catalog and dispatch separately", async () => {
  const f = createFixture();
  const prepared = await prepareWorkspaceToolGatewayForGrant(f.deps, access);
  try {
    const authored = core
      .mcpAccountBindingsFromVisibleConnections({
        accountId,
        workspaceId,
        subjectId,
        servers: f.settings.mcpServers,
        connections: f.connections,
      })
      .map((binding) => ({ serverId: binding.serverId, toolName: "query_prometheus" }));
    const bridge = createSiteToolBridge({
      workspaceId,
      artifactId,
      siteVersionId: versionId,
      requestedTools: authored,
      workspaceTools: { $catalog: async () => prepared.toolGatewayCatalog },
      callTool: async ({ request }) =>
        callWorkspaceToolGateway(
          prepared,
          access,
          request,
          f.deps.db,
          undefined,
          undefined,
          async (_db, _grant, context) => {
            expect(context.siteVersionId).toBe(versionId);
            expect(authored).toContainEqual(context.identity);
          },
          async () => null,
        ),
    });
    const catalog = await bridge.catalog({ signal: new AbortController().signal });
    expect(catalog.entries.map((entry) => entry.identity)).toEqual(authored);
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.some((entry) => entry.identity.serverId === "grafana")).toBe(false);
    expect(
      catalog.entries.some((entry) => entry.identity.serverId === f.identity(f.foreign).serverId),
    ).toBe(false);
    for (const connection of [f.shared, f.personal]) {
      f.authorizations.length = 0;
      const result = await bridge.call(
        { catalogDigest: catalog.digest, identity: f.identity(connection), arguments: {} },
        { signal: new AbortController().signal },
      );
      expect(result.result.isError).not.toBe(true);
      expect(f.authorizations.length).toBeGreaterThan(0);
      expect(f.authorizations.every((value) => value === `Bearer ${connection.id}`)).toBe(true);
      expect(
        f.resolved
          .filter((input) => input.connectionRef.connectionId === connection.id)
          .every(
            (input) =>
              input.connectionRef.subjectScope ===
                (connection.subjectId ? "subject" : "workspace") &&
              (connection.subjectId === null || input.subjectId === connection.subjectId),
          ),
      ).toBe(true);
    }
    expect(f.provider.calls).toHaveLength(2);
  } finally {
    await prepared.close();
    f.close();
  }
});

test("OAuth intersects account routes after expansion and rejects canonical aliases", async () => {
  const f = createFixture();
  try {
    for (const requested of [
      [f.identity(f.personal)],
      [{ serverId: "grafana", toolName: "query_prometheus" }],
    ]) {
      const prepared = await prepareMcpOAuthWorkspaceToolGateway(
        f.deps,
        { ...access, metadata: { mcpOAuth: true } },
        requested,
      );
      try {
        expect(prepared.toolGatewayCatalog.entries.map((entry) => entry.identity)).toEqual(
          requested[0]!.serverId === "grafana" ? [] : requested,
        );
      } finally {
        await prepared.close();
      }
    }
  } finally {
    f.close();
  }
});

test("service projections omit personal accounts; revocation never substitutes a sibling account", async () => {
  const f = createFixture();
  for (const principalKind of ["api_key", "service"] as const) {
    const service = await prepareWorkspaceToolGatewayForGrant(f.deps, {
      ...access,
      subjectId: "api_key:service",
      principalKind,
    });
    try {
      expect(service.toolGatewayCatalog.entries.map((entry) => entry.identity)).toEqual([
        f.identity(f.shared),
      ]);
    } finally {
      await service.close();
    }
  }
  const old = await prepareWorkspaceToolGatewayForGrant(f.deps, access);
  try {
    const digest = old.toolGatewayCatalog.digest;
    f.personal.status = "revoked";
    const refreshed = await prepareWorkspaceToolGatewayForGrant(f.deps, access);
    try {
      expect(refreshed.toolGatewayCatalog.entries.map((entry) => entry.identity)).toEqual([
        f.identity(f.shared),
      ]);
      expect(refreshed.toolGatewayCatalog.digest).not.toBe(digest);
    } finally {
      await refreshed.close();
    }
    const before = f.provider.calls.length;
    const result = await callWorkspaceToolGateway(old, access, {
      catalogDigest: digest,
      identity: f.identity(f.personal),
      arguments: {},
    });
    expect(result.result.isError).toBe(true);
    expect(f.provider.calls).toHaveLength(before);
  } finally {
    await old.close();
    f.close();
  }
});

test("generated API accounts retain distinct connections and current approval generations", async () => {
  const f = createFixture();
  f.shared.connectionAuthorityGeneration = 11;
  f.personal.connectionAuthorityGeneration = 12;
  const server = f.settings.mcpServers[0]!;
  server.url = "https://127.0.0.1/v1/";
  server.requireApproval = true;
  server.allowedTools = ["list_items"];
  const item: ApiIntegrationRuntime = {
    capabilityId: "api:inventory",
    pluginKey: "integration/inventory",
    pluginInstallationId: crypto.randomUUID(),
    installationVersion: 1,
    instanceId: crypto.randomUUID(),
    instanceKey: "default",
    displayName: "Inventory API",
    instanceVersion: 1,
    serverId: server.id,
    name: "Inventory API",
    description: null,
    protocol: "openapi",
    definitionId: "inventory",
    definitionProvenance: "workspace",
    baseUrl: server.url,
    sourceUrl: null,
    providerDomain: "127.0.0.1",
    authScheme: { kind: "api_key" },
    connectionRef: server.connectionRef!,
    connectionAuthorityGeneration: 99,
    allowedTools: ["list_items"],
    requireApproval: true,
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
          approvalMode: "always",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: server.url,
          parameters: [],
        },
      },
    },
  };
  f.integrations.push(item);
  const prepared = await prepareWorkspaceToolGatewayForGrant(f.deps, access);
  try {
    expect(prepared.toolGatewayCatalog.entries).toHaveLength(2);
    const issued: unknown[] = [];
    for (const connection of [f.shared, f.personal]) {
      const identity = { ...f.identity(connection), toolName: "list_items" };
      await approveWorkspaceToolGatewayCall(
        prepared,
        access,
        f.deps.db,
        {
          operationId: crypto.randomUUID(),
          catalogDigest: prepared.toolGatewayCatalog.digest,
          identity,
          arguments: {},
        },
        async (_db, approval) => {
          issued.push(approval);
        },
      );
      expect(f.resolved).toContainEqual(
        expect.objectContaining({
          serverId: identity.serverId,
          connectionRef: expect.objectContaining({ connectionId: connection.id }),
          expectedAuthorityGeneration: connection.connectionAuthorityGeneration,
          credentialResolutionMode: "preflight",
        }),
      );
    }
    expect(issued).toHaveLength(2);
    expect(f.provider.calls).toHaveLength(0);
  } finally {
    await prepared.close();
    f.close();
  }
});
