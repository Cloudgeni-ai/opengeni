import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as db from "@opengeni/db";
import { WorkspaceModelCatalogResponse } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

let fixture: SharedTestDatabase;
let client: db.DbClient;
let app: ReturnType<typeof createApp>;
let grant: Awaited<ReturnType<typeof db.bootstrapWorkspace>>["workspaceGrants"][number];
let headers: Record<string, string>;
const credential = "not-decrypted-by-public-catalog";

beforeAll(async () => {
  const shared = await acquireSharedTestDatabase("model-catalog-http-scope");
  if (!shared) throw Error("Real PostgreSQL required");
  fixture = shared;
  client = db.createDb(shared.appUrl);
  const context = await db.bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Catalog scope",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Catalog scope",
    subjectId: "user:catalog-scope",
  });
  grant = context.workspaceGrants[0]!;
  const token = crypto.randomUUID();
  await db.createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Catalog fixture",
    prefix: "fixture",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin", "workspace:create", "members:manage", "api_keys:manage"],
  });
  headers = { authorization: `Bearer ${token}` };
  app = createApp({
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      sandboxBackend: "none",
      codexSubscriptionEnabled: false,
      claudeSubscriptionEnabled: false,
    }),
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
  });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

const request = (extra: Record<string, string> = {}) =>
  app.request(`/v1/workspaces/${grant.workspaceId}/model-catalog`, {
    headers: { ...headers, ...extra },
  });

test("HTTP catalogs use one fresh public metadata scope for organization keys and external actors", async () => {
  const load = spyOn(db, "loadWorkspaceModelCatalogInputs");
  try {
    for (const extra of [
      {},
      {
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({ mode: "external", identity: { source: "test", externalId: "viewer" } }),
        ),
      },
    ]) {
      load.mockClear();
      const response = await request(extra);
      expect(response.status).toBe(200);
      WorkspaceModelCatalogResponse.parse(await response.json());
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0]?.[1]).toEqual({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        providerKinds: ["vercel_gateway", "openrouter", "opper", "anthropic"],
        organizationProviderKinds: [
          "vercel_gateway",
          "openrouter",
          "opper",
          "anthropic",
          "openai",
          "azure_openai",
        ],
      });
    }
  } finally {
    load.mockRestore();
  }
});

test("subsequent catalog requests observe custom-model creation and retirement without credentials", async () => {
  const spec = db.workspaceProviderApiKeyConnectionSpec("vercel_gateway");
  await db.createConnection(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: null,
    kind: "api_key",
    providerDomain: spec.providerDomain,
    metadata: { credentialRole: spec.credentialRole },
    credentialEncrypted: credential,
    createdBySubjectId: grant.subjectId,
  });
  const model = await db.createWorkspaceProviderCustomModel(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    providerKind: "vercel_gateway",
    upstreamModelId: "fixture/catalog-scope",
    operationId: crypto.randomUUID(),
    requestHash: "a".repeat(64),
    createdBySubjectId: grant.subjectId,
  });
  expect(model).not.toBeNull();
  const response = await request();
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(credential);
  expect(WorkspaceModelCatalogResponse.parse(JSON.parse(body)).models.map((m) => m.id)).toContain(
    "workspace-gateway/fixture/catalog-scope",
  );
  const retired = await db.deleteWorkspaceProviderCustomModel(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    providerKind: "vercel_gateway",
    customModelId: model!.id,
    expectedVersion: model!.version,
    operationId: crypto.randomUUID(),
    requestHash: "b".repeat(64),
  });
  expect(retired.outcome).toBe("success");
  const next = await request();
  expect(next.status).toBe(200);
  expect(
    WorkspaceModelCatalogResponse.parse(await next.json()).models.map((m) => m.id),
  ).not.toContain("workspace-gateway/fixture/catalog-scope");
});

test("a public metadata failure remains fatal rather than an empty successful catalog", async () => {
  const load = spyOn(db, "loadWorkspaceModelCatalogInputs").mockRejectedValueOnce(
    new Error("catalog read failed"),
  );
  try {
    expect((await request()).status).toBe(500);
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    load.mockRestore();
  }
  expect((await request()).status).toBe(200);
});
