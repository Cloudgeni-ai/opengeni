import { afterAll, beforeAll, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const secret = "synthetic-compaction-settings-delegation-secret";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let app: ReturnType<typeof createApp>;
let grant: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("api-model-compaction");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Synthetic account",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Synthetic workspace",
    subjectId: `user:${id}`,
  });
  grant = access.workspaceGrants[0]!;
  app = createApp({
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    db: client.db,
    bus: new MemoryEventBus(),
  });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function request(
  path: string,
  patch?: unknown,
  permissions: Permission[] = ["workspace:read", "workspace:admin"],
) {
  const token = await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return app.request(`http://test/v1/workspaces/${grant.workspaceId}/${path}`, {
    method: patch === undefined ? "GET" : "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
  });
}

test("workspace admin preference is projected in the catalog and reset independently", async () => {
  const initial = await request("model-catalog");
  expect(initial.status).toBe(200);
  const model = (await initial.json()).models[0];
  expect(model.compactionPolicy.overrideTokens).toBeNull();
  const threshold = Math.min(95_000, model.compactionPolicy.maximumTokens);
  const patch = { modelCompactionThresholds: { [model.id]: threshold } };
  expect((await request("settings", patch, ["workspace:read"])).status).toBe(403);
  expect(
    (await request("settings", { modelCompactionThresholds: { [model.id]: -1 } })).status,
  ).toBe(400);
  expect((await request("settings", patch)).status).toBe(200);
  const saved = (await (await request("model-catalog")).json()).models.find(
    (row: { id: string }) => row.id === model.id,
  );
  expect(saved.compactionPolicy).toMatchObject({
    overrideTokens: threshold,
    effectiveTokens: threshold,
  });
  expect(saved.executionLimits).toEqual(model.executionLimits);
  expect(
    (await request("settings", { modelCompactionThresholds: { [model.id]: null } })).status,
  ).toBe(200);
  const reset = (await (await request("model-catalog")).json()).models.find(
    (row: { id: string }) => row.id === model.id,
  );
  expect(reset.compactionPolicy).toEqual(model.compactionPolicy);
}, 30_000);
