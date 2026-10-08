import { afterAll, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import type { AccessGrant, ConnectionMetadata, ToolGatewayCatalog } from "@opengeni/contracts";
import type {
  ApiIntegrationRuntime,
  Database,
  ResolveConnectionCredentialInput,
} from "@opengeni/db";
import type { AccessGrantAuthorization, ApiRouteDeps } from "@opengeni/core";
import { startTestMcpServer, testSettings, type TestMcpServer } from "@opengeni/testing";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Only the fixture DB's inventory/catalog and credential IO are replaced. All
// other handles delegate to captured real functions because Bun module mocks
// persist across files. Gateway assembly, remote MCP transport, account route
// expansion, approval classification, and target selection are real.
const core = await import("@opengeni/core");
const dbModule = await import("@opengeni/db");
const real = {
  resolveWorkspaceCatalogSettings: core.resolveWorkspaceCatalogSettings,
  settingsWithEnabledCapabilityMcpServers: core.settingsWithEnabledCapabilityMcpServers,
  availableMcpAccountBindings: core.availableMcpAccountBindings,
  buildConnectionTokenResolver: dbModule.buildConnectionTokenResolver,
  listConnectorToolPermissionPolicies: dbModule.listConnectorToolPermissionPolicies,
};
type Fixture = {
  connections: ConnectionMetadata[];
  integrations: ApiIntegrationRuntime[];
  resolved: ResolveConnectionCredentialInput[];
};
const fixtures = new Map<Database, Fixture>();
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
          candidate.id === input.connectionRef.connectionId &&
          candidate.status === "active" &&
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
// First-party handlers built for fixture DBs report the server set they see.
const mcpServerModule = await import("../src/mcp/server");
const realBuildOpenGeniMcpServer = mcpServerModule.buildOpenGeniMcpServer;
mock.module("../src/mcp/server", () => ({
  ...mcpServerModule,
  buildOpenGeniMcpServer: (...args: Parameters<typeof realBuildOpenGeniMcpServer>) => {
    if (!fixtures.has(args[0].db)) return realBuildOpenGeniMcpServer(...args);
    const probe = new McpServer({ name: "first-party-probe", version: "1.0.0" });
    probe.registerTool("sessions_list", { description: "Report visible servers." }, async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(args[0].settings.mcpServers.map((server) => server.id)),
        },
      ],
    }));
    return probe;
  },
}));
const {
  callWorkspaceToolGatewayForCaller,
  prepareAttestedWorkspaceToolGateway,
  prepareWorkspaceToolGatewayForGrant,
  workspaceToolGatewayAttestationScope,
  workspaceToolGatewayServerTiming,
} = await import("../src/workspace-tool-gateway");
const { createWorkspaceToolGatewayCatalogAttestations } =
  await import("../src/workspace-tool-gateway-attestations");

afterAll(() => mock.restore());

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const subjectId = "human:target-call-test";
const otherSubjectId = "human:target-call-other";
const artifactId = "33333333-3333-4333-8333-333333333333";
const versionId = "44444444-4444-4444-8444-444444444444";

function grantFor(subject: string): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: subject,
    principalKind: "human_session",
    permissions: ["workspace:read"],
  };
}

// Route admission is covered by the gateway adapter tests; these tests inject
// the same grant-level preparation the route reaches after admission.
function authorizationFor(subject: string): AccessGrantAuthorization {
  return {
    grant: grantFor(subject),
    accountGrant: null,
    authenticatedSubjectId: subject,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
  };
}

const prepareForGrant = async (
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  options: {
    allowedIdentities?: readonly { serverId: string; toolName: string }[];
    firstPartySettings?: "prepared" | "caller";
  } = {},
) => {
  preparations.push(options.allowedIdentities ? "target" : "complete");
  return await prepareWorkspaceToolGatewayForGrant(
    deps,
    authorization.grant,
    options.allowedIdentities,
    options.firstPartySettings ? { firstPartySettings: options.firstPartySettings } : {},
  );
};
const preparations: Array<"target" | "complete"> = [];

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

type DelayedProvider = TestMcpServer & { extraTools: string[] };

