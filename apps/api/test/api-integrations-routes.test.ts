import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
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

import { registerApiIntegrationRoutes } from "../src/routes/api-integrations";

const delegationSecret = "api-integration-route-secret";
let sourceVersion = "1.0.0";
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
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function auth(): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read", "workspace:admin"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return await app!.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: {
      authorization: await auth(),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("API Integration routes", () => {
  test("lists curated provider presets without deployment OAuth credentials", async () => {
    if (!available) return;
    const response = await request("/integrations/presets");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.presets).toHaveLength(6);
    expect(payload.presets).toContainEqual(
      expect.objectContaining({
        id: "google-gmail",
        name: "Gmail",
        family: "google",
        providerDomain: "gmail.googleapis.com",
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("clientSecret");
    expect(JSON.stringify(payload)).not.toContain("clientId");
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
    const installedResponse = await request("/integrations/install", {
      method: "POST",
      body: JSON.stringify({
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
      }),
    });
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json();
    expect(installed).toMatchObject({
      capabilityId: preview.capabilityId,
      revisionId: preview.revisionId,
      instanceKey: "default",
      displayName: "Inventory API",
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
          presetId: null,
          connected: false,
          connectionId: null,
          ownership: "none",
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
        expect.objectContaining({ capabilityId: installed.capabilityId, ownership: "personal" }),
      ],
    });

    const removed = await request(
      `/integrations/${encodeURIComponent(installed.capabilityId)}/instances/${encodeURIComponent(installed.instanceKey)}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: installed.installationVersion,
          expectedInstanceVersion: installed.instanceVersion,
        }),
      },
    );
    expect(removed.status).toBe(200);
  }, 60_000);
});
