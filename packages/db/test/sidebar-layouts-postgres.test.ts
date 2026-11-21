import { afterAll, beforeAll, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createWorkspace,
  createWorkspaceArtifact,
  readSidebarApps,
  readSidebarLayouts,
  writeSidebarLayout,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sidebar-layouts");
  if (!shared && requireRealDatabase) throw new Error("sidebar layouts require PostgreSQL");
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspace(name: string) {
  const [account] = await shared!
    .admin`insert into managed_accounts (name) values (${name}) returning id`;
  const accountId = String(account!.id);
  const workspaceId = (await createWorkspace(client!.db, { accountId, name })).id;
  return { accountId, workspaceId };
}

async function app(
  scope: { accountId: string; workspaceId: string },
  title: string,
  owner: string | null,
) {
  const created = await createWorkspaceArtifact(client!.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `sidebar-${crypto.randomUUID().slice(0, 8)}`,
    title,
    description: null,
    visibility: owner ? "user_private" : "workspace_shared",
    ownerSubjectId: owner,
    contentKey: `sites/${crypto.randomUUID()}.html`,
    contentSha256: "a".repeat(64),
    sizeBytes: 16,
    sourceKey: null,
    sourceSha256: null,
    sourceSizeBytes: null,
    operationKey: crypto.randomUUID(),
    actorSubjectId: owner ?? "user:owner",
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
    persistContent: async () => undefined,
    discardContent: async () => undefined,
  });
  return created.artifact.id;
}

test("the workspace default and a person's changes are separate rows with their own revisions", async () => {
  if (!shared || !client) return;
  const scope = await workspace("Sidebar layouts");
  const other = await workspace("Sidebar layouts elsewhere");
  const db = client.db;
  expect(await readSidebarLayouts(db, scope, "user:ada")).toEqual({
    workspace: null,
    personal: null,
  });
  const first = await writeSidebarLayout(db, scope, {
    subjectId: null,
    expectedRevision: 0,
    layout: { version: 1, items: [{ id: "g", type: "group", label: "Team", items: [] }] },
    updatedBy: "user:admin",
  });
  expect(first?.revision).toBe(1);
  // A second first write loses (compare-and-set), and so does a stale revision.
  expect(
    await writeSidebarLayout(db, scope, {
      subjectId: null,
      expectedRevision: 0,
      layout: { version: 1, items: [] },
      updatedBy: "user:admin",
    }),
  ).toBeNull();
  const second = await writeSidebarLayout(db, scope, {
    subjectId: null,
    expectedRevision: 1,
    layout: { version: 1, items: [], future: true },
    updatedBy: "user:admin",
  });
  expect(second?.revision).toBe(2);
  expect(
    await writeSidebarLayout(db, scope, {
      subjectId: null,
      expectedRevision: 1,
      layout: { version: 1, items: [] },
      updatedBy: "user:admin",
    }),
  ).toBeNull();
  const mine = await writeSidebarLayout(db, scope, {
    subjectId: "user:ada",
    expectedRevision: 0,
    layout: { version: 1, hidden: ["x"], added: [], order: {} },
    updatedBy: "user:ada",
  });
  expect(mine?.revision).toBe(1);
  const read = await readSidebarLayouts(db, scope, "user:ada");
  expect(read.workspace?.revision).toBe(2);
  // Unknown fields are kept as written.
  expect(read.workspace?.layout).toEqual({ version: 1, items: [], future: true });
  expect(read.personal?.layout).toEqual({ version: 1, hidden: ["x"], added: [], order: {} });
  // Someone else has no changes of their own, and another workspace sees nothing.
  expect((await readSidebarLayouts(db, scope, "user:bob")).personal).toBeNull();
  expect(await readSidebarLayouts(db, other, "user:ada")).toEqual({
    workspace: null,
    personal: null,
  });
});

test("only apps the viewer can open are returned; archived and other people's private apps drop out", async () => {
  if (!shared || !client) return;
  const scope = await workspace("Sidebar apps");
  const shared1 = await app(scope, "Releases", null);
  const archived = await app(scope, "Old", null);
  const theirs = await app(scope, "Bob's", "user:bob");
  await shared.admin`update workspace_artifacts set status = 'archived' where id = ${archived}::uuid`;
  const read = await readSidebarApps(client.db, scope, {
    viewer: { subjectId: "user:ada" },
    appIds: [shared1, archived, theirs, crypto.randomUUID(), "not-a-uuid"],
    pinnedLimit: 5,
    recentLimit: 5,
  });
  expect([...read.apps.keys()]).toEqual([shared1.toLowerCase()]);
  expect(read.apps.get(shared1.toLowerCase())?.title).toBe("Releases");
  const bob = await readSidebarApps(client.db, scope, {
    viewer: { subjectId: "user:bob" },
    appIds: [theirs],
    pinnedLimit: 0,
    recentLimit: 0,
  });
  expect(bob.apps.has(theirs.toLowerCase())).toBe(true);
});