/** A remote MCP provider whose every HTTP request takes `delayMs`. */
function delayedProvider(
  delayMs: number,
  options: { requireBearer?: boolean; baseTools?: string[] } = {},
) {
  const extraTools: string[] = [];
  const provider = startTestMcpServer({
    toolsForAuthorization: () => [...(options.baseTools ?? []), ...extraTools],
    validateAuthorization: async (value) => {
      if (delayMs > 0) await Bun.sleep(delayMs);
      return options.requireBearer ? value?.startsWith("Bearer ") === true : true;
    },
  });
  return Object.assign(provider, { extraTools }) as DelayedProvider;
}

function createFixture(
  input: { delayMs?: number; unrelatedConnectors?: number; firstParty?: boolean } = {},
) {
  const delayMs = input.delayMs ?? 0;
  const grafana = delayedProvider(delayMs, {
    requireBearer: true,
    baseTools: ["query_prometheus"],
  });
  const unrelated = Array.from({ length: input.unrelatedConnectors ?? 3 }, () =>
    delayedProvider(delayMs),
  );
  const database = {} as Database;
  const shared = createConnection("55555555-5555-4555-8555-555555555555", null);
  const personal = createConnection("66666666-6666-4666-8666-666666666666", subjectId);
  const foreign = createConnection("77777777-7777-4777-8777-777777777777", otherSubjectId);
  const state: Fixture = {
    integrations: [],
    connections: [shared, personal, foreign],
    resolved: [],
  };
  fixtures.set(database, state);
  const settings = testSettings({
    mcpServers: [
      {
        id: "grafana",
        url: grafana.url,
        cacheToolsList: false,
        allowedTools: ["query_prometheus"],
        connectionRef: {
          providerDomain: "127.0.0.1",
          kind: "api_key",
          accountSelection: "all_eligible",
        },
      },
      ...unrelated.map((provider, index) => ({
        id: `unrelated_${index}`,
        url: provider.url,
        cacheToolsList: false,
      })),
      ...(input.firstParty
        ? [{ id: "opengeni", url: "http://127.0.0.1:9/mcp", cacheToolsList: false }]
        : []),
    ],
  });
  const deps = { db: database, settings } as ApiRouteDeps;
  const identity = (connection: ConnectionMetadata) => ({
    serverId: core.mcpAccountRouteId("grafana", connection.id),
    toolName: "query_prometheus",
  });
  const unrelatedSetupRequests = () =>
    unrelated.reduce((total, provider) => total + provider.requests.length, 0);
  const resetRequests = () => {
    for (const provider of [grafana, ...unrelated]) {
      provider.requests.length = 0;
    }
    preparations.length = 0;
  };
  return {
    ...state,
    state,
    deps,
    settings,
    grafana,
    unrelated,
    shared,
    personal,
    foreign,
    identity,
    unrelatedSetupRequests,
    resetRequests,
    close: () => {
      fixtures.delete(database);
      for (const provider of [grafana, ...unrelated]) provider.close();
    },
  };
}

async function attestedCatalog(
  f: ReturnType<typeof createFixture>,
  attestations: ReturnType<typeof createWorkspaceToolGatewayCatalogAttestations>,
  authorization = authorizationFor(subjectId),
): Promise<ToolGatewayCatalog> {
  const prepared = await prepareAttestedWorkspaceToolGateway(
    f.deps,
    authorization,
    attestations,
    prepareForGrant,
  );
  try {
    return prepared.toolGatewayCatalog;
  } finally {
    await prepared.close();
  }
}

function call(
  f: ReturnType<typeof createFixture>,
  attestations: ReturnType<typeof createWorkspaceToolGatewayCatalogAttestations> | undefined,
  request: Parameters<typeof callWorkspaceToolGatewayForCaller>[2],
  options: {
    authorization?: AccessGrantAuthorization;
    authorizeSiteTool?: Parameters<
      typeof callWorkspaceToolGatewayForCaller
    >[3]["authorizeSiteTool"];
  } = {},
) {
  return callWorkspaceToolGatewayForCaller(
    f.deps,
    options.authorization ?? authorizationFor(subjectId),
    request,
    {
      ...(attestations ? { attestations } : {}),
      prepare: prepareForGrant,
      ...(options.authorizeSiteTool ? { authorizeSiteTool: options.authorizeSiteTool } : {}),
      resolveOrigin: async () => null,
    },
  );
}

