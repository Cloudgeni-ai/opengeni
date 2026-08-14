import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  ApiIntegrationInstallationVersionConflictError,
  bootstrapWorkspace,
  configureIntegrationFacet,
  createConnection,
  createDb,
  deleteWorkspace,
  getApiIntegrationUninstallPreview,
  getConnectionMetadata,
  installApiIntegration,
  IntegrationFacetBindingVersionConflictError,
  IntegrationFacetConfigError,
  IntegrationFacetNotFoundError,
  IntegrationFacetOperationIdempotencyError,
  listIntegrationInstanceFacets,
  listInstalledApiIntegrations,
  removeIntegrationFacet,
  setIntegrationFacetLifecycle,
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
  if (client && first?.workspaceId)
    await deleteWorkspace(client.db, first.workspaceId).catch(() => undefined);
  if (client && second?.workspaceId)
    await deleteWorkspace(client.db, second.workspaceId).catch(() => undefined);
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

describe("API Integration persistence", () => {
  test("keeps personal runtime projection and removal exact-subject", async () => {
    if (!available || !client) return;
    const ownerSubjectId = "user:api-integration-personal-owner";
    const otherSubjectId = "user:api-integration-personal-other";
    const connection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: ownerSubjectId,
      providerDomain: "inventory.example.com",
      kind: "api_key",
      credentialEncrypted: "test-only-personal-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: ownerSubjectId,
    });
    const input = {
      ...integrationInput(connection.id, "inventory-personal-subject"),
      subjectId: ownerSubjectId,
      ownership: "subject" as const,
    };
    const installed = await installApiIntegration(client.db, input);

    expect(
      await listInstalledApiIntegrations(client.db, first.workspaceId, ownerSubjectId),
    ).toEqual([expect.objectContaining({ instanceId: installed.instanceId })]);
    expect(
      await listInstalledApiIntegrations(client.db, first.workspaceId, otherSubjectId),
    ).toEqual([]);
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([]);
    expect(
      await getApiIntegrationUninstallPreview(
        client.db,
        first.workspaceId,
        otherSubjectId,
        input.capabilityId,
        installed.instanceKey,
      ),
    ).toMatchObject({ installed: false, installationVersion: null, instanceVersion: null });
    expect(
      await uninstallApiIntegration(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: otherSubjectId,
        capabilityId: input.capabilityId,
        instanceKey: installed.instanceKey,
        expectedInstallationVersion: installed.installationVersion,
        expectedInstanceVersion: installed.instanceVersion,
      }),
    ).toMatchObject({ status: "not_installed", definitionStatus: "retained" });
    expect(
      await listInstalledApiIntegrations(client.db, first.workspaceId, ownerSubjectId),
    ).toHaveLength(1);

    await uninstallApiIntegration(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: ownerSubjectId,
      capabilityId: input.capabilityId,
      instanceKey: installed.instanceKey,
      expectedInstallationVersion: installed.installationVersion,
      expectedInstanceVersion: installed.instanceVersion,
    });
  }, 60_000);

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
        authScheme: { kind: "none" },
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
      first.subjectId,
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

    const emptySelectionInput = {
      ...integrationInput(undefined, "inventory-empty-selection"),
      allowedTools: [],
    } satisfies InstallApiIntegrationInput;
    const emptySelection = await installApiIntegration(client.db, emptySelectionInput);
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        capabilityId: emptySelectionInput.capabilityId,
        authScheme: { kind: "none" },
        allowedTools: [],
      }),
    ]);
    await uninstallApiIntegration(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: emptySelectionInput.capabilityId,
      instanceKey: emptySelection.instanceKey,
      expectedInstallationVersion: emptySelection.installationVersion,
      expectedInstanceVersion: emptySelection.instanceVersion,
    });
  }, 60_000);

  test("binds an exact workspace Connection and preserves Pack-owned runtime components", async () => {
    if (!available || !client || !shared) return;
    const wrongKindConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "inventory.example.com",
      kind: "oauth2",
      credentialEncrypted: "test-only-wrong-kind-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: first.subjectId,
    });
    await expect(
      installApiIntegration(
        client.db,
        integrationInput(wrongKindConnection.id, "inventory-wrong-kind"),
      ),
    ).rejects.toThrow("credential Connection");

    const connection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "inventory.example.com",
      kind: "api_key",
      credentialEncrypted: "test-only-encrypted-bundle",
      grantedScopes: ["inventory.read", "inventory.write"],
      createdBySubjectId: first.subjectId,
    });
    const input = integrationInput(connection.id, "inventory-connected");
    const installed = await installApiIntegration(client.db, input);
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        authScheme: { kind: "api_key", carrier: "header", name: "Authorization" },
        connectionRef: {
          connectionId: connection.id,
          providerDomain: "inventory.example.com",
          kind: "api_key",
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
      insert into integration_facet_binding_owners
        (account_id, workspace_id, binding_id, owner_kind, owner_id, removable)
      values
        (${first.accountId}, ${first.workspaceId}, ${installed.instanceId},
         'pack', 'pack:inventory-operations', false)
    `;
    const preview = await getApiIntegrationUninstallPreview(
      client.db,
      first.workspaceId,
      first.subjectId,
      input.capabilityId,
      installed.instanceKey,
    );
    expect(preview).toMatchObject({
      removesRuntimeIntegration: false,
      removesDefinition: false,
      remainingOwners: [{ kind: "pack", id: "pack:inventory-operations", removable: false }],
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
      remainingOwners: [{ kind: "pack", id: "pack:inventory-operations", removable: false }],
      definitionStatus: "retained",
    });
    expect(await listInstalledApiIntegrations(client.db, first.workspaceId)).toHaveLength(1);
  }, 60_000);

  test("keeps two Linear-like GraphQL Connections and named instances independently updateable and removable", async () => {
    if (!available || !client) return;
    const financeConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "linear.example.test",
      kind: "oauth2",
      credentialEncrypted: "finance-encrypted-bundle",
      grantedScopes: ["issues:read", "issues:write"],
      createdBySubjectId: first.subjectId,
    });
    const salesConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "linear.example.test",
      kind: "oauth2",
      credentialEncrypted: "sales-encrypted-bundle",
      grantedScopes: ["issues:read", "issues:write"],
      createdBySubjectId: first.subjectId,
    });
    const inventoryBase = integrationInput(financeConnection.id, "linear-like-graphql");
    const base: InstallApiIntegrationInput = {
      ...inventoryBase,
      definitionId: "linear-like-graphql",
      name: "Linear-like GraphQL",
      description: "Deterministic issue-tracker GraphQL emulator.",
      providerDomain: "linear.example.test",
      protocol: "graphql",
      baseUrl: "https://linear.example.test/graphql",
      sourceUrl: "https://linear.example.test/graphql",
      authScheme: { kind: "oauth2" },
      requiredScopes: ["issues:read", "issues:write"],
      revision: {
        id: "graphql:111111111111111111111111",
        protocol: "graphql",
        definitionId: "linear-like-graphql",
        contentSha256: "1".repeat(64),
        source: { url: "https://linear.example.test/graphql" },
        title: "Linear-like GraphQL",
        tools: inventoryBase.revision.tools,
        bindings: {
          list_items: {
            kind: "query",
            fieldName: "issues",
            operationName: "ListIssues",
            variableDefinitions: [],
            variableNames: [],
            defaultSelection: "nodes { id title }",
            selectionAllowed: true,
          },
          update_item: {
            kind: "mutation",
            fieldName: "issueUpdate",
            operationName: "UpdateIssue",
            variableDefinitions: ["$id: ID!"],
            variableNames: ["id"],
            defaultSelection: "id",
            selectionAllowed: true,
          },
        },
      },
    };
    const finance = await installApiIntegration(client.db, {
      ...base,
      instanceKey: "finance",
      displayName: "Linear — Finance",
    });
    const sales = await installApiIntegration(client.db, {
      ...base,
      connectionId: salesConnection.id,
      instanceKey: "sales",
      displayName: "Linear — Sales",
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
      displayName: "Linear — Sales",
      expectedInstanceVersion: sales.instanceVersion,
      revision: {
        ...base.revision,
        id: "graphql:222222222222222222222222",
        contentSha256: "2".repeat(64),
      },
    });
    expect(upgradedSales).toMatchObject({
      instanceId: sales.instanceId,
      serverId: sales.serverId,
      instanceVersion: sales.instanceVersion + 1,
      installationVersion: sales.installationVersion + 1,
      revisionId: "graphql:222222222222222222222222",
    });
    const afterUpgrade = (await listInstalledApiIntegrations(client.db, first.workspaceId)).filter(
      (integration) => integration.capabilityId === base.capabilityId,
    );
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
      first.subjectId,
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
      displayName: "Linear — Sales primary",
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
      displayName: "Linear — Sales primary",
      instanceVersion: upgradedSales.instanceVersion + 1,
      serverId: sales.serverId,
    });
    expect(
      await Promise.all([
        getConnectionMetadata(client.db, first.workspaceId, financeConnection.id),
        getConnectionMetadata(client.db, first.workspaceId, salesConnection.id),
      ]),
    ).toEqual([
      expect.objectContaining({ status: "active" }),
      expect.objectContaining({ status: "active" }),
    ]);
  }, 60_000);

  test("manages adapter-owned facets generically and preserves their state across definition upgrades", async () => {
    if (!available || !client) return;
    const googleConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "drive.example.test",
      kind: "oauth2",
      credentialEncrypted: "google-drive-facet-encrypted-bundle",
      grantedScopes: ["files.read"],
      createdBySubjectId: first.subjectId,
    });
    const baseInput = integrationInput(googleConnection.id, "generic-google-drive");
    const googleInput: InstallApiIntegrationInput = {
      ...baseInput,
      name: "Generic Google Drive",
      providerDomain: "drive.example.test",
      baseUrl: "https://drive.example.test/v1/",
      sourceUrl: "https://drive.example.test/openapi.json",
      authScheme: { kind: "oauth2" },
      requiredScopes: ["files.read"],
      instanceKey: "finance",
      facetDefinitions: [
        {
          facetKey: "drive-content",
          kind: "knowledge_source",
          configSchema: {
            type: "object",
            required: ["sources"],
            properties: {
              sources: {
                type: "array",
                minItems: 1,
                maxItems: 2,
                items: {
                  type: "object",
                  required: ["sourceId", "sourceKind"],
                  properties: {
                    sourceId: { type: "string", minLength: 1, maxLength: 512 },
                    sourceKind: { type: "string", enum: ["my_drive", "folder"] },
                    includeDescendants: { type: "boolean" },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          capabilities: {
            provider: "google-drive",
            connectionRequired: true,
            cursor: "page_token",
          },
        },
        {
          facetKey: "account-identity",
          kind: "identity_link",
          configSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          capabilities: { provider: "google", connectionRequired: true },
        },
      ],
      revision: {
        ...baseInput.revision,
        bindings: Object.fromEntries(
          Object.entries(baseInput.revision.bindings).map(([key, binding]) => [
            key,
            { ...binding, serverUrl: "https://drive.example.test/v1/" },
          ]),
        ),
      },
    };
    const installed = await installApiIntegration(client.db, googleInput);
    expect(
      await listIntegrationInstanceFacets(
        client.db,
        first.workspaceId,
        first.subjectId,
        googleInput.capabilityId,
        installed.instanceKey,
      ),
    ).toMatchObject({
      capabilityId: googleInput.capabilityId,
      instanceKey: "finance",
      providerDomain: "drive.example.test",
      connectionId: googleConnection.id,
      facets: [
        {
          definition: { facetKey: "account-identity", kind: "identity_link" },
          binding: null,
        },
        {
          definition: { facetKey: "drive-content", kind: "knowledge_source" },
          binding: null,
        },
      ],
    });

    const configureKey = crypto.randomUUID();
    const configured = await configureIntegrationFacet(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: googleInput.capabilityId,
      instanceKey: "finance",
      facetKey: "drive-content",
      displayName: "Finance source",
      config: {
        sources: [
          {
            sourceId: "folder:finance",
            sourceKind: "folder",
            includeDescendants: true,
          },
        ],
      },
      idempotencyKey: configureKey,
    });
    expect(configured).toMatchObject({
      status: "configured",
      binding: {
        connectionId: googleConnection.id,
        status: "active",
        version: 1,
        hasCursor: false,
      },
    });
    expect(
      await configureIntegrationFacet(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: googleInput.capabilityId,
        instanceKey: "finance",
        facetKey: "drive-content",
        displayName: "Finance source",
        config: {
          sources: [
            {
              sourceId: "folder:finance",
              sourceKind: "folder",
              includeDescendants: true,
            },
          ],
        },
        idempotencyKey: configureKey,
      }),
    ).toEqual(configured);
    await expect(
      configureIntegrationFacet(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: googleInput.capabilityId,
        instanceKey: "finance",
        facetKey: "drive-content",
        displayName: "Different source",
        config: { sources: [{ sourceId: "folder:other", sourceKind: "folder" }] },
        idempotencyKey: configureKey,
      }),
    ).rejects.toBeInstanceOf(IntegrationFacetOperationIdempotencyError);
    await expect(
      configureIntegrationFacet(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: googleInput.capabilityId,
        instanceKey: "finance",
        facetKey: "drive-content",
        displayName: "Invalid source",
        config: {
          sources: [{ sourceId: "folder:bad", sourceKind: "unsupported" }],
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IntegrationFacetConfigError);

    const upgraded = await installApiIntegration(client.db, {
      ...googleInput,
      expectedInstanceVersion: installed.instanceVersion,
      revision: {
        ...googleInput.revision,
        id: "openapi:222222222222222222222222",
        contentSha256: "2".repeat(64),
      },
    });
    const afterUpgrade = await listIntegrationInstanceFacets(
      client.db,
      first.workspaceId,
      first.subjectId,
      googleInput.capabilityId,
      installed.instanceKey,
    );
    const upgradedSource = afterUpgrade.facets.find(
      (facet) => facet.definition.facetKey === "drive-content",
    )!.binding!;
    expect(upgradedSource).toMatchObject({
      id: configured.binding.id,
      version: configured.binding.version + 1,
      status: "active",
      config: {
        sources: [
          {
            sourceId: "folder:finance",
            sourceKind: "folder",
            includeDescendants: true,
          },
        ],
      },
    });

    const paused = await setIntegrationFacetLifecycle(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: googleInput.capabilityId,
      instanceKey: "finance",
      facetKey: "drive-content",
      action: "pause",
      expectedVersion: upgradedSource.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(paused).toMatchObject({
      status: "paused",
      binding: { status: "paused" },
    });
    await expect(
      setIntegrationFacetLifecycle(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        capabilityId: googleInput.capabilityId,
        instanceKey: "finance",
        facetKey: "drive-content",
        action: "resume",
        expectedVersion: upgradedSource.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IntegrationFacetBindingVersionConflictError);
    const resumed = await setIntegrationFacetLifecycle(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: googleInput.capabilityId,
      instanceKey: "finance",
      facetKey: "drive-content",
      action: "resume",
      expectedVersion: paused.binding.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(resumed).toMatchObject({
      status: "active",
      binding: { status: "active" },
    });
    const removed = await removeIntegrationFacet(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: googleInput.capabilityId,
      instanceKey: "finance",
      facetKey: "drive-content",
      expectedVersion: resumed.binding.version,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(removed).toMatchObject({
      status: "removed",
      binding: { status: "disabled", version: resumed.binding.version + 1 },
      remainingOwners: [],
    });

    const microsoftConnection = await createConnection(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      providerDomain: "onedrive.example.test",
      kind: "oauth2",
      credentialEncrypted: "onedrive-facet-encrypted-bundle",
      grantedScopes: ["files.read"],
      createdBySubjectId: first.subjectId,
    });
    const microsoftBase = integrationInput(microsoftConnection.id, "generic-onedrive");
    const microsoftInput: InstallApiIntegrationInput = {
      ...microsoftBase,
      name: "Generic OneDrive",
      providerDomain: "onedrive.example.test",
      baseUrl: "https://onedrive.example.test/v1/",
      sourceUrl: "https://onedrive.example.test/openapi.json",
      authScheme: { kind: "oauth2" },
      requiredScopes: ["files.read"],
      instanceKey: "legal",
      facetDefinitions: [
        {
          facetKey: "drive-content",
          kind: "knowledge_source",
          configSchema: {
            type: "object",
            required: ["sourceId", "sourceKind"],
            properties: {
              sourceId: { type: "string", minLength: 1, maxLength: 512 },
              sourceKind: {
                type: "string",
                enum: ["my_drive", "shared_library", "folder"],
              },
            },
            additionalProperties: false,
          },
          capabilities: {
            provider: "microsoft-onedrive",
            connectionRequired: true,
            cursor: "delta_link",
          },
        },
      ],
      revision: {
        ...microsoftBase.revision,
        bindings: Object.fromEntries(
          Object.entries(microsoftBase.revision.bindings).map(([key, binding]) => [
            key,
            { ...binding, serverUrl: "https://onedrive.example.test/v1/" },
          ]),
        ),
      },
    };
    await installApiIntegration(client.db, microsoftInput);
    const microsoftFeature = await configureIntegrationFacet(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      capabilityId: microsoftInput.capabilityId,
      instanceKey: "legal",
      facetKey: "drive-content",
      displayName: "Legal library",
      config: { sourceId: "library:legal", sourceKind: "shared_library" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(microsoftFeature.binding).toMatchObject({
      kind: "knowledge_source",
      connectionId: microsoftConnection.id,
      config: { sourceId: "library:legal", sourceKind: "shared_library" },
    });
    await expect(
      listIntegrationInstanceFacets(
        client.db,
        second.workspaceId,
        second.subjectId,
        googleInput.capabilityId,
        installed.instanceKey,
      ),
    ).rejects.toBeInstanceOf(IntegrationFacetNotFoundError);
    expect(upgraded.installationVersion).toBeGreaterThan(installed.installationVersion);
  }, 60_000);
});
