import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GOOGLE_DRIVE_INTEGRATION_DEFINITION } from "@opengeni/capabilities";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveConnectionMetadata,
} from "@opengeni/contracts/google-drive";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  encryptEnvironmentValue,
  installApiIntegration,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import {
  apiIntegrationRequiresConnection,
  registerApiIntegrationRoutes,
} from "../src/routes/api-integrations";
import { registerIntegrationFacetRoutes } from "../src/routes/integration-facets";

const delegationSecret = "api-integration-route-secret";
const environmentsEncryptionKey = new Uint8Array(32).fill(19);
let sourceVersion = "1.0.0";
let googleDriveFolderName = "Product";
const googleDriveProviderRequests: string[] = [];
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let available = true;
let accountId = "";
let workspaceId = "";
let subjectId = "";

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Inventory API",
      description: "Read and update inventory.",
      version: sourceVersion,
    },
    servers: [{ url: "https://127.0.0.1/v1/" }],
    paths: {
      "/items": {
        get: {
          operationId: "inventory.listItems",
          summary: "List items",
          responses: { "200": { description: "Items" } },
        },
        post: {
          operationId: "inventory.createItem",
          summary: "Create item",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "201": { description: "Created" } },
        },
      },
    },
  };
}

function apiKeyOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Query Key API", version: "1.0.0" },
    servers: [{ url: "https://127.0.0.1/v1/" }],
    components: {
      securitySchemes: {
        queryKey: { type: "apiKey", in: "query", name: "api_key" },
      },
    },
    security: [{ queryKey: [] }],
    paths: {
      "/items": {
        get: {
          operationId: "queryKey.listItems",
          responses: { "200": { description: "Items" } },
        },
      },
    },
  };
}

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_API_INTEGRATIONS_ROUTE_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_API_INTEGRATIONS_ROUTE_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_API_INTEGRATIONS_ROUTE_TEST_POSTGRES_ADMIN_URL and OPENGENI_API_INTEGRATIONS_ROUTE_TEST_POSTGRES_APP_URL must be set together",
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
    shared = await acquireSharedTestDatabase("api-integration-routes");
  }
  if (!shared) {
    available = false;
    console.warn("[api-integration-routes] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:api-integration-route-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `api-integration-route-account-${crypto.randomUUID()}`,
    accountName: "API Integration route account",
    workspaceExternalSource: "test",
    workspaceExternalId: `api-integration-route-workspace-${crypto.randomUUID()}`,
    workspaceName: "API Integration route workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  app = new Hono();
  registerApiIntegrationRoutes(
    app,
    {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret,
      }),
    } as ApiRouteDeps,
    {
      fetchImpl: async (sourceRequest) => {
        if (String(sourceRequest) === "https://127.0.0.1/secured-openapi.json") {
          return new Response(JSON.stringify(apiKeyOpenApiDocument()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (String(sourceRequest) !== "https://127.0.0.1/openapi.json") {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify(openApiDocument()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  registerIntegrationFacetRoutes(app, {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret,
      environmentsEncryptionKey: Buffer.from(environmentsEncryptionKey).toString("base64"),
    }),
    googleDriveFetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      googleDriveProviderRequests.push(url.href);
      if (url.pathname === "/drive/v3/files/folder-1") {
        return Response.json({
          id: "folder-1",
          name: googleDriveFolderName,
          mimeType: "application/vnd.google-apps.folder",
          modifiedTime: "2026-08-14T06:00:00.000Z",
          webViewLink: "https://drive.google.com/drive/folders/folder-1",
          trashed: false,
        });
      }
      throw new Error(`unexpected Google Drive provider request: ${url.href}`);
    },
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function auth(asSubjectId = subjectId): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId: asSubjectId,
    permissions: ["workspace:read", "workspace:admin"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

async function request(
  path: string,
  init: RequestInit = {},
  asSubjectId = subjectId,
): Promise<Response> {
  return await app!.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: {
      authorization: await auth(asSubjectId),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("API Integration routes", () => {
  test("projects missing legacy auth metadata as not requiring a Connection", () => {
    expect(apiIntegrationRequiresConnection({})).toBe(false);
    expect(apiIntegrationRequiresConnection({ kind: "none" })).toBe(false);
    expect(apiIntegrationRequiresConnection({ kind: "oauth2" })).toBe(true);
  });

  test("lists curated provider definitions without deployment OAuth credentials", async () => {
    if (!available) return;
    const response = await request("/integrations/definitions");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.definitions).toHaveLength(6);
    expect(payload.definitions).toContainEqual(
      expect.objectContaining({
        id: "google-gmail",
        name: "Gmail",
        provider: {
          id: "google",
          domain: "gmail.googleapis.com",
        },
        authentication: expect.objectContaining({ kind: "oauth2" }),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("clientSecret");
    expect(JSON.stringify(payload)).not.toContain("clientId");

    // Reviewed consent copy is served with the definition (presentation-only;
    // grants nothing). Every core definition carries it.
    const gmail = payload.definitions.find(
      (definition: { id: string }) => definition.id === "google-gmail",
    );
    expect(gmail.presentation).toMatchObject({
      providerName: "Google",
      icon: "mail",
      introduction: "Let agents work with the Gmail account you choose.",
    });
    expect(gmail.presentation.scopeLabels["https://mail.google.com/"]).toMatchObject({
      label: "Work with your Gmail mailbox",
    });
    for (const definition of payload.definitions) {
      expect(definition.presentation).toBeDefined();
    }
  });

  test("previews, fences source drift, installs, lists, and OCC-uninstalls", async () => {
    if (!available) return;
    const source = { kind: "openapi", url: "https://127.0.0.1/openapi.json" };
    const previewResponse = await request("/integrations/preview", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      protocol: "openapi",
      name: "Inventory API",
      providerDomain: "127.0.0.1",
      auth: { kind: "none" },
      tools: [
        expect.objectContaining({ id: "inventory_listitems", safety: "read" }),
        expect.objectContaining({ id: "inventory_createitem", safety: "write" }),
      ],
    });

    sourceVersion = "1.0.1";
    const drifted = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
      }),
    });
    expect(drifted.status).toBe(409);

    sourceVersion = "1.0.0";
    const optionalConnection = await createConnection(client!.db, {
      accountId,
      workspaceId,
      providerDomain: "127.0.0.1",
      kind: "api_key",
      credentialEncrypted: "test-only-optional-connection",
      createdBySubjectId: subjectId,
    });
    const installedResponse = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: optionalConnection.id,
        ownership: "workspace",
      }),
    });
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json();
    expect(installed.instanceKey).toMatch(/^account-/);
    expect(installed).toMatchObject({
      capabilityId: preview.capabilityId,
      revisionId: preview.revisionId,
      displayName: "Inventory API — connected account",
      status: "installed",
      installationVersion: 1,
      instanceVersion: 1,
    });
    expect(installed.serverId).not.toBe(preview.serverId);

    const listedResponse = await request("/integrations");
    expect(listedResponse.status).toBe(200);
    expect(await listedResponse.json()).toEqual({
      integrations: [
        expect.objectContaining({
          capabilityId: preview.capabilityId,
          serverId: installed.serverId,
          instanceId: installed.instanceId,
          instanceKey: installed.instanceKey,
          instanceVersion: installed.instanceVersion,
          definitionId: preview.definitionId,
          definitionProvenance: "workspace",
          connected: true,
          requiresConnection: false,
          connectionId: optionalConnection.id,
          ownership: "workspace",
          allowedTools: ["inventory_createitem", "inventory_listitems"],
          toolCount: 2,
          approvalRequiredToolCount: 1,
        }),
      ],
    });

    const encodedCapabilityId = encodeURIComponent(preview.capabilityId);
    const encodedInstanceKey = encodeURIComponent(installed.instanceKey);
    const uninstallPreviewResponse = await request(
      `/integrations/${encodedCapabilityId}/instances/${encodedInstanceKey}/uninstall-preview`,
    );
    expect(uninstallPreviewResponse.status).toBe(200);
    const uninstallPreview = await uninstallPreviewResponse.json();
    expect(uninstallPreview).toMatchObject({
      installed: true,
      installationVersion: 1,
      instanceVersion: 1,
      removesRuntimeIntegration: true,
      removesDefinition: true,
    });

    const stale = await request(
      `/integrations/${encodedCapabilityId}/instances/${encodedInstanceKey}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: 2,
          expectedInstanceVersion: installed.instanceVersion,
        }),
      },
    );
    expect(stale.status).toBe(409);

    const removed = await request(
      `/integrations/${encodedCapabilityId}/instances/${encodedInstanceKey}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: uninstallPreview.installationVersion,
          expectedInstanceVersion: uninstallPreview.instanceVersion,
        }),
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      capabilityId: preview.capabilityId,
      instanceKey: installed.instanceKey,
      status: "uninstalled",
      remainingOwners: [],
      definitionStatus: "disabled",
    });
  }, 60_000);

  test("preserves discovered auth placement and derives Personal ownership from the Connection", async () => {
    if (!available || !client) return;
    const connection = await createConnection(client.db, {
      accountId,
      workspaceId,
      subjectId,
      providerDomain: "127.0.0.1",
      kind: "api_key",
      credentialEncrypted: "test-only-encrypted-bundle",
      createdBySubjectId: subjectId,
    });
    const source = {
      kind: "openapi",
      url: "https://127.0.0.1/secured-openapi.json",
    };
    const previewResponse = await request("/integrations/preview", {
      method: "POST",
      body: JSON.stringify({ source, connectionId: connection.id, ownership: "personal" }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      auth: {
        kind: "api_key",
        providerDomain: "127.0.0.1",
        carrier: "query",
        name: "api_key",
      },
      connectionId: connection.id,
      connectionOwnership: "personal",
    });

    const wrongKindConnection = await createConnection(client.db, {
      accountId,
      workspaceId,
      subjectId,
      providerDomain: "127.0.0.1",
      kind: "oauth2",
      credentialEncrypted: "test-only-wrong-kind-encrypted-bundle",
      createdBySubjectId: subjectId,
    });
    const wrongKind = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: wrongKindConnection.id,
        ownership: "personal",
      }),
    });
    expect(wrongKind.status).toBe(422);

    const mismatched = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: connection.id,
        ownership: "workspace",
      }),
    });
    expect(mismatched.status).toBe(422);

    const installedResponse = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: connection.id,
        ownership: "personal",
      }),
    });
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json();

    const listedResponse = await request("/integrations");
    expect(listedResponse.status).toBe(200);
    expect(await listedResponse.json()).toEqual({
      integrations: [
        expect.objectContaining({
          capabilityId: installed.capabilityId,
          ownership: "personal",
          requiresConnection: true,
          allowedTools: ["querykey_listitems"],
        }),
      ],
    });

    const otherSubjectId = "user:api-integration-route-other";
    const otherList = await request("/integrations", {}, otherSubjectId);
    expect(otherList.status).toBe(200);
    expect(await otherList.json()).toEqual({ integrations: [] });

    const encodedInstancePath = `/integrations/${encodeURIComponent(installed.capabilityId)}/instances/${encodeURIComponent(installed.instanceKey)}`;
    const otherPreview = await request(
      `${encodedInstancePath}/uninstall-preview`,
      {},
      otherSubjectId,
    );
    expect(otherPreview.status).toBe(200);
    expect(await otherPreview.json()).toMatchObject({ installed: false });

    const otherRemoval = await request(
      encodedInstancePath,
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: installed.installationVersion,
          expectedInstanceVersion: installed.instanceVersion,
        }),
      },
      otherSubjectId,
    );
    expect(otherRemoval.status).toBe(200);
    expect(await otherRemoval.json()).toMatchObject({ status: "not_installed" });

    const ownerStillLists = await request("/integrations");
    expect((await ownerStillLists.json()).integrations).toHaveLength(1);

    const removed = await request(encodedInstancePath, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: installed.installationVersion,
        expectedInstanceVersion: installed.instanceVersion,
      }),
    });
    expect(removed.status).toBe(200);
  }, 60_000);

  test("controls generic Integration facets through the public lifecycle", async () => {
    if (!available || !client) return;
    const connection = await createConnection(client.db, {
      accountId,
      workspaceId,
      providerDomain: "127.0.0.1",
      kind: "api_key",
      credentialEncrypted: "route-facet-encrypted-bundle",
      createdBySubjectId: subjectId,
    });
    const installed = await installApiIntegration(client.db, {
      accountId,
      workspaceId,
      subjectId,
      capabilityId: "api:route-facet-control",
      pluginKey: "integration/route-facet-control",
      serverId: "route_feature_control",
      name: "Route facet control",
      description: "Exercises the generic facet HTTP lifecycle.",
      definitionId: "route-facet-control",
      definitionProvenance: "workspace",
      providerDomain: "127.0.0.1",
      protocol: "openapi",
      baseUrl: "https://127.0.0.1/v1/",
      sourceUrl: "https://127.0.0.1/openapi.json",
      authScheme: { kind: "api_key", carrier: "header", name: "Authorization" },
      connectionId: connection.id,
      instanceKey: "finance",
      facetDefinitions: [
        {
          facetKey: "inventory-source",
          kind: "knowledge_source",
          configSchema: {
            type: "object",
            required: ["collection"],
            properties: {
              collection: { type: "string", minLength: 1, maxLength: 128 },
              includeArchived: { type: "boolean" },
            },
            additionalProperties: false,
          },
          capabilities: { connectionRequired: true, sync: "incremental" },
        },
      ],
      revision: {
        id: "openapi:333333333333333333333333",
        protocol: "openapi",
        definitionId: "route-facet-control",
        contentSha256: "3".repeat(64),
        source: { url: "https://127.0.0.1/openapi.json" },
        title: "Route facet control",
        tools: [
          {
            id: "list_items",
            operationKey: "inventory.listItems",
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
            serverUrl: "https://127.0.0.1/v1/",
            parameters: [],
          },
        },
      },
    });
    const base = `/integrations/${encodeURIComponent(installed.capabilityId)}/instances/finance/facets`;
    const listed = await request(base);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      capabilityId: installed.capabilityId,
      instanceKey: "finance",
      connectionId: connection.id,
      facets: [
        {
          definition: {
            facetKey: "inventory-source",
            kind: "knowledge_source",
          },
          binding: null,
        },
      ],
    });

    const configureKey = crypto.randomUUID();
    const configuredResponse = await request(`${base}/inventory-source`, {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Finance inventory",
        config: { collection: "finance", includeArchived: false },
        idempotencyKey: configureKey,
      }),
    });
    expect(configuredResponse.status).toBe(201);
    const configured = await configuredResponse.json();
    expect(configured).toMatchObject({
      status: "configured",
      binding: {
        connectionId: connection.id,
        status: "active",
        version: 1,
        directlyOwned: true,
        owners: [
          {
            kind: "direct",
            id: expect.stringMatching(/^facet:[0-9a-f]{64}$/),
            removable: true,
          },
        ],
      },
    });
    const legacyConfigured = {
      ...configured,
      binding: { ...configured.binding },
    };
    delete legacyConfigured.binding.directlyOwned;
    delete legacyConfigured.binding.owners;
    await shared!.admin`
      update capability_operations
      set result = ${shared!.admin.json(legacyConfigured)}
      where workspace_id = ${workspaceId}::uuid
        and idempotency_key = ${configureKey}
    `;
    const replay = await request(`${base}/inventory-source`, {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Finance inventory",
        config: { collection: "finance", includeArchived: false },
        idempotencyKey: configureKey,
      }),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(configured);
    const crossSubjectReplay = await request(
      `${base}/inventory-source`,
      {
        method: "PUT",
        body: JSON.stringify({
          displayName: "Finance inventory",
          config: { collection: "finance", includeArchived: false },
          idempotencyKey: configureKey,
        }),
      },
      "user:api-integration-route-other-admin",
    );
    expect(crossSubjectReplay.status).toBe(409);

    const invalid = await request(`${base}/inventory-source`, {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Invalid inventory",
        config: { collection: "finance", unsupported: true },
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(invalid.status).toBe(422);

    const pausedResponse = await request(`${base}/inventory-source/pause`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: configured.binding.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(pausedResponse.status).toBe(200);
    const paused = await pausedResponse.json();
    expect(paused).toMatchObject({
      status: "paused",
      binding: {
        status: "paused",
        version: 2,
        directlyOwned: true,
        owners: configured.binding.owners,
      },
    });

    const staleResume = await request(`${base}/inventory-source/resume`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: configured.binding.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(staleResume.status).toBe(409);
    const resumedResponse = await request(`${base}/inventory-source/resume`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: paused.binding.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(resumedResponse.status).toBe(200);
    const resumed = await resumedResponse.json();
    expect(resumed).toMatchObject({
      status: "active",
      binding: {
        status: "active",
        version: 3,
        directlyOwned: true,
        owners: configured.binding.owners,
      },
    });

    const removed = await request(`${base}/inventory-source`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedVersion: resumed.binding.version,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      status: "removed",
      binding: { status: "disabled", version: 4, directlyOwned: false, owners: [] },
      remainingOwners: [],
    });

    await shared!.admin`
      update capability_plugin_installations
      set status = 'disabled', updated_at = now()
      where id = ${installed.pluginInstallationId}
    `;
    expect((await request(base)).status).toBe(404);
    const replayAfterInstanceDrift = await request(`${base}/inventory-source`, {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Finance inventory",
        config: { collection: "finance", includeArchived: false },
        idempotencyKey: configureKey,
      }),
    });
    expect(replayAfterInstanceDrift.status).toBe(201);
    expect(await replayAfterInstanceDrift.json()).toEqual(configured);
    const conflictAfterInstanceDrift = await request(`${base}/inventory-source`, {
      method: "PUT",
      body: JSON.stringify({
        displayName: "Changed inventory",
        config: { collection: "finance", includeArchived: false },
        idempotencyKey: configureKey,
      }),
    });
    expect(conflictAfterInstanceDrift.status).toBe(409);
  }, 60_000);

  test("replays completed Google Drive facet saves before provider and Connection validation", async () => {
    if (!available || !client) return;
    googleDriveFolderName = "Product";
    googleDriveProviderRequests.length = 0;
    const connection = await createConnection(client.db, {
      accountId,
      workspaceId,
      subjectId,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: encryptEnvironmentValue(
        environmentsEncryptionKey,
        JSON.stringify({ access_token: "route-google-access", token_type: "Bearer" }),
      ),
      grantedScopes: [GOOGLE_DRIVE_READONLY_SCOPE],
      expiresAt: new Date(Date.now() + 60 * 60_000),
      metadata: GoogleDriveConnectionMetadata.parse({
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
        googlePermissionId: "route-google-permission",
        googleEmail: "route-google@example.com",
        googleDisplayName: "Route Google",
        verifiedAt: "2026-08-14T06:00:00.000Z",
        accessMode: "readonly",
        lifecycle: {
          state: "active",
          recoverable: true,
          observedAt: "2026-08-14T06:00:00.000Z",
        },
      }),
      createdBySubjectId: subjectId,
    });
    const installed = await installApiIntegration(client.db, {
      accountId,
      workspaceId,
      subjectId,
      capabilityId: "api:route-google-drive-facet",
      pluginKey: "integration/route-google-drive-facet",
      serverId: "route_google_drive_facet",
      name: "Route Google Drive",
      description: "Exercises provider-specific facet receipt replay.",
      definitionId: "route-google-drive-facet",
      definitionProvenance: "workspace",
      providerDomain: "googleapis.com",
      protocol: "openapi",
      baseUrl: GOOGLE_DRIVE_INTEGRATION_DEFINITION.baseUrl,
      sourceUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
      authScheme: { kind: "oauth2" },
      connectionId: connection.id,
      instanceKey: "finance",
      requiredScopes: [GOOGLE_DRIVE_READONLY_SCOPE],
      ownership: "subject",
      facetDefinitions: GOOGLE_DRIVE_INTEGRATION_DEFINITION.facets,
      revision: {
        id: "openapi:444444444444444444444444",
        protocol: "openapi",
        definitionId: "route-google-drive-facet",
        contentSha256: "4".repeat(64),
        source: { url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest" },
        title: "Route Google Drive",
        tools: [
          {
            id: "files_get",
            operationKey: "drive.files.get",
            name: "Get file",
            description: "Get Drive metadata.",
            inputSchema: { type: "object", properties: {} },
            safety: "read",
            approvalMode: "never",
            deprecated: false,
          },
        ],
        bindings: {
          files_get: {
            method: "get",
            pathTemplate: "/files/{fileId}",
            serverUrl: GOOGLE_DRIVE_INTEGRATION_DEFINITION.baseUrl,
            parameters: [],
          },
        },
      },
    });
    const endpoint = `/integrations/${encodeURIComponent(installed.capabilityId)}/instances/${installed.instanceKey}/facets/drive-content/source`;
    const aliasCollisionKey = crypto.randomUUID();
    const aliasCollision = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({
        sources: [
          {
            id: "folder-1",
            name: "Product",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
          },
          {
            id: "https://drive.google.com/drive/folders/folder-1",
            name: "Product",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
          },
        ],
        destination: { authorityKind: "workspace", collectionId: null },
        syncCadence: "hourly",
        syncEnabled: true,
        readPolicy: "allow",
        idempotencyKey: aliasCollisionKey,
      }),
    });
    expect(aliasCollision.status).toBe(400);
    expect(await aliasCollision.text()).toBe("Google Drive sources must be unique");
    expect(googleDriveProviderRequests).toHaveLength(0);
    expect(
      await shared!.admin<Array<{ count: number }>>`
        select count(*)::int as count
        from capability_operations
        where workspace_id = ${workspaceId}::uuid
          and idempotency_key = ${aliasCollisionKey}
      `,
    ).toEqual([{ count: 0 }]);

    const idempotencyKey = crypto.randomUUID();
    const payload = {
      sources: [
        {
          id: "https://drive.google.com/drive/folders/folder-1",
          name: "Product",
          mimeType: "application/vnd.google-apps.folder",
          driveId: null,
        },
      ],
      destination: { authorityKind: "workspace", collectionId: null },
      syncCadence: "hourly",
      syncEnabled: true,
      readPolicy: "allow",
      idempotencyKey,
    };
    const configuredResponse = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    expect(configuredResponse.status).toBe(200);
    const configured = await configuredResponse.json();
    expect(configured).toMatchObject({
      status: "configured",
      binding: {
        connectionId: connection.id,
        status: "active",
        version: 1,
        config: { sources: [{ id: "folder-1" }] },
      },
    });
    expect(googleDriveProviderRequests).toHaveLength(1);

    const legacyConfigured = {
      ...configured,
      binding: { ...configured.binding },
    };
    delete legacyConfigured.binding.directlyOwned;
    delete legacyConfigured.binding.owners;
    await shared!.admin`
      update capability_operations
      set result = ${shared!.admin.json(legacyConfigured)}
      where workspace_id = ${workspaceId}::uuid
        and idempotency_key = ${idempotencyKey}
    `;

    googleDriveFolderName = "Renamed Product";
    await shared!.admin`
      update connections
      set status = 'revoked', version = version + 1, updated_at = now()
      where id = ${connection.id}
    `;
    const providerRequestCount = googleDriveProviderRequests.length;
    const replay = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(configured);
    expect(googleDriveProviderRequests).toHaveLength(providerRequestCount);

    const conflict = await request(endpoint, {
      method: "PUT",
      body: JSON.stringify({
        ...payload,
        sources: [{ ...payload.sources[0], name: "Renamed Product" }],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(googleDriveProviderRequests).toHaveLength(providerRequestCount);

    const crossSubjectReplay = await request(
      endpoint,
      { method: "PUT", body: JSON.stringify(payload) },
      "user:api-integration-route-other-admin",
    );
    expect(crossSubjectReplay.status).toBe(409);
    expect(googleDriveProviderRequests).toHaveLength(providerRequestCount);
  }, 60_000);
});