async function expectHttpStatus(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught as { status?: number; details?: { code?: string } },
  );
  expect(error?.status).toBe(status);
  if (code) expect(error?.details?.code).toBe(code);
}

describe("target-only workspace tool calls", () => {
  test("a warm attested call connects only its target connector and echoes the caller digest", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      expect(catalog.entries.length).toBeGreaterThan(2);
      f.resetRequests();
      const { response, timing } = await call(f, attestations, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
      });
      expect(response.result.isError).not.toBe(true);
      expect(response.catalogDigest).toBe(catalog.digest);
      expect(timing).toMatchObject({ scope: "target", attestation: "hit" });
      expect(preparations).toEqual(["target"]);
      expect(f.unrelatedSetupRequests()).toBe(0);
      expect(f.grafana.calls).toEqual([{ tool: "query_prometheus", args: {} }]);
      expect(workspaceToolGatewayServerTiming(timing)).toMatch(
        /^gw-prepare;dur=\d+\.\d;desc="target\/hit", gw-call;dur=\d+\.\d$/u,
      );
    } finally {
      f.close();
    }
  });

  test("an unattested digest prepares completely, attests, and later calls are target-only", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      // A catalog from another replica/process: this process has no attestation.
      const catalog = await attestedCatalog(f, createWorkspaceToolGatewayCatalogAttestations());
      f.resetRequests();
      const first = await call(f, attestations, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
      });
      expect(first.timing).toMatchObject({ scope: "complete", attestation: "miss" });
      expect(first.response.catalogDigest).toBe(catalog.digest);
      expect(f.unrelatedSetupRequests()).toBeGreaterThan(0);
      f.resetRequests();
      const second = await call(f, attestations, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.personal),
        arguments: {},
      });
      expect(second.timing).toMatchObject({ scope: "target", attestation: "hit" });
      expect(f.unrelatedSetupRequests()).toBe(0);
      // Without an attestation store the route behaves exactly as before.
      f.resetRequests();
      const legacy = await call(f, undefined, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
      });
      expect(legacy.timing).toMatchObject({ scope: "complete", attestation: "bypass" });
      expect(f.unrelatedSetupRequests()).toBeGreaterThan(0);
    } finally {
      f.close();
    }
  });

  test("unrelated catalog drift keeps an unchanged entry callable; a removed target keeps the stale contract", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      f.unrelated[0]!.extraTools.push("newly_published_tool");
      const drifted = await prepareWorkspaceToolGatewayForGrant(f.deps, grantFor(subjectId));
      expect(drifted.toolGatewayCatalog.digest).not.toBe(catalog.digest);
      await drifted.close();
      const unchanged = await call(f, attestations, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
      });
      expect(unchanged.timing.scope).toBe("target");
      expect(unchanged.response.catalogDigest).toBe(catalog.digest);

      // The target becomes approval-classified: this connection-backed tool
      // has no provider preflight, so it leaves the current-human catalog.
      f.settings.mcpServers[0]!.requireApproval = ["query_prometheus"];
      const before = f.grafana.calls.length;
      f.resetRequests();
      await expectHttpStatus(
        call(f, attestations, {
          catalogDigest: catalog.digest,
          identity: f.identity(f.shared),
          arguments: {},
        }),
        409,
        "catalog_stale",
      );
      expect(preparations).toEqual(["target", "complete"]);
      expect(f.grafana.calls).toHaveLength(before);
    } finally {
      f.close();
    }
  });

  test("current account revocation fails closed and never substitutes a sibling account", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      expect(catalog.entries.map((entry) => entry.identity)).toContainEqual(f.identity(f.personal));
      f.personal.status = "revoked";
      f.resetRequests();
      f.state.resolved.length = 0;
      const before = f.grafana.calls.length;
      await expectHttpStatus(
        call(f, attestations, {
          catalogDigest: catalog.digest,
          identity: f.identity(f.personal),
          arguments: {},
        }),
        409,
        "catalog_stale",
      );
      expect(preparations).toEqual(["target", "complete"]);
      expect(f.grafana.calls).toHaveLength(before);
      expect(
        f.state.resolved.some((input) => input.connectionRef.connectionId === f.personal.id),
      ).toBe(false);
      // The still-active shared account remains callable through its own route.
      const shared = await call(f, attestations, {
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
      });
      expect(shared.response.result.isError).not.toBe(true);
    } finally {
      f.close();
    }
  });

  test("another caller never reuses an attestation or a personal account", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      const other = authorizationFor(otherSubjectId);
      expect(workspaceToolGatewayAttestationScope(other)).not.toBe(
        workspaceToolGatewayAttestationScope(authorizationFor(subjectId)),
      );
      f.resetRequests();
      f.state.resolved.length = 0;
      const before = f.grafana.calls.length;
      await expectHttpStatus(
        call(
          f,
          attestations,
          { catalogDigest: catalog.digest, identity: f.identity(f.personal), arguments: {} },
          { authorization: other },
        ),
        409,
        "catalog_stale",
      );
      expect(preparations).toEqual(["complete"]);
      expect(f.grafana.calls).toHaveLength(before);
      expect(
        f.state.resolved.some((input) => input.connectionRef.connectionId === f.personal.id),
      ).toBe(false);
      // Same digest from the other caller's own catalog is its own attestation.
      const otherCatalog = await attestedCatalog(f, attestations, other);
      expect(otherCatalog.digest).not.toBe(catalog.digest);
      const own = await call(
        f,
        attestations,
        { catalogDigest: otherCatalog.digest, identity: f.identity(f.foreign), arguments: {} },
        { authorization: other },
      );
      expect(own.timing.scope).toBe("target");
      expect(
        f.state.resolved
          .filter((input) => input.connectionRef.connectionId === f.foreign.id)
          .every((input) => input.subjectId === otherSubjectId),
      ).toBe(true);
    } finally {
      f.close();
    }
  });

  test("approval capabilities bypass target preparation; approval-classified targets still ask", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      f.resetRequests();
      const withToken = await call(f, attestations, {
        operationId: crypto.randomUUID(),
        catalogDigest: catalog.digest,
        identity: f.identity(f.shared),
        arguments: {},
        approvalToken: `ogta_${"a".repeat(43)}`,
      });
      expect(withToken.timing).toMatchObject({ scope: "complete", attestation: "bypass" });

      // Reclassifying a target changes its exact entry: the attested digest is
      // rejected as stale before execution, exactly like complete preparation.
      const unrelatedEntry = catalog.entries.find(
        (entry) =>
          entry.identity.serverId === "unrelated_1" &&
          entry.identity.toolName === "search_documents",
      )!;
      expect(unrelatedEntry.approval).toBe("policy");
      f.settings.mcpServers[2]!.requireApproval = true;
      f.resetRequests();
      await expectHttpStatus(
        call(f, attestations, {
          catalogDigest: catalog.digest,
          identity: unrelatedEntry.identity,
          arguments: { query: "x" },
        }),
        409,
        "catalog_stale",
      );
      expect(preparations).toEqual(["target", "complete"]);
      const approvalCatalog = await attestedCatalog(f, attestations);
      expect(
        approvalCatalog.entries.find(
          (entry) =>
            entry.identity.serverId === "unrelated_1" &&
            entry.identity.toolName === "search_documents",
        )?.approval,
      ).toBe("human");
      f.resetRequests();
      const error = await call(f, attestations, {
        catalogDigest: approvalCatalog.digest,
        identity: unrelatedEntry.identity,
        arguments: { query: "x" },
      }).then(
        () => null,
        (caught: { status?: number; message?: string }) => caught,
      );
      expect(error?.status).toBe(409);
      expect(error?.message).toBe("tool_gateway_approval_required");
      expect(preparations).toEqual(["target"]);
      expect(f.unrelated[1]!.calls).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  test("target calls still enforce the exact Site version allowlist and argument validation", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      const contexts: unknown[] = [];
      const before = f.grafana.calls.length;
      await expectHttpStatus(
        call(
          f,
          attestations,
          {
            catalogDigest: catalog.digest,
            identity: f.identity(f.shared),
            arguments: {},
            siteArtifactId: artifactId,
            siteVersionId: versionId,
          },
          {
            authorizeSiteTool: async (_db, _grant, context) => {
              contexts.push(context);
              throw Object.assign(new Error("site_tool_not_authorized"), { status: 403 });
            },
          },
        ),
        403,
      );
      expect(contexts).toEqual([
        { siteArtifactId: artifactId, siteVersionId: versionId, identity: f.identity(f.shared) },
      ]);
      expect(f.grafana.calls).toHaveLength(before);
      const unrelatedEntry = catalog.entries.find(
        (entry) =>
          entry.identity.serverId === "unrelated_0" &&
          entry.identity.toolName === "search_documents",
      )!;
      f.resetRequests();
      await expectHttpStatus(
        call(f, attestations, {
          catalogDigest: catalog.digest,
          identity: unrelatedEntry.identity,
          arguments: { query: 7 },
        }),
        422,
      );
      expect(preparations).toEqual(["target"]);
      expect(f.unrelated[0]!.calls).toHaveLength(0);
    } finally {
      f.close();
    }
  });

  test("first-party tools on a target call see the same caller settings as a complete call", async () => {
    const f = createFixture({ firstParty: true });
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      const identity = { serverId: "opengeni", toolName: "sessions_list" };
      expect(catalog.entries.map((entry) => entry.identity)).toContainEqual(identity);
      const visible = async (store: typeof attestations | undefined) => {
        const { response, timing } = await call(f, store, {
          catalogDigest: catalog.digest,
          identity,
          arguments: {},
        });
        const text = (response.result.content[0] as { text: string }).text;
        return { scope: timing.scope, servers: JSON.parse(text) as string[] };
      };
      const complete = await visible(undefined);
      const target = await visible(attestations);
      expect(complete.scope).toBe("complete");
      expect(target.scope).toBe("target");
      expect(target.servers).toEqual(complete.servers);
      expect(target.servers).toEqual(
        expect.arrayContaining(["opengeni", "unrelated_0", f.identity(f.shared).serverId]),
      );
      // MCP OAuth keeps its existing identity-narrowed first-party settings.
      const oauth = await prepareWorkspaceToolGatewayForGrant(f.deps, grantFor(subjectId), [
        identity,
      ]);
      try {
        const result = await oauth.toolGateway.call({
          operationId: crypto.randomUUID(),
          catalogDigest: oauth.toolGatewayCatalog.digest,
          identity,
          arguments: {},
          caller: { kind: "http", subjectId },
        });
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(["opengeni"]);
      } finally {
        await oauth.close();
      }
    } finally {
      f.close();
    }
  });

  test("failed calls still report their preparation split", async () => {
    const f = createFixture();
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      f.personal.status = "revoked";
      const reported: unknown[] = [];
      await expectHttpStatus(
        callWorkspaceToolGatewayForCaller(
          f.deps,
          authorizationFor(subjectId),
          { catalogDigest: catalog.digest, identity: f.identity(f.personal), arguments: {} },
          {
            attestations,
            prepare: prepareForGrant,
            onPreparation: (preparation) => reported.push(preparation),
          },
        ),
        409,
        "catalog_stale",
      );
      expect(reported).toEqual([
        expect.objectContaining({ scope: "complete", attestation: "mismatch" }),
      ]);
    } finally {
      f.close();
    }
  });

  test("concurrent target calls prepare independently and never share a prepared gateway", async () => {
    const f = createFixture({ delayMs: 5 });
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    try {
      const catalog = await attestedCatalog(f, attestations);
      f.resetRequests();
      const results = await Promise.all(
        [f.shared, f.personal, f.shared, f.personal].map((connection) =>
          call(f, attestations, {
            catalogDigest: catalog.digest,
            identity: f.identity(connection),
            arguments: {},
          }),
        ),
      );
      expect(results.every(({ timing }) => timing.scope === "target")).toBe(true);
      expect(preparations).toEqual(["target", "target", "target", "target"]);
      expect(f.unrelatedSetupRequests()).toBe(0);
      expect(f.grafana.calls).toHaveLength(4);
    } finally {
      f.close();
    }
  });
});

