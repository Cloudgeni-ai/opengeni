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
        serverId: input.serverId,
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
    );
    expect(preview).toMatchObject({
      installed: true,
      installationVersion: 1,
      directOwner: { kind: "direct", id: input.capabilityId },
      remainingOwners: [],
      removesRuntimeIntegration: true,
    });
    await expect(
      uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ApiIntegrationInstallationVersionConflictError);
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 1,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      status: "uninstalled",
      remainingOwners: [],
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
        (${first.accountId}, ${first.workspaceId}, ${installed.apiFacetInstallationId},
         'pack', 'pack:inventory-operations', false)
    `;
    const preview = await getApiIntegrationUninstallPreview(
      client.db,
      first.workspaceId,
      input.capabilityId,
    );
    expect(preview).toMatchObject({
      removesRuntimeIntegration: false,
      remainingOwners: [
        { kind: "pack", id: "pack:inventory-operations", removable: false },
      ],
    });
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 1,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      status: "retained_by_other_owners",
      remainingOwners: [
        { kind: "pack", id: "pack:inventory-operations", removable: false },
      ],
    });
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toHaveLength(1);
  }, 60_000);
});