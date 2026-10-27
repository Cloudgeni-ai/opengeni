import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  signDelegatedAccessToken,
  type KnowledgeSavePreparationResponse,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  saveKnowledgeEntry,
  withDatabaseTimingObserver,
  type DbClient,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("knowledge-preparation-batch");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema, max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("Knowledge preparation retains the current collection map with bounded catalog reads", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "knowledge-preparation-test",
    accountExternalId: suffix,
    accountName: "Knowledge preparation",
    workspaceExternalSource: "knowledge-preparation-test",
    workspaceExternalId: suffix,
    workspaceName: "Knowledge preparation",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const context: KnowledgeContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: grant.subjectId,
      writeScopes: ["workspace", "personal"],
      review: true,
      settingsScopes: [],
    },
  };
  const expected = [];
  for (let index = 0; index < 20; index++) {
    const title = `Collection ${index}`;
    const content = `Knowledge collection ${index} description`;
    const receipt = await saveKnowledgeEntry(client.db, context, {
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      entry: { kind: "group", title, content },
    });
    expected.push({ id: receipt.entryId, title, description: content });
  }
  expected.sort((a, b) => a.id.localeCompare(b.id));
  const secret = "knowledge-preparation-batch-secret";
  const app = new Hono();
  registerKnowledgeRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    managedAuth: null,
    getDocumentServices: () => ({
      embedder: {
        model: "fixture-embedding",
        dimensions: 2,
        embedQuery: async () => [1, 0],
        embedMany: async () => [],
      },
    }),
  } as never);
  const token = await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    principalKind: "human_session",
    permissions: ["documents:search", "documents:manage"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const transactions: number[] = [];
  const durationsMs: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    let count = 0;
    const start = performance.now();
    const response = await withDatabaseTimingObserver(
      (observation) => {
        if (observation.stage === "transaction_admission") count++;
      },
      () =>
        app.request(`/v1/workspaces/${grant.workspaceId}/knowledge/entries/prepare-save`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ query: "Knowledge" }),
        }),
    );
    const body = (await response.json()) as KnowledgeSavePreparationResponse;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(
      body.collections.entries.map(({ id, title, description }) => ({ id, title, description })),
    ).toEqual(expected);
    expect(body.collections.complete).toBe(true);
    expect(body.collections.nextCursors).toEqual({ published: null, needs_review: null });
    transactions.push(count);
    durationsMs.push(performance.now() - start);
  }
  console.info("knowledge-preparation-work", JSON.stringify({ transactions, durationsMs }));
  // Authorization, two searches (each reading the workspace's EU-only setting
  // before its query may reach the embedder), two catalog pages and one
  // current-view batch. The scalar catalog path needed 25 transactions for
  // these same 20 entries.
  expect(transactions).toEqual([8, 8, 8]);
}, 180_000);
