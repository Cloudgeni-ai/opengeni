// opengeni:test-shared-postgres-exclusive
// The single live fence of a targeted tool request on real PostgreSQL: its
// cost at every physical provider request (flat in unrelated connectors),
// revocation at each boundary, replicas, deadlines, and the narrowed route
// reads matching the complete projection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import postgres from "postgres";
import {
  accessGrantAuthorizationFromContext,
  mcpAccountRouteId,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithEnabledCapabilityMcpServersForTargets,
  visibleMcpAccountConnections,
  visibleMcpAccountConnectionsByIds,
  type ApiRouteDeps,
} from "@opengeni/core";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  createManagedOrganization,
  createOrganizationApiKey,
  createOrganizationWorkspace,
  enableCapabilityInstallation,
  encryptEnvironmentValue,
  installApiIntegration,
  listEnabledMcpCapabilityServers,
  mcpServerIdForCapability,
  registerDbBinding,
  updateConnectorToolPermissionPolicies,
  upsertCapabilityCatalogItem,
  type ApiIntegrationRuntime,
  type Database,
  type DbClient,
  type InstallApiIntegrationInput,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { ToolGatewayApprovalRequiredError } from "@opengeni/tool-gateway";
import {
  acquireSharedTestDatabase,
  startTestMcpServer,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../../packages/db/src/lossless-json";
import { createApp } from "../src/app";
import { TargetAuthorityFence } from "../src/workspace-tool-target-fence";
import {
  invokeWorkspaceToolTarget,
  resolveWorkspaceToolTarget,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";

const encryptionKey = randomBytes(32).toString("base64");
let shared: SharedTestDatabase | null = null;
let seed: DbClient | null = null;
let driver: postgres.Sql | null = null;
let db: Database;
let recording = false;
const statements: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("target-fence");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  seed = createDb(shared.appUrl);
  // The application's pool (createDb's options) with a statement observer.
  driver = postgres(shared.appUrl, {
    max: 16,
    prepare: false,
    idle_timeout: 30,
    max_lifetime: 1800,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query) => {
      // The driver's one-time type discovery is not application work.
      if (recording && !/pg_catalog\.pg_type/i.test(query)) statements.push(query);
    },
  });
  db = drizzle(driver, { schema }) as unknown as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await driver?.end().catch(() => undefined);
  await seed?.close();
  await shared?.release();
}, 180_000);

/** A remote MCP provider that records each physical request's arrival. */
function startProvider() {
  const arrivals: { request: string; statementsBefore: number }[] = [];
  let pending: { method: string; change: () => Promise<unknown> } | undefined;
  let changedAt: number | undefined;
  const server = startTestMcpServer({
    validateAuthorization: async () => {
      const last = server.requests.at(-1);
      arrivals.push({
        request: `${last?.httpMethod ?? "?"} ${last?.jsonRpcMethod ?? "-"}`,
        statementsBefore: statements.length,
      });
      const due = pending;
      if (due && last?.jsonRpcMethod === due.method) {
        pending = undefined;
        // Committed before this request is answered: every later physical
        // request must observe it.
        await due.change();
        changedAt = server.requests.length;
      }
      return true;
    },
  });
  return {
    server,
    arrivals,
    /** Apply `change` once, while the provider is handling `method`. */
    at(method: string, change: () => Promise<unknown>) {
      pending = { method, change };
      changedAt = undefined;
    },
    /** Physical requests that arrived after the change was committed. */
    afterChange() {
      if (changedAt === undefined) throw new Error("the change was never applied");
      return server.requests.slice(changedAt).map((request) => request.jsonRpcMethod ?? "-");
    },
    reset() {
      arrivals.length = 0;
      server.requests.length = 0;
      server.calls.length = 0;
      pending = undefined;
      changedAt = undefined;
    },
  };
}
type Provider = ReturnType<typeof startProvider>;

function providerSettings(provider: Provider, extra: Record<string, unknown> = {}) {
  return testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: encryptionKey,
    ...extra,
    mcpServers: [
      {
        id: "grafana",
        url: provider.server.url,
        cacheToolsList: false,
        allowedTools: ["search_documents"],
        connectionRef: {
          providerDomain: "127.0.0.1",
          kind: "api_key",
          accountSelection: "all_eligible",
        },
      },
    ],
  });
}

function providerCredential(settings: ReturnType<typeof testSettings>) {
  return encryptEnvironmentValue(
    environmentsEncryptionKeyBytes(settings)!,
    JSON.stringify({ headers: { authorization: "Bearer fence-provider-token" } }),
  );
}