describe("catalog attestation store", () => {
  test("a changed target entry falls back to complete preparation and the stale contract", async () => {
    let description = "v1";
    const executed: string[] = [];
    const stubPrepare = async (
      _deps: ApiRouteDeps,
      _authorization: AccessGrantAuthorization,
      options: { allowedIdentities?: readonly { serverId: string; toolName: string }[] } = {},
    ) => {
      preparations.push(options.allowedIdentities ? "target" : "complete");
      const definitions = ["lookup", "other"]
        .map((toolName) => ({
          identity: { serverId: "inventory", toolName },
          modelName: `inventory__${toolName}`,
          description: toolName === "lookup" ? description : "stable",
          inputSchema: { type: "object" as const, properties: {} },
          source: "mcp" as const,
          approval: "none" as const,
          execute: async () => {
            executed.push(`${toolName}:${description}`);
            return { content: [] };
          },
        }))
        .filter(
          (definition) =>
            !options.allowedIdentities ||
            options.allowedIdentities.some(
              (identity) =>
                identity.serverId === definition.identity.serverId &&
                identity.toolName === definition.identity.toolName,
            ),
        );
      const { catalog, gateway } = createWorkspaceToolGateway({
        accountId,
        workspaceId,
        generation: 1,
        definitions,
      });
      return { toolGateway: gateway, toolGatewayCatalog: catalog, close: async () => undefined };
    };
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    const deps = { db: {} as Database } as ApiRouteDeps;
    const authorization = authorizationFor(subjectId);
    const prepared = await prepareAttestedWorkspaceToolGateway(
      deps,
      authorization,
      attestations,
      stubPrepare,
    );
    const digest = prepared.toolGatewayCatalog.digest;
    const request = {
      catalogDigest: digest,
      identity: { serverId: "inventory", toolName: "lookup" },
      arguments: {},
    };
    preparations.length = 0;
    const hit = await callWorkspaceToolGatewayForCaller(deps, authorization, request, {
      attestations,
      prepare: stubPrepare,
    });
    expect(hit.timing).toMatchObject({ scope: "target", attestation: "hit" });
    expect(hit.response.catalogDigest).toBe(digest);
    description = "v2";
    preparations.length = 0;
    const error = await callWorkspaceToolGatewayForCaller(deps, authorization, request, {
      attestations,
      prepare: stubPrepare,
    }).then(
      () => null,
      (caught: { status?: number; details?: { code?: string } }) => caught,
    );
    expect(error?.status).toBe(409);
    expect(error?.details?.code).toBe("catalog_stale");
    expect(preparations).toEqual(["target", "complete"]);
    expect(executed).toEqual(["lookup:v1"]);
  });

  const entry = (toolName: string, description = "d") => ({
    identity: { serverId: "s", toolName },
    description,
  });
  test("binds scope, digest, and exact entry content", () => {
    const store = createWorkspaceToolGatewayCatalogAttestations();
    store.record("a", { digest: "d1", entries: [entry("t")] as never });
    expect(store.entryDigest("a", "d1", { serverId: "s", toolName: "t" })).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(store.entryDigest("b", "d1", { serverId: "s", toolName: "t" })).toBeUndefined();
    expect(store.entryDigest("a", "d2", { serverId: "s", toolName: "t" })).toBeUndefined();
    expect(store.entryDigest("a", "d1", { serverId: "s", toolName: "u" })).toBeUndefined();
    store.record("a", { digest: "d3", entries: [entry("t", "changed")] as never });
    expect(store.entryDigest("a", "d3", { serverId: "s", toolName: "t" })).not.toBe(
      store.entryDigest("a", "d1", { serverId: "s", toolName: "t" }),
    );
  });

  test("sweeps expired catalogs and bounds retained entries globally", () => {
    let now = 0;
    const store = createWorkspaceToolGatewayCatalogAttestations({
      ttlMs: 1_000,
      maxEntries: 3,
      now: () => now,
    });
    const id = { serverId: "s", toolName: "t" };
    store.record("a", { digest: "d1", entries: [entry("t"), entry("u")] as never });
    expect(store.retainedEntries).toBe(2);
    now = 1_000;
    store.record("b", { digest: "d2", entries: [entry("t")] as never });
    expect(store.retainedEntries).toBe(1);
    now = 1_001;
    store.record("c", { digest: "d3", entries: [entry("t"), entry("u")] as never });
    expect(store.retainedEntries).toBe(3);
    store.record("d", { digest: "d4", entries: [entry("t")] as never });
    expect(store.retainedEntries).toBe(3);
    expect(store.entryDigest("b", "d2", id)).toBeUndefined();
    expect(store.entryDigest("d", "d4", id)).toBeDefined();
    store.record("e", {
      digest: "huge",
      entries: ["t", "u", "v", "w"].map((name) => entry(name)) as never,
    });
    expect(store.entryDigest("e", "huge", id)).toBeUndefined();
    expect(store.retainedEntries).toBeLessThanOrEqual(3);
  });

  test("expires on a fixed lifetime and bounds retained scopes and catalogs", () => {
    let now = 0;
    const store = createWorkspaceToolGatewayCatalogAttestations({
      ttlMs: 1_000,
      maxScopes: 2,
      maxCatalogsPerScope: 2,
      now: () => now,
    });
    const id = { serverId: "s", toolName: "t" };
    store.record("a", { digest: "d1", entries: [entry("t")] as never });
    now = 999;
    expect(store.entryDigest("a", "d1", id)).toBeDefined();
    now = 1_000;
    expect(store.entryDigest("a", "d1", id)).toBeUndefined();
    for (const digest of ["x1", "x2", "x3"]) {
      store.record("a", { digest, entries: [entry("t")] as never });
    }
    expect(store.entryDigest("a", "x1", id)).toBeUndefined();
    expect(store.entryDigest("a", "x3", id)).toBeDefined();
    store.record("b", { digest: "y", entries: [entry("t")] as never });
    store.record("c", { digest: "z", entries: [entry("t")] as never });
    expect(store.entryDigest("a", "x3", id)).toBeUndefined();
    expect(store.entryDigest("c", "z", id)).toBeDefined();
  });
});

