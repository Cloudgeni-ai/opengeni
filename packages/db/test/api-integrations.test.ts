import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  ApiIntegrationInstallationVersionConflictError,
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  getApiIntegrationUninstallPreview,
  getConnectionMetadata,
  installApiIntegration,
  listInstalledApiIntegrations,
  uninstallApiIntegration,
  type DbClient,
  type InstallApiIntegrationInput,
} from "../src";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let available = true;
let first: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
let second: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_API_INTEGRATIONS_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_API_INTEGRATIONS_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_API_INTEGRATIONS_TEST_POSTGRES_ADMIN_URL and OPENGENI_API_INTEGRATIONS_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end().catch(() => undefined),
    };
  } else {
    shared = await acquireSharedTestDatabase("api-integrations");
  }
  if (!shared) {
    available = false;
    console.warn("[api-integrations] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `api-integration-account-${crypto.randomUUID()}`,
      accountName: "API Integration account",
      workspaceExternalSource: "test",
      workspaceExternalId: `api-integration-workspace-${crypto.randomUUID()}`,
      workspaceName: "API Integration workspace",
      subjectId: "user:api-integration-owner",
    })
  ).workspaceGrants[0]!;
  second = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `api-integration-foreign-account-${crypto.randomUUID()}`,
      accountName: "Foreign API account",
      workspaceExternalSource: "test",
      workspaceExternalId: `api-integration-foreign-workspace-${crypto.randomUUID()}`,
      workspaceName: "Foreign API workspace",
      subjectId: "user:api-integration-foreign",
    })
  ).workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && first?.workspaceId) await deleteWorkspace(client.db, first.workspaceId).catch(() => undefined);
  if (client && second?.workspaceId) await deleteWorkspace(client.db, second.workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

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
    providerDomain: "inventory.example.com",
    protocol: "openapi",
    baseUrl: "https://inventory.example.com/v1/",
    sourceUrl: "https://inventory.example.com/openapi.json",
    authScheme: connectionId ? { kind: "connection" } : { kind: "none" },
    ...(connectionId ? { connectionId } : {}),
    requiredScopes: connectionId ? ["inventory.read", "inventory.write"] : [],
    ownership: "workspace",
    revision: {
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

describe("API Integration persistence", () => {
  test("installs idempotently, projects runtime policy, isolates tenants, and OCC-uninstalls", async () => {
    if (!available || !client) return;
    const input = integrationInput();
    const installed = await installApiIntegration(client.db, input);
    expect(await installApiIntegration(client.db, input)).toEqual(installed);
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        capabilityId: input.capabilityId,
        serverId: installed.serverId,
        instanceId: installed.instanceId,
        instanceKey: "default",
        displayName: input.name,
        instanceVersion: 1,
        connectionRef: null,
        allowedTools: ["list_items", "update_item"],
        requireApproval: ["update_item"],
        revision: expect.objectContaining({ contentSha256: "1".repeat(64) }),
      }),
    ]);
    expect(await listInstalledApiIntegrations(client.db, second.workspaceId)).toEqual([]);

    const preview = await getApiIntegrationUninstallPreview(
      client.db,
      first.workspaceId,
      input.capabilityId,
      installed.instanceKey,
    );
    expect(preview).toMatchObject({
      installed: true,
      installationVersion: 1,
      instanceVersion: 1,
      directOwner: { kind: "direct", id: input.capabilityId },
      remainingOwners: [],
      removesRuntimeIntegration: true,
      removesDefinition: true,
    });
    await expect(
      uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: input.capabilityId,
        instanceKey: installed.instanceKey,
        expectedInstallationVersion: 2,
        expectedInstanceVersion: installed.instanceVersion,
      }),
    ).rejects.toBeInstanceOf(ApiIntegrationInstallationVersionConflictError);
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: input.capabilityId,
        instanceKey: installed.instanceKey,
        expectedInstallationVersion: 1,
        expectedInstanceVersion: installed.instanceVersion,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      instanceKey: installed.instanceKey,
      status: "uninstalled",
      remainingOwners: [],
      definitionStatus: "disabled",
    });
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([]);
  }, 60_000);

  test("binds an exact workspace Connection and preserves Pack-owned runtime components", async () => {
    if (!available || !client || !shared) return;
    const connection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "inventory.example.com",
      kind: "oauth2",
      credentialEncrypted: "test-only-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: first.subjectId,
    });
    const input = integrationInput(connection.id, "inventory-connected");
    const installed = await installApiIntegration(client.db, input);
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        connectionRef: {
          connectionId: connection.id,
          providerDomain: "inventory.example.com",
          kind: "oauth2",
          scopes: ["inventory.read", "inventory.write"],
          subjectScope: "workspace",
        },
      }),
    ]);
    await shared.admin`
      insert into capability_component_owners
        (account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable)
      values
        (${first.accountId}, ${first.workspaceId}, ${installed.integrationFacetInstallationId},
         'pack', 'pack:inventory-operations', false),
        (${first.accountId}, ${first.workspaceId}, ${installed.apiFacetInstallationId},
         'pack', 'pack:inventory-operations', false)
    `;
    await shared.admin`
      insert into integration_feature_binding_owners
        (account_id, workspace_id, binding_id, owner_kind, owner_id, removable)
      values
        (${first.accountId}, ${first.workspaceId}, ${installed.instanceId},
         'pack', 'pack:inventory-operations', false)
    `;
    const preview = await getApiIntegrationUninstallPreview(
      client.db,
      first.workspaceId,
      input.capabilityId,
      installed.instanceKey,
    );
    expect(preview).toMatchObject({
      removesRuntimeIntegration: false,
      removesDefinition: false,
      remainingOwners: [
        { kind: "pack", id: "pack:inventory-operations", removable: false },
      ],
    });
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: input.capabilityId,
        instanceKey: installed.instanceKey,
        expectedInstallationVersion: 1,
        expectedInstanceVersion: installed.instanceVersion,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      instanceKey: installed.instanceKey,
      status: "retained_by_other_owners",
      remainingOwners: [
        { kind: "pack", id: "pack:inventory-operations", removable: false },
      ],
      definitionStatus: "retained",
    });
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toHaveLength(1);
  }, 60_000);

  test("keeps two Connections for one Integration definition independently callable and removable", async () => {
    if (!available || !client) return;
    const financeConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "inventory.example.com",
      kind: "oauth2",
      credentialEncrypted: "finance-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: first.subjectId,
    });
    const salesConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "inventory.example.com",
      kind: "oauth2",
      credentialEncrypted: "sales-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: first.subjectId,
    });
    const base = integrationInput(financeConnection.id, "inventory-multi");
    const finance = await installApiIntegration(client.db, {
      ...base,
      instanceKey: "finance",
      displayName: "Inventory — Finance",
    });
    const sales = await installApiIntegration(client.db, {
      ...base,
      connectionId: salesConnection.id,
      instanceKey: "sales",
      displayName: "Inventory — Sales",
    });
    expect(finance.instanceId).not.toBe(sales.instanceId);
    expect(finance.serverId).not.toBe(sales.serverId);
    expect(sales.installationVersion).toBe(finance.installationVersion + 1);

    const both = (await listInstalledApiIntegrations(client.db, first.workspaceId)).filter(
      (integration) => integration.capabilityId === base.capabilityId,
    );
    expect(both).toHaveLength(2);
    expect(
      both.map((integration) => ({
        instanceKey: integration.instanceKey,
        serverId: integration.serverId,
        connectionId: integration.connectionRef?.connectionId,
      })),
    ).toEqual([
      {
        instanceKey: "finance",
        serverId: finance.serverId,
        connectionId: financeConnection.id,
      },
      {
        instanceKey: "sales",
        serverId: sales.serverId,
        connectionId: salesConnection.id,
      },
    ]);

    const upgradedSales = await installApiIntegration(client.db, {
      ...base,
      connectionId: salesConnection.id,
      instanceKey: "sales",
      displayName: "Inventory — Sales",
      expectedInstanceVersion: sales.instanceVersion,
      revision: {
        ...base.revision,
        id: "openapi:222222222222222222222222",
        contentSha256: "2".repeat(64),
      },
    });
    expect(upgradedSales).toMatchObject({
      instanceId: sales.instanceId,
      serverId: sales.serverId,
      instanceVersion: sales.instanceVersion + 1,
      installationVersion: sales.installationVersion + 1,
      revisionId: "openapi:222222222222222222222222",
    });
    const afterUpgrade = (
      await listInstalledApiIntegrations(client.db, first.workspaceId)
    ).filter((integration) => integration.capabilityId === base.capabilityId);
    expect(afterUpgrade).toHaveLength(2);
    expect(
      afterUpgrade.map((integration) => ({
        instanceId: integration.instanceId,
        instanceKey: integration.instanceKey,
        instanceVersion: integration.instanceVersion,
        serverId: integration.serverId,
        connectionId: integration.connectionRef?.connectionId,
        revisionId: integration.revision.id,
      })),
    ).toEqual([
      {
        instanceId: finance.instanceId,
        instanceKey: "finance",
        instanceVersion: finance.instanceVersion + 1,
        serverId: finance.serverId,
        connectionId: financeConnection.id,
        revisionId: upgradedSales.revisionId,
      },
      {
        instanceId: sales.instanceId,
        instanceKey: "sales",
        instanceVersion: sales.instanceVersion + 1,
        serverId: sales.serverId,
        connectionId: salesConnection.id,
        revisionId: upgradedSales.revisionId,
      },
    ]);

    const financePreview = await getApiIntegrationUninstallPreview(
      client.db,
      first.workspaceId,
      base.capabilityId,
      finance.instanceKey,
    );
    expect(financePreview).toMatchObject({
      instanceVersion: finance.instanceVersion + 1,
      removesRuntimeIntegration: true,
      removesDefinition: false,
    });
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: base.capabilityId,
        instanceKey: finance.instanceKey,
        expectedInstallationVersion: upgradedSales.installationVersion,
        expectedInstanceVersion: finance.instanceVersion + 1,
      }),
    ).toEqual({
      capabilityId: base.capabilityId,
      instanceKey: "finance",
      status: "uninstalled",
      remainingOwners: [],
      definitionStatus: "retained",
    });

    const [remaining] = (await listInstalledApiIntegrations(client.db, first.workspaceId)).filter(
      (integration) => integration.capabilityId === base.capabilityId,
    );
    expect(remaining).toMatchObject({
      instanceId: sales.instanceId,
      instanceKey: "sales",
      serverId: sales.serverId,
      connectionRef: { connectionId: salesConnection.id },
    });
    const renamed = await installApiIntegration(client.db, {
      ...base,
      connectionId: salesConnection.id,
      instanceKey: "sales",
      displayName: "Inventory — Sales primary",
      expectedInstanceVersion: upgradedSales.instanceVersion,
      revision: {
        ...base.revision,
        id: upgradedSales.revisionId,
        contentSha256: "2".repeat(64),
      },
    });
    expect(renamed).toMatchObject({
      instanceId: sales.instanceId,
      instanceKey: "sales",
      displayName: "Inventory — Sales primary",
      instanceVersion: upgradedSales.instanceVersion + 1,
      serverId: sales.serverId,
    });
    expect(
      await Promise.all([
        getConnectionMetadata(client.db, first.workspaceId, financeConnection.id),
        getConnectionMetadata(client.db, first.workspaceId, salesConnection.id),
      ]),
    ).toEqual([expect.objectContaining({ status: "active" }), expect.objectContaining({ status: "active" })]);
  }, 60_000);
});