function integrationInput(
  grant: { accountId: string; workspaceId: string; subjectId: string },
  suffix: string,
  serverId = `${suffix.replaceAll("-", "_")}_api`,
): InstallApiIntegrationInput {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    capabilityId: `api:${suffix}`,
    pluginKey: `integration/${suffix}`,
    serverId,
    name: `Inventory ${suffix}`,
    description: "Read inventory.",
    category: "operations",
    tags: ["inventory", "openapi"],
    definitionId: suffix,
    definitionProvenance: "workspace",
    providerDomain: "inventory.example.com",
    protocol: "openapi",
    baseUrl: "https://inventory.example.com/v1/",
    sourceUrl: "https://inventory.example.com/openapi.json",
    authScheme: { kind: "none" },
    requiredScopes: [],
    ownership: "workspace",
    revision: {
      id: "openapi:111111111111111111111111",
      protocol: "openapi",
      definitionId: suffix,
      contentSha256: "1".repeat(64),
      source: { url: "https://inventory.example.com/openapi.json" },
      title: "Inventory API",
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List inventory items.",
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
          serverUrl: "https://inventory.example.com/v1/",
          parameters: [],
        },
      },
    },
  };
}

async function mcpCapability(
  grant: { accountId: string; workspaceId: string },
  capabilityId: string,
  metadata: Record<string, unknown> = {},
) {
  await upsertCapabilityCatalogItem(seed!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    id: capabilityId,
    kind: "mcp",
    source: "manual",
    name: capabilityId,
    endpointUrl: `https://${capabilityId.replaceAll(/[^a-z0-9]+/g, "-")}.example/mcp`,
    category: "custom",
    tags: ["mcp"],
    metadata,
  });
  await enableCapabilityInstallation(seed!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    capabilityId,
    kind: "mcp",
    metadata: { mcpConnectivity: { status: "ok" } },
  });
}

async function sharedWorkspace() {
  const suffix = crypto.randomUUID();
  return await bootstrapWorkspace(seed!.db, {
    accountExternalSource: "target-fence",
    accountExternalId: suffix,
    accountName: "Target fence",
    workspaceExternalSource: "target-fence",
    workspaceExternalId: suffix,
    workspaceName: "Target fence",
    subjectId: `human:${suffix}`,
  });
}

