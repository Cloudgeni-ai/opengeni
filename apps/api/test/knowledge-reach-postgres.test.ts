import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { signDelegatedAccessToken, type KnowledgeEntryReachRecord } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createWorkspace,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { registerKnowledgeRoutes } from "../src/routes/knowledge";

// GET and PUT .../knowledge/entries/:entryId/reach (migration 1196).

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-reach-api");
  if (!acquired) throw new Error("Knowledge reach API verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("people read where an entry works and its owner or managers change it", async () => {
  const secret = "knowledge-reach-api-test";
  const subjectId = `user:${crypto.randomUUID()}`;
  const key = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: key,
      accountName: "Knowledge reach",
      workspaceExternalSource: "test",
      workspaceExternalId: key,
      workspaceName: "Team",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const elsewhere = await createWorkspace(client.db, { accountId: grant.accountId, name: "Other" });
  const context: KnowledgeContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal", "organization"],
      review: true,
      settingsScopes: ["workspace"],
    },
  };
  const add = async (scope: "organization" | "workspace" | "personal") =>
    (
      await saveKnowledgeEntry(client.db, context, {
        operationId: crypto.randomUUID(),
        expectedVersion: 0,
        scope,
        entry: { kind: "fact", title: `Reach ${scope}`, content: "Where this works" },
      })
    ).entryId;
  const organizationEntry = await add("organization");
  const personalEntry = await add("personal");
  const workspaceEntry = await add("workspace");

  const app = new Hono();
  registerKnowledgeRoutes(app, {
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
    db: client.db,
    managedAuth: null,
    getDocumentServices: () => ({ embedder: null }),
  } as unknown as ApiRouteDeps);
  const token = async (permissions: string[]) =>
    `Bearer ${await signDelegatedAccessToken(secret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId,
      principalKind: "human_session",
      permissions,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
  const reader = await token(["documents:search"]);
  const writer = await token(["documents:search", "documents:manage"]);
  const url = (entryId: string) =>
    `http://test/v1/workspaces/${grant.workspaceId}/knowledge/entries/${entryId}/reach`;
  const put = (entryId: string, body: unknown, authorization = writer) =>
    app.request(url(entryId), {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const read = await app.request(url(personalEntry), { headers: { authorization: reader } });
  expect(read.status).toBe(200);
  expect((await read.json()) as KnowledgeEntryReachRecord).toEqual({
    entryId: personalEntry,
    scope: "personal",
    originWorkspaceId: grant.workspaceId,
    reach: { allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
    canChange: false,
  });
  expect(
    (await app.request(url(crypto.randomUUID()), { headers: { authorization: reader } })).status,
  ).toBe(404);

  // Readers can't change it; its owner can, to all their workspaces.
  expect(
    (await put(personalEntry, { allowedWorkspaceIds: null, allowPersonalWorkspaces: true }, reader))
      .status,
  ).toBe(403);
  const changed = await put(personalEntry, {
    allowedWorkspaceIds: null,
    allowPersonalWorkspaces: true,
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as KnowledgeEntryReachRecord).reach).toEqual({
    allowedWorkspaceIds: null,
    allowPersonalWorkspaces: true,
  });
  // A workspace they don't belong to is refused; so is a bad body.
  const notTheirs = await put(personalEntry, {
    allowedWorkspaceIds: [elsewhere.id],
    allowPersonalWorkspaces: true,
  });
  expect(notTheirs.status).toBe(422);
  expect(await notTheirs.text()).toContain(elsewhere.id);
  expect((await put(personalEntry, { allowedWorkspaceIds: null })).status).toBe(422);

  // Organization entries need the organization's Knowledge write access,
  // which a workspace grant alone doesn't give.
  const organization = await app.request(url(organizationEntry), {
    headers: { authorization: writer },
  });
  expect(((await organization.json()) as KnowledgeEntryReachRecord).canChange).toBe(false);
  expect(
    (await put(organizationEntry, { allowedWorkspaceIds: [], allowPersonalWorkspaces: false }))
      .status,
  ).toBe(403);
  // Workspace entries never leave their workspace.
  expect(
    (await put(workspaceEntry, { allowedWorkspaceIds: null, allowPersonalWorkspaces: true }))
      .status,
  ).toBe(409);
});
