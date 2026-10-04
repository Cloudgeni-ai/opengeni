import { beforeAll, afterAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  installApiIntegration,
  createSession,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
  prepareConnectorActionApproval,
  type InstallApiIntegrationInput,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
let owned: OwnerMigratedTestDatabase;
let client: DbClient;
let first: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("legacy-tool-preferences");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  owned = acquired;
  await migrate(owned.ownerUrl);
  client = createDb(owned.adminUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Approval migration fixture",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Approval migration fixture",
      subjectId: "human:synthetic",
    })
  ).workspaceGrants[0]!;
}, 300000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 120000);
function integrationInput(connectionId?: string, suffix = "inventory"): InstallApiIntegrationInput {
  return {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    subjectId: first.subjectId,
    capabilityId: `api:${suffix}`,
    pluginKey: `integration/${suffix}`,
    serverId: `${suffix.replaceAll("-", "_")}_api`,
    name: "Inventory API",
    description: "Read and update inventory.",
    category: "operations",
    tags: ["inventory", "openapi"],
    definitionId: suffix,
    definitionProvenance: "workspace",
    providerDomain: "inventory.example.com",
    protocol: "openapi",
    baseUrl: "https://inventory.example.com/v1/",
    sourceUrl: "https://inventory.example.com/openapi.json",
    authScheme: connectionId
      ? { kind: "api_key", carrier: "header", name: "Authorization" }
      : { kind: "none" },
    ...(connectionId ? { connectionId } : {}),
    requiredScopes: connectionId ? ["inventory.read", "inventory.write"] : [],
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
        {
          id: "update_item",
          operationKey: "updateItem",
          name: "Update item",
          description: "Update an inventory item.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          safety: "write",
          approvalMode: "ask",
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
        update_item: {
          method: "patch",
          pathTemplate: "/items/{id}",
          serverUrl: "https://inventory.example.com/v1/",
          parameters: [],
        },
      },
    },
  };
}

test("owner backfill preserves only known legacy exemptions, existing choices and immutable review history", async () => {
  const [role] =
    await owned.admin`select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const servers: Record<string, string> = {};
  for (const suffix of ["exempt", "blocked", "inherited"]) {
    const installed = await installApiIntegration(client.db, {
      ...integrationInput(undefined, suffix),
      ...(suffix === "inherited" ? {} : { autoApprovedTools: ["update_item"] }),
    });
    servers[suffix] = installed.serverId;
  }
  // Reproduce the old storage: per-install exemption, no common preference.
  await owned.admin`delete from connector_action_policies where workspace_id = ${first.workspaceId} and server_id = ${servers.exempt!}`;
  await owned.admin`update connector_action_policies set policy = 'block' where workspace_id = ${first.workspaceId} and server_id = ${servers.blocked!}`;
  const session = await createSession(client.db, {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    initialMessage: "Review synthetic action",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, first.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Fixture claim failed");
  await prepareConnectorActionApproval(
    client.db,
    {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      initiator: claimed.turn.initiator,
    },
    {
      approvalId: crypto.randomUUID(),
      connectionId: "session-mcp:fixture:synthetic",
      serverId: "fixture",
      toolName: "change",
      arguments: { ids: ["synthetic-a", "synthetic-b"] },
      approvalMode: "session_mcp",
    },
  );
  const before = await owned.admin`select * from connector_action_requests order by id`;
  expect(before).toHaveLength(1);
  expect(before[0]!.status).toBe("pending");
  const source = await Bun.file(
    new URL("../drizzle/0621_legacy_api_tool_preferences.sql", import.meta.url),
  ).text();
  const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`select set_config('opengeni.migration_application_roles', '["opengeni_app"]', false)`;
    const [hidden] = await owner`select count(*)::int as count from connector_action_policies`;
    expect(hidden!.count).toBe(0);
    await owner.begin(async (tx) => {
      await tx.unsafe(source);
    });
    const choices =
      await owned.admin`select server_id, tool_name, policy from connector_action_policies where workspace_id = ${first.workspaceId} order by server_id`;
    expect([...choices]).toEqual([
      { server_id: servers.blocked!, tool_name: "update_item", policy: "block" },
      { server_id: servers.exempt!, tool_name: "update_item", policy: "allow" },
    ]);
    const frozen =
      await owned.admin`select * from connector_action_policies where workspace_id = ${first.workspaceId} order by id`;
    await owner.begin(async (tx) => {
      await tx.unsafe(source);
    });
    expect([
      ...(await owned.admin`select * from connector_action_policies where workspace_id = ${first.workspaceId} order by id`),
    ]).toEqual([...frozen]);
    expect([...(await owned.admin`select * from connector_action_requests order by id`)]).toEqual([
      ...before,
    ]);
    const [afterHidden] = await owner`select count(*)::int as count from connector_action_policies`;
    expect(afterHidden!.count).toBe(0);
    const posture =
      await owned.admin`select relforcerowsecurity from pg_class where relname in ('integration_facet_definitions', 'capability_api_facets', 'integration_spec_revisions', 'integration_facet_bindings', 'capability_facet_installations', 'capability_plugin_installations', 'connector_action_policies')`;
    expect(posture).toHaveLength(7);
    expect(posture.every((row) => row.relforcerowsecurity)).toBe(true);
  } finally {
    await owner.end({ timeout: 5 });
  }
}, 180000);