describe("delayed-connector setup benchmark", () => {
  test("target-only calls remove unrelated connector setup from every call", async () => {
    const delayMs = 40;
    const f = createFixture({ delayMs, unrelatedConnectors: 6 });
    const attestations = createWorkspaceToolGatewayCatalogAttestations();
    const measure = async (label: string, store: typeof attestations | undefined, n: number) => {
      f.resetRequests();
      const startedAt = performance.now();
      const results = await Promise.all(
        Array.from({ length: n }, () =>
          call(f, store, {
            catalogDigest: catalog.digest,
            identity: f.identity(f.shared),
            arguments: {},
          }),
        ),
      );
      const wallMs = performance.now() - startedAt;
      const prepareMs = results.map(({ timing }) => timing.prepareMs);
      const sample = {
        label,
        parallelCalls: n,
        wallMs: Math.round(wallMs),
        meanPrepareMs: Math.round(prepareMs.reduce((a, b) => a + b, 0) / n),
        targetSetupRequests: f.grafana.requests.length,
        unrelatedSetupRequests: f.unrelatedSetupRequests(),
      };
      console.log(`[gateway setup benchmark] ${JSON.stringify(sample)}`);
      return sample;
    };
    let catalog: ToolGatewayCatalog;
    try {
      const catalogStartedAt = performance.now();
      catalog = await attestedCatalog(f, attestations);
      console.log(
        `[gateway setup benchmark] ${JSON.stringify({
          label: "complete catalog",
          wallMs: Math.round(performance.now() - catalogStartedAt),
          connectors: 7,
          perRequestDelayMs: delayMs,
        })}`,
      );
      for (const n of [1, 4, 9]) {
        const before = await measure("complete per call (before)", undefined, n);
        const after = await measure("target per call (after)", attestations, n);
        expect(before.unrelatedSetupRequests).toBeGreaterThan(0);
        expect(after.unrelatedSetupRequests).toBe(0);
        expect(after.targetSetupRequests).toBeLessThanOrEqual(before.targetSetupRequests);
      }
    } finally {
      f.close();
    }
  }, 120_000);
});
