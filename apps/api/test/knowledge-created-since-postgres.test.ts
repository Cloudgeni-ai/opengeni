import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { signDelegatedAccessToken, type KnowledgeEntryListResponse } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-created-since-api");
  if (!acquired) throw new Error("Knowledge creation-date API verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("list query strings and search JSON apply the same creation cutoff, pagination and date validation", async () => {
  const secret = "knowledge-created-since-api-test";
  const subjectId = `user:${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Knowledge cutoff",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const context: KnowledgeContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace"],
      review: true,
      settingsScopes: ["workspace"],
    },
  };
  const saved = [];
  for (let index = 0; index < 3; index++)
    saved.push(
      await saveKnowledgeEntry(client.db, context, {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        entry: { kind: "fact", title: "Creation cutoff", content: "Creation cutoff regression" },
      }),
    );
  await shared.admin`UPDATE knowledge_entries SET created_at='2026-09-01T00:00:00Z',updated_at='2026-10-06T08:00:00Z'
    WHERE id=${saved[0]!.entryId}`;
  await shared.admin`UPDATE knowledge_entries SET created_at='2026-10-01T00:00:00Z'
    WHERE id IN (${saved[1]!.entryId},${saved[2]!.entryId})`;
  const expected = saved
    .slice(1)
    .map((entry) => entry.entryId)
    .sort();
  const settings = testSettings({ productAccessMode: "managed", delegationSecret: secret });
  const app = new Hono();
  registerKnowledgeRoutes(app, {
    settings,
    db: client.db,
    managedAuth: null,
    getDocumentServices: () => ({ embedder: null }),
  } as unknown as ApiRouteDeps);
  const authorization = `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["documents:search"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
  const base = `http://test/v1/workspaces/${grant.workspaceId}/knowledge/entries`;
  for (const method of ["GET", "POST"] as const) {
    const request = async (input: Record<string, string | number>) => {
      return method === "GET"
        ? app.request(
            `${base}?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`,
            { headers: { authorization } },
          )
        : app.request(`${base}/search`, {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
    };
    const input = {
      query: "Creation",
      mode: "keyword",
      createdSince: "2026-10-01T00:00:00Z",
      limit: 1,
    };
    const response = await request(input);
    expect(response.status).toBe(200);
    const page = (await response.json()) as KnowledgeEntryListResponse;
    expect(page.entries.map((entry) => entry.id)).toEqual(expected.slice(0, 1));
    expect(page.nextCursor).not.toBeNull();
    const second = await request({ ...input, cursor: page.nextCursor! });
    expect(second.status).toBe(200);
    const next = (await second.json()) as KnowledgeEntryListResponse;
    expect(next.entries.map((entry) => entry.id)).toEqual(expected.slice(1));
    expect(next.nextCursor).toBeNull();
    expect(
      (await request({ ...input, createdSince: "2026-10-02T00:00:00Z", cursor: page.nextCursor! }))
        .status,
    ).toBe(422);
    for (const createdSince of ["invalid", "2026-10-01", "2026-10-01T00:00:00"])
      expect((await request({ ...input, createdSince })).status).toBe(422);
  }
}, 180_000);
