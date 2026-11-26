import { afterAll, beforeAll, expect, test } from "bun:test";

import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createWorkspace,
  createWorkspaceArtifact,
  readSidebarLinkedApps,
  readSidebarApps,
  readSidebarLayouts,
  recordSiteOpened,
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

test("recent apps are the ones this person opened or edited last, under their own identity", async () => {
  if (!shared || !client) return;
  const scope = await workspace("Sidebar recent apps");
  // Version 1 of each is published by user:owner (an edit of theirs).
  const first = await app(scope, "First", null);
  const second = await app(scope, "Second", null);
  const bobs = await app(scope, "Bob's", "user:bob");
  const open = (subjectId: string, siteId: string) =>
    recordSiteOpened(client!.db, {
      workspaceId: scope.workspaceId,
      subjectId,
      viewer: { subjectId },
      siteId,
    });
  await open("user:ada", first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await open("user:ada", second);
  await open("user:bob", bobs);
  const recent = async (subjectId: string) =>
    (
      await readSidebarApps(client!.db, scope, {
        viewer: { subjectId },
        appIds: [],
        pinnedLimit: 0,
        recentLimit: 5,
      })
    ).recent.map((entry) => entry.title);
  // Newest first; someone else's opens and Only me apps never show.
  expect(await recent("user:ada")).toEqual(["Second", "First"]);
  expect(await recent("user:bob")).toEqual(["Bob's"]);
  // Editing counts too: user:owner published both and opened neither.
  expect((await recent("user:owner")).sort()).toEqual(["First", "Second"]);
  expect(await recent("user:nobody")).toEqual([]);
});

test("an app a person archived from their own sidebar drops out for them only", async () => {
  if (!shared || !client) return;
  const scope = await workspace("Sidebar archived apps");
  const kept = await app(scope, "Kept", null);
  const board = await app(scope, "Feedback board", null);
  await recordSiteOpened(client.db, {
    workspaceId: scope.workspaceId,
    subjectId: "user:ada",
    viewer: { subjectId: "user:ada" },
    siteId: board,
  });
  await shared.admin`
    insert into site_sidebar_states (account_id, workspace_id, subject_id, site_id, archived_at)
    values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, 'user:ada', ${board}::uuid, now())`;
  const read = (subjectId: string) =>
    readSidebarApps(client!.db, scope, {
      viewer: { subjectId },
      appIds: [kept, board],
      pinnedLimit: 0,
      recentLimit: 5,
    });
  const ada = await read("user:ada");
  expect([...ada.apps.keys()]).toEqual([kept.toLowerCase()]);
  expect(ada.recent.map((entry) => entry.title)).not.toContain("Feedback board");
  const bob = await read("user:bob");
  expect([...bob.apps.keys()].sort()).toEqual([kept, board].map((id) => id.toLowerCase()).sort());
  // Restored: back in place.
  await shared.admin`
    update site_sidebar_states set archived_at = null
    where subject_id = 'user:ada' and site_id = ${board}::uuid`;
  expect((await read("user:ada")).apps.has(board.toLowerCase())).toBe(true);
});

test("a sidebar keeps links to archived apps; a person's own drop other people's private apps", async () => {
  if (!shared || !client) return;
  const scope = await workspace("Sidebar kept apps");
  const open = await app(scope, "Open", null);
  const archived = await app(scope, "Old", null);
  const theirs = await app(scope, "Bob's", "user:bob");
  const gone = crypto.randomUUID();
  await shared.admin`update workspace_artifacts set status = 'archived' where id = ${archived}::uuid`;
  const ids = [open, archived, theirs, gone, "not-a-uuid"];
  const sorted = (set: Set<string>) => [...set].sort();
  const lower = (list: string[]) => list.map((id) => id.toLowerCase()).sort();
  // The workspace default keeps every app that still exists.
  const all = await readSidebarLinkedApps(client.db, scope, ids);
  expect(sorted(all.kept)).toEqual(lower([open, archived, theirs]));
  expect(sorted(all.archived)).toEqual(lower([archived]));
  // Ada's own links keep shared apps, archived or not, but not Bob's private one.
  const ada = await readSidebarLinkedApps(client.db, scope, ids, { subjectId: "user:ada" });
  expect(sorted(ada.kept)).toEqual(lower([open, archived]));
  const bob = await readSidebarLinkedApps(client.db, scope, [theirs], { subjectId: "user:bob" });
  expect(bob.kept.size).toBe(1);
});