/** An organization key (workspace:read) and its targeted requests on any replica. */
async function organizationCaller(
  grant: { accountId: string; workspaceId: string },
  settings: ReturnType<typeof testSettings>,
  identity: { serverId: string; toolName: string },
) {
  const bearer = `ogk_fence_${crypto.randomUUID().replaceAll("-", "")}`;
  const key = await createOrganizationApiKey(seed!.db, {
    accountId: grant.accountId,
    name: "Target fence key",
    prefix: bearer.slice(0, 12),
    keyHash: createHash("sha256").update(bearer).digest("hex"),
    permissions: ["workspace:read"],
  });
  const app = () =>
    createApp({
      settings,
      db,
      bus: {} as never,
      workflowClient: {} as never,
      objectStorage: null,
    });
  const send = (replica: ReturnType<typeof app>, operation: "resolve" | "invoke") =>
    replica.request(`http://localhost/v1/workspaces/${grant.workspaceId}/tools/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(
        operation === "resolve"
          ? { target: { identity } }
          : {
              target: { identity },
              operationId: crypto.randomUUID(),
              arguments: { query: "vector(1)" },
            },
      ),
    });
  return {
    keyId: key.id,
    app,
    resolve: (replica: ReturnType<typeof app>) => send(replica, "resolve"),
    invoke: (replica: ReturnType<typeof app>) => send(replica, "invoke"),
  };
}

/** A shared workspace, its Grafana-like account, and an organization key. */
async function serviceFixture(provider: Provider, unrelated = 0) {
  const access = await sharedWorkspace();
  const grant = access.workspaceGrants[0]!;
  const settings = providerSettings(provider);
  const connection = await createConnection(seed!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    providerDomain: "127.0.0.1",
    kind: "api_key",
    credentialEncrypted: providerCredential(settings),
    metadata: { displayName: "Shared Grafana" },
    createdBySubjectId: grant.subjectId,
  });
  // Unrelated eligible accounts of the same connector, MCP connectors and API
  // integrations: preparation reads them once, no fence evaluation does.
  for (let index = 0; index < unrelated; index++) {
    await createConnection(seed!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      providerDomain: "127.0.0.1",
      kind: "api_key",
      credentialEncrypted: providerCredential(settings),
      metadata: { displayName: `Other Grafana ${index}` },
      createdBySubjectId: grant.subjectId,
    });
    await mcpCapability(grant, `mcp:fence-unrelated-${index}`);
    await installApiIntegration(seed!.db, integrationInput(grant, `fence-unrelated-${index}`));
  }
  const identity = {
    serverId: mcpAccountRouteId("grafana", connection.id),
    toolName: "search_documents",
  };
  const caller = await organizationCaller(grant, settings, identity);
  return { access, grant, settings, connection, identity, ...caller };
}

/**
 * The same provider as a connector without a connection: a header-
 * authenticated static server, or an enabled MCP capability. Its transport
 * requests carry no credential step, so the transport boundary is fenced.
 */
async function transportFixture(provider: Provider, kind: "static" | "capability") {
  const access = await sharedWorkspace();
  const grant = access.workspaceGrants[0]!;
  const tools = { allowedTools: ["search_documents"], cacheToolsList: false };
  const settings = testSettings({
    productAccessMode: "configured",
    environmentsEncryptionKey: encryptionKey,
    mcpServers:
      kind === "static"
        ? [
            {
              id: "grafana_static",
              url: provider.server.url,
              headers: { authorization: "Bearer fence-static-token" },
              ...tools,
            },
          ]
        : [],
  });
  const capabilityId = "mcp:fence-transport-grafana";
  if (kind === "capability") {
    await upsertCapabilityCatalogItem(seed!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Grafana capability",
      endpointUrl: provider.server.url,
      category: "custom",
      tags: ["mcp"],
      metadata: tools,
    });
    await enableCapabilityInstallation(seed!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: { mcpConnectivity: { status: "ok" } },
    });
  }
  const identity = {
    serverId: kind === "static" ? "grafana_static" : mcpServerIdForCapability(capabilityId, tools),
    toolName: "search_documents",
  };
  const caller = await organizationCaller(grant, settings, identity);
  return { grant, capabilityId, identity, ...caller };
}

/** Statements of one request, split at its first physical provider request. */
async function measure(provider: Provider, run: () => Promise<Response>) {
  provider.reset();
  statements.length = 0;
  recording = true;
  const response = await run().finally(() => {
    recording = false;
  });
  const body = await response.text();
  const all = [...statements];
  const first = provider.arrivals[0]?.statementsBefore ?? all.length;
  const timing = response.headers.get("server-timing") ?? "";
  return {
    status: response.status,
    body,
    statements: all,
    physicalRequests: provider.arrivals.map((arrival) => arrival.request),
    /** Admission, preparation and the first boundary. */
    beforeFirstRequest: first,
    /** Every later boundary and application step: independent of interleaving. */
    afterFirstRequest: all.length - first,
    transactions: all.filter((query) => /^\s*begin\b/i.test(query)).length,
    fenceEvaluations: Number(/gw-fence;dur=[\d.]+;desc="(\d+)"/.exec(timing)?.[1] ?? Number.NaN),
  };
}

const keyReads = (all: readonly string[]) =>
  all.filter((query) => /from api_keys k\s+where/i.test(query)).length;
const apiKeyWrites = (all: readonly string[]) =>
  all.filter((query) => /^\s*update\s+"?api_keys"?/i.test(query)).length;
const apiKeyLocks = (all: readonly string[]) =>
  all.filter((query) =>
    /\bapi_keys\b[\s\S]*\bfor\s+(update|share|no key update|key share)\b/i.test(query),
  ).length;

describe("targeted tool fence on PostgreSQL", () => {
  test("each physical request costs the same, independent of unrelated connectors, and reads the key without locks or writes", async () => {
    if (!shared) return;
    const provider = startProvider();
    try {
      const profiles: Awaited<ReturnType<typeof measure>>[] = [];
      for (const unrelated of [0, 10, 50]) {
        const fixture = await serviceFixture(provider, unrelated);
        const replica = fixture.app();
        const cold = await measure(provider, () => fixture.invoke(replica));
        const warm = await measure(provider, () => fixture.invoke(replica));
        for (const result of [cold, warm]) {
          expect(result.status).toBe(200);
          expect(result.physicalRequests).toContain("POST tools/call");
          // One full evaluation per physical request plus the caller check
          // before each credential step, admission and two application
          // fences; each reads the key once, in one lock-free statement.
          expect(keyReads(result.statements)).toBe(result.fenceEvaluations);
          expect(result.fenceEvaluations).toBe(2 * result.physicalRequests.length + 3);
          // Admission records use once; no fence locks or writes the key.
          expect(apiKeyWrites(result.statements)).toBe(1);
          expect(apiKeyLocks(result.statements)).toBeLessThanOrEqual(1);
          // Budget: main paid 634 to 1411 statements per boundary.
          expect(result.afterFirstRequest / result.physicalRequests.length).toBeLessThan(150);
        }
        // A cold replica pays exactly what a warm one does after admission.
        expect(cold.afterFirstRequest).toBe(warm.afterFirstRequest);
        // Resolve: the same boundaries, then one fence before disclosure.
        const resolved = await measure(provider, () => fixture.resolve(replica));
        expect(resolved.status).toBe(200);
        expect(keyReads(resolved.statements)).toBe(resolved.fenceEvaluations);
        expect(resolved.fenceEvaluations).toBe(2 * resolved.physicalRequests.length + 2);
        expect(apiKeyWrites(resolved.statements)).toBe(1);
        expect(resolved.afterFirstRequest / resolved.physicalRequests.length).toBeLessThan(150);
        profiles.push(warm);
      }
      // Unrelated accounts, connectors and integrations cost nothing per boundary.
      expect(profiles.map((profile) => profile.afterFirstRequest)).toEqual(
        profiles.map(() => profiles[0]!.afterFirstRequest),
      );
      expect(profiles.map((profile) => profile.transactions - profiles[0]!.transactions)).toEqual([
        0, 0, 0,
      ]);
    } finally {
      provider.server.close();
    }
  }, 300_000);

  const changes: Record<
    string,
    {
      statuses: number[];
      apply: (fixture: Awaited<ReturnType<typeof serviceFixture>>) => Promise<unknown>;
    }
  > = {
    "key revoked": {
      statuses: [401, 403],
      apply: async (fixture) =>
        await shared!
          .admin`update api_keys set revoked_at = now() where id = ${fixture.keyId}::uuid`,
    },
    "key expired": {
      statuses: [401, 403],
      apply: async (fixture) =>
        await shared!.admin`update api_keys set expires_at = now() - interval '1 second'
          where id = ${fixture.keyId}::uuid`,
    },
    "key permissions narrowed": {
      statuses: [403],
      apply: async (fixture) =>
        await shared!
          .admin`update api_keys set permissions = '[]'::jsonb, permission_mode = 'explicit'
          where id = ${fixture.keyId}::uuid`,
    },
    "key removed from the workspace scope": {
      statuses: [403],
      apply: async (fixture) =>
        await shared!
          .admin`update api_keys set permission_mode = 'explicit', workspace_scope = 'selected'
          where id = ${fixture.keyId}::uuid`,
    },
    "connection deactivated": {
      statuses: [403, 404],
      apply: async (fixture) =>
        await shared!.admin`update connections set status = 'revoked'
          where id = ${fixture.connection.id}::uuid`,
    },
    "connection relabelled": {
      statuses: [403],
      apply: async (fixture) =>
        await shared!.admin`update connections
          set metadata = metadata || '{"displayName":"Renamed Grafana"}'::jsonb
          where id = ${fixture.connection.id}::uuid`,
    },
  };

  test.each(Object.keys(changes))(
    "%s at any boundary stops every later physical request",
    async (name) => {
      if (!shared) return;
      const change = changes[name]!;
      const provider = startProvider();
      try {
        for (const boundary of ["initialize", "notifications/initialized", "tools/list"]) {
          const fixture = await serviceFixture(provider);
          const replica = fixture.app();
          provider.reset();
          provider.at(boundary, async () => await change.apply(fixture));
          const response = await fixture.invoke(replica);
          const body = await response.text();
          expect([boundary, response.status, change.statuses.includes(response.status)]).toEqual([
            boundary,
            response.status,
            true,
          ]);
          expect(body).not.toContain("Grafana");
          // The SSE GET may race tools/list with a decision taken before the change.
          expect(provider.afterChange().filter((method) => method !== "-")).toEqual([]);
          expect(provider.server.calls).toHaveLength(0);
        }
      } finally {
        provider.server.close();
      }
    },
    300_000,
  );

  test.each(["static", "capability"] as const)(
    "a %s connector without a connection is fenced once at each transport request",
    async (kind) => {
      if (!shared) return;
      const provider = startProvider();
      try {
        const fixture = await transportFixture(provider, kind);
        const replica = fixture.app();
        for (const [run, applicationFences] of [
          [fixture.resolve, 2],
          [fixture.invoke, 3],
        ] as const) {
          const result = await measure(provider, () => run(replica));
          expect(result.status).toBe(200);
          // No credential step: exactly one full evaluation per physical
          // request, plus admission and the application fences.
          expect(result.fenceEvaluations).toBe(result.physicalRequests.length + applicationFences);
          expect(keyReads(result.statements)).toBe(result.fenceEvaluations);
          expect(result.afterFirstRequest / result.physicalRequests.length).toBeLessThan(150);
        }
        expect(provider.server.calls).toHaveLength(1);

        const revocations: Record<string, (target: typeof fixture) => Promise<unknown>> = {
          "key revoked": async (target) =>
            await shared!
              .admin`update api_keys set revoked_at = now() where id = ${target.keyId}::uuid`,
          ...(kind === "capability"
            ? {
                "installation disabled": async (target: typeof fixture) =>
                  await shared!.admin`update capability_installations set status = 'disabled'
                    where workspace_id = ${target.grant.workspaceId}::uuid
                      and capability_id = ${target.capabilityId}`,
              }
            : {}),
        };
        for (const boundary of ["initialize", "notifications/initialized", "tools/list"]) {
          for (const [name, apply] of Object.entries(revocations)) {
            const target = await transportFixture(provider, kind);
            provider.reset();
            provider.at(boundary, async () => await apply(target));
            const response = await target.invoke(target.app());
            // A required connector fails preparation: the recorded denial is
            // reported, never a 500 or an opaque missing tool.
            expect([boundary, name, [401, 403].includes(response.status)]).toEqual([
              boundary,
              name,
              true,
            ]);
            expect(provider.afterChange().filter((method) => method !== "-")).toEqual([]);
            expect(provider.server.calls).toHaveLength(0);
          }
        }
      } finally {
        provider.server.close();
      }
    },
    300_000,
  );

  test("replicas share no authority state, warm or cold", async () => {
    if (!shared) return;
    const provider = startProvider();
    try {
      const fixture = await serviceFixture(provider);
      const first = fixture.app();
      const second = fixture.app();
      expect((await fixture.invoke(second)).status).toBe(200);
      provider.reset();
      provider.at(
        "tools/list",
        async () =>
          await shared!
            .admin`update api_keys set revoked_at = now() where id = ${fixture.keyId}::uuid`,
      );
      const inFlight = await fixture.invoke(first);
      expect([401, 403]).toContain(inFlight.status);
      expect(provider.server.calls).toHaveLength(0);
      // The warm replica and a cold one both read the revocation at admission.
      expect((await fixture.invoke(second)).status).toBe(401);
      expect((await fixture.invoke(fixture.app())).status).toBe(401);
      expect(provider.server.calls).toHaveLength(0);
    } finally {
      provider.server.close();
    }
  }, 120_000);

  test("policy changes are fenced before begin, before execute and at the tools/call request", async () => {
    if (!shared) return;
    const provider = startProvider();
    try {
      const fixture = await serviceFixture(provider);
      const authorization = accessGrantAuthorizationFromContext(fixture.access, fixture.grant);
      authorization.canonicalManagedHumanSession = true;
      const deps = { db, settings: fixture.settings } as ApiRouteDeps;
      const policy = async (value: "allow" | "ask" | "block") =>
        await updateConnectorToolPermissionPolicies(seed!.db, {
          ...fixture.grant,
          connectionId: fixture.connection.id,
          serverId: "grafana",
          toolNames: ["search_documents"],
          policy: value,
        });
      // Apply `change` around the n-th application fence of the request.
      const aroundCheck = (
        n: number,
        when: "before" | "after",
        change: () => Promise<void>,
      ): TargetGatewayOptions => ({
        onFence: (fence) => {
          const check = fence.check.bind(fence);
          let seen = 0;
          fence.check = async (options) => {
            const due = ++seen === n;
            if (due && when === "before") await change();
            await check(options);
            if (due && when === "after") await change();
          };
        },
      });
      const invoke = (options: TargetGatewayOptions) =>
        invokeWorkspaceToolTarget(
          deps,
          authorization,
          {
            target: { identity: fixture.identity },
            operationId: crypto.randomUUID(),
            arguments: { query: "vector(1)" },
          },
          options,
        );
      const outcome = async (pending: Promise<unknown>) =>
        await pending.then(
          (result) => ({
            executed: true,
            isError: (result as { result: { isError?: boolean } }).result.isError === true,
          }),
          (error: { status?: number; outcomeUnknown?: boolean }) => ({
            status: error.status,
            outcomeUnknown: error.outcomeUnknown === true,
          }),
        );
      for (const [value, status] of [
        ["block", 403],
        ["ask", 409],
      ] as const) {
        for (const n of [1, 2]) {
          await policy("allow");
          provider.reset();
          expect(
            await outcome(invoke(aroundCheck(n, "before", async () => await policy(value)))),
          ).toEqual({ status, outcomeUnknown: false });
          expect(provider.server.calls).toHaveLength(0);
        }
        // After the last application fence, the tools/call request's own
        // evaluation refuses dispatch; that execute-phase outcome is reported
        // as today (never relabelled as not executed by the fence).
        await policy("allow");
        provider.reset();
        expect(
          await outcome(invoke(aroundCheck(2, "after", async () => await policy(value)))),
        ).toEqual({ executed: true, isError: true });
        expect(provider.server.calls).toHaveLength(0);
        expect(
          provider.server.requests.filter((request) => request.jsonRpcMethod === "tools/call"),
        ).toHaveLength(0);
      }
      await policy("allow");
    } finally {
      provider.server.close();
    }
  }, 180_000);

  test("an invisible target and a missing tool are 404 without a recorded denial", async () => {
    if (!shared) return;
    const provider = startProvider();
    try {
      const fixture = await serviceFixture(provider);
      const authorization = accessGrantAuthorizationFromContext(fixture.access, fixture.grant);
      authorization.canonicalManagedHumanSession = true;
      const deps = { db, settings: fixture.settings } as ApiRouteDeps;
      let fence: TargetAuthorityFence | undefined;
      const observe: TargetGatewayOptions = {
        onFence: (created) => {
          fence = created;
        },
      };
      await expect(
        resolveWorkspaceToolTarget(
          deps,
          authorization,
          { target: { identity: { serverId: "not-configured", toolName: "search_documents" } } },
          observe,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(fence!.stats.full).toBe(0);
      expect(provider.server.requests).toHaveLength(0);
      await expect(
        resolveWorkspaceToolTarget(
          deps,
          authorization,
          { target: { identity: { ...fixture.identity, toolName: "missing_tool" } } },
          observe,
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(fence!.stats.outcomes).toEqual({});
    } finally {
      provider.server.close();
    }
  }, 120_000);

  test("a stalled authority read is a 503 bounded by statement_timeout, distinct from denials", async () => {
    if (!shared) return;
    const stalled = new TargetAuthorityFence({ db, targeted: true, caller: {}, deadlineMs: 250 });
    stalled.setRoute(async (tx) => {
      await tx.execute(sql`select pg_sleep(5)`);
    });
    const started = performance.now();
    await expect(stalled.check({ retryable: true })).rejects.toMatchObject({
      status: 503,
      retryable: true,
      outcomeUnknown: false,
      details: { code: "tool_authority_unavailable" },
    });
    await expect(stalled.check({ retryable: false })).rejects.toMatchObject({
      status: 503,
      retryable: false,
    });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(await stalled.failure()).toMatchObject({ status: 503 });
    // The server cancelled the statement too: nothing keeps running after the deadline.
    await Bun.sleep(300);
    const [running] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where state = 'active' and query like '%pg_sleep(5)%' and pid <> pg_backend_pid()`;
    expect(running!.count).toBe(0);

    const denied = new TargetAuthorityFence({ db, targeted: true, caller: {} });
    denied.setRoute(async () => {
      throw new HTTPException(403, { message: "tool_access_changed" });
    });
    await expect(denied.check({ retryable: true })).rejects.toMatchObject({ status: 403 });
    const asked = new TargetAuthorityFence({ db, targeted: true, caller: {} });
    asked.setRoute(async () => undefined);
    asked.setPolicy(async () => {
      throw new ToolGatewayApprovalRequiredError();
    });
    await expect(asked.check({ retryable: true })).rejects.toBeInstanceOf(
      ToolGatewayApprovalRequiredError,
    );
    expect(await asked.failure()).toBeInstanceOf(ToolGatewayApprovalRequiredError);
    // A targeted fence without its route, or a closed one, authorizes nothing.
    const unrouted = new TargetAuthorityFence({ db, targeted: true, caller: {} });
    await expect(unrouted.full()).rejects.toMatchObject({ status: 403 });
    const closed = new TargetAuthorityFence({ db, targeted: true, caller: {} });
    closed.setRoute(async () => undefined);
    await closed.full();
    closed.close();
    await expect(closed.full()).rejects.toThrow("target request scope has ended");
    expect(await closed.failure()).toBeUndefined();
  }, 60_000);

  test("narrowed route reads equal the complete projection for every selected server", async () => {
    if (!shared) return;
    const suffix = crypto.randomUUID();
    const owner = `human:${suffix}`;
    const access = await bootstrapWorkspace(seed!.db, {
      accountExternalSource: "target-fence-parity",
      accountExternalId: suffix,
      accountName: "Target fence parity",
      workspaceExternalSource: "target-fence-parity",
      workspaceExternalId: suffix,
      workspaceName: "Target fence parity",
      subjectId: owner,
    });
    const grant = access.workspaceGrants[0]!;
    const staticSettings = testSettings({
      environmentsEncryptionKey: encryptionKey,
      mcpServers: [
        { id: "static-a", url: "https://static-a.example/mcp" },
        {
          id: "grafana",
          url: "https://grafana.example/mcp",
          connectionRef: { providerDomain: "grafana.example", accountSelection: "all_eligible" },
        },
      ],
    });
    // Derived ids, explicit ids, two claimants of one id, a padded id, a
    // capability shadowed by a static server, and integrations (one shadowed
    // by a capability id).
    await mcpCapability(grant, "mcp:parity-derived");
    await mcpCapability(grant, "mcp:parity-explicit-1", { mcpServerId: "explicit-b" });
    await mcpCapability(grant, "mcp:parity-explicit-2", { mcpServerId: "explicit-b" });
    await mcpCapability(grant, "mcp:parity-padded", { mcpServerId: " padded-c " });
    await mcpCapability(grant, "mcp:parity-shadowed", { mcpServerId: "static-a" });
    await installApiIntegration(seed!.db, integrationInput(grant, "parity-inventory"));
    await installApiIntegration(
      seed!.db,
      integrationInput(grant, "parity-shadowed", "explicit-b"),
    ).catch(() => undefined);
    const capabilityServers = await listEnabledMcpCapabilityServers(db, grant.workspaceId);
    let broadIntegrations: readonly ApiIntegrationRuntime[] = [];
    const broad = await settingsWithEnabledCapabilityMcpServers(
      db,
      grant.workspaceId,
      staticSettings,
      {
        subjectId: grant.subjectId,
        onResolvedApiIntegrations: (items) => {
          broadIntegrations = items;
        },
      },
    );
    const candidates = new Set([
      ...broad.mcpServers.map((server) => server.id),
      ...capabilityServers.map((server) => server.id),
      ...broadIntegrations.map((integration) => integration.serverId),
      "explicit-b",
      "padded-c",
      "static-a",
      "missing-server",
    ]);
    expect(candidates.size).toBeGreaterThan(6);
    for (const serverId of candidates) {
      let narrowIntegrations: readonly ApiIntegrationRuntime[] = [];
      const narrow = await settingsWithEnabledCapabilityMcpServersForTargets(
        db,
        grant.workspaceId,
        staticSettings,
        {
          subjectId: grant.subjectId,
          accountId: grant.accountId,
          serverIds: [serverId],
          capabilityIds: capabilityServers
            .filter((server) => server.id === serverId)
            .map((server) => server.capabilityId),
          onResolvedApiIntegrations: (items) => {
            narrowIntegrations = items;
          },
        },
      );
      expect({
        serverId,
        servers: narrow.mcpServers.filter((server) => server.id === serverId),
        integrations: narrowIntegrations.filter((item) => item.serverId === serverId),
      }).toEqual({
        serverId,
        servers: broad.mcpServers.filter((server) => server.id === serverId),
        integrations: broadIntegrations.filter((item) => item.serverId === serverId),
      });
    }

    // Connections: shared, the owner's own, another person's, inactive.
    const connection = async (subjectId: string | null, label: string) =>
      await createConnection(seed!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        ...(subjectId ? { subjectId } : {}),
        providerDomain: "grafana.example",
        kind: "api_key",
        credentialEncrypted: "test-only-encrypted-bundle",
        metadata: { displayName: label },
        createdBySubjectId: subjectId ?? grant.subjectId,
      });
    const created = [
      await connection(null, "Shared one"),
      await connection(null, "Shared two"),
      await connection(owner, "Owner personal"),
      await connection(`human:other-${suffix}`, "Someone else"),
    ];
    const inactive = await connection(null, "Inactive");
    await shared.admin`update connections set status = 'revoked' where id = ${inactive.id}::uuid`;
    created.push(inactive);
    for (const source of [
      { kind: "none" as const },
      { kind: "subject" as const, accountId: grant.accountId, subjectId: owner },
    ]) {
      const visible = await visibleMcpAccountConnections(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        source,
      });
      for (const item of created) {
        const personal = item.subjectId !== null;
        const narrow = await visibleMcpAccountConnectionsByIds(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          source,
          workspaceConnectionIds: personal ? [] : [item.id],
          personalConnectionIds: personal ? [item.id] : [],
        });
        expect({ source: source.kind, label: item.metadata.displayName, narrow }).toEqual({
          source: source.kind,
          label: item.metadata.displayName,
          narrow: visible.filter((candidate) => candidate.id === item.id),
        });
      }
    }
  }, 180_000);
});

describe("a person on the managed browser session path", () => {
  test("pays the same per-boundary cost and sign-out stops the request in flight", async () => {
    if (!shared) return;
    const provider = startProvider();
    const origin = "http://opengeni.test";
    const settings = providerSettings(provider, {
      databaseUrl: shared.adminUrl,
      productAccessMode: "managed",
      betterAuthSecret: "target-fence-routes-secret-32-bytes-long",
      publicBaseUrl: origin,
      sandboxBackend: "none",
    });
    const api = createApp({
      settings,
      db,
      bus: { publish: async () => undefined } as never,
      workflowClient: {
        wakeSessionWorkflow: async () => undefined,
        requestSessionWorkflowWakeDispatch: async () => undefined,
      } as never,
      objectStorage: null,
    });
    try {
      const email = `target-fence-${crypto.randomUUID()}@example.test`;
      const password = "password1234";
      await api.request("/v1/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Fence Owner", email, password }),
      });
      await shared.admin`update auth_users set email_verified = true where email = ${email}`;
      const signedIn = await api.request("/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
      const cookie = signedIn.headers
        .getSetCookie()
        .find((value) => value.includes("better-auth.session_token="))!
        .split(";", 1)[0]!;
      const [user] = await shared.admin<{ id: string }[]>`
        select id from auth_users where email = ${email}`;
      const subjectId = `user:${user!.id}`;
      const created = await createManagedOrganization(seed!.db, {
        subjectId,
        subjectLabel: email,
        name: "Fence organization",
        operationId: crypto.randomUUID(),
      });
      const workspace = await createOrganizationWorkspace(seed!.db, {
        organizationId: created.organization.id,
        actorSubjectId: subjectId,
        name: "Fence shared workspace",
        operationId: crypto.randomUUID(),
      });
      const browser = {
        cookie,
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      };
      const me = (await (await api.request("/v1/access/me", { headers: { cookie } })).json()) as {
        accountGrants: Array<{ accountId: string }>;
      };
      const connection = await createConnection(seed!.db, {
        accountId: me.accountGrants[0]!.accountId,
        workspaceId: workspace.id,
        providerDomain: "127.0.0.1",
        kind: "api_key",
        credentialEncrypted: providerCredential(settings),
        metadata: { displayName: "Shared Grafana" },
        createdBySubjectId: subjectId,
      });
      const invoke = () =>
        api.request(`/v1/workspaces/${workspace.id}/tools/invoke`, {
          method: "POST",
          headers: browser,
          body: JSON.stringify({
            target: {
              identity: {
                serverId: mcpAccountRouteId("grafana", connection.id),
                toolName: "search_documents",
              },
            },
            operationId: crypto.randomUUID(),
            arguments: { query: "vector(1)" },
          }),
        });
      // The first request after sign-in may record session facts once.
      const first = await measure(provider, invoke);
      const second = await measure(provider, invoke);
      const third = await measure(provider, invoke);
      for (const result of [first, second, third]) {
        expect(result.status).toBe(200);
        expect(result.fenceEvaluations).toBe(2 * result.physicalRequests.length + 3);
        expect(result.afterFirstRequest / result.physicalRequests.length).toBeLessThan(150);
      }
      expect(third.afterFirstRequest).toBe(second.afterFirstRequest);

      provider.reset();
      provider.at(
        "tools/list",
        async () => await api.request("/v1/auth/sign-out", { method: "POST", headers: browser }),
      );
      const stopped = await invoke();
      expect([401, 403]).toContain(stopped.status);
      expect(provider.afterChange().filter((method) => method !== "-")).toEqual([]);
      expect(provider.server.calls).toHaveLength(0);
    } finally {
      provider.server.close();
    }
  }, 180_000);
});
