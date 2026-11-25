import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessGrant, Permission, ResolvedSidebarItem } from "@opengeni/contracts";
import {
  createAgent,
  createDb,
  createWorkspace,
  createWorkspaceArtifact,
  deleteAgent,
  readSidebarLayouts,
  writeSidebarLayout,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { HTTPException } from "hono/http-exception";
import {
  readSidebarLayoutForGrant,
  updateSidebarLayoutForGrant,
} from "../src/application/sidebar-layout";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-sidebar-layout");
  if (!shared && requireRealDatabase) throw new Error("sidebar layout requires PostgreSQL");
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

const MEMBER: Permission[] = ["workspace:read", "artifacts:read"];

async function workspace() {
  const [account] = await shared!
    .admin`insert into managed_accounts (name) values ('Sidebar core') returning id`;
  const accountId = String(account!.id);
  const workspaceId = (await createWorkspace(client!.db, { accountId, name: "Sidebar core" })).id;
  const grant = (subjectId: string, permissions: Permission[]): AccessGrant => ({
    accountId,
    workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
  });
  return {
    accountId,
    workspaceId,
    admin: grant("user:admin", [...MEMBER, "workspace:admin"]),
    ada: grant("user:ada", MEMBER),
    bob: grant("user:bob", MEMBER),
  };
}

async function app(scope: { accountId: string; workspaceId: string }, owner: string | null) {
  const created = await createWorkspaceArtifact(client!.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    artifactId: crypto.randomUUID(),
    slug: `sidebar-${crypto.randomUUID().slice(0, 8)}`,
    title: "App",
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
    actorSubjectId: owner ?? "user:admin",
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

async function status(work: () => Promise<unknown>): Promise<number | "ok"> {
  try {
    await work();
    return "ok";
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

function shape(items: readonly ResolvedSidebarItem[]): unknown[] {
  return items.map((item) =>
    item.type === "group" ? [item.id, item.items.map((child) => child.id)] : item.id,
  );
}

test("an admin's default reaches everyone; a member's own changes reach only them", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const [a, b, c] = [await app(ws, null), await app(ws, null), await app(ws, null)];
  // Members can't change the default.
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, ws.ada, {
        scope: "workspace",
        changes: [{ op: "reset" }],
      }),
    ),
  ).toBe(403);
  await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    expectedRevision: 0,
    changes: [
      {
        op: "add",
        item: {
          id: "eng",
          type: "group",
          label: "Engineering",
          items: [
            { id: "a", type: "app", appId: a, path: "/releases" },
            { id: "b", type: "app", appId: b },
            { id: "c", type: "app", appId: c },
            { id: "s", type: "link", url: "https://status.example.com", label: "Status" },
          ],
        },
      },
    ],
  });
  // A stale revision is refused instead of overwritten.
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, ws.admin, {
        scope: "workspace",
        expectedRevision: 0,
        changes: [{ op: "reset" }],
      }),
    ),
  ).toBe(409);
  const mine = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [
      { op: "remove", itemId: "b" },
      {
        op: "add",
        item: { id: "docs", type: "link", url: "https://docs.example.com", label: "D" },
      },
    ],
  });
  expect(shape(mine.items)).toEqual(["pinned-apps", ["eng", ["a", "c", "s"]], "my-docs"]);
  expect(mine.personal.customized).toBe(true);
  const bob = await readSidebarLayoutForGrant(deps, ws.bob);
  expect(shape(bob.items)).toEqual(["pinned-apps", ["eng", ["a", "b", "c", "s"]]]);
  expect(bob.workspace.canEdit).toBe(false);
  expect(bob.workspace.items).toBeUndefined();
});

test("people only see and add Apps they can open; gone Apps drop out of storage", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const open = await app(ws, null);
  const bobs = await app(ws, "user:bob");
  const old = await app(ws, null);
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, ws.ada, {
        scope: "personal",
        changes: [{ op: "add", item: { type: "app", appId: bobs } }],
      }),
    ),
  ).toBe(422);
  await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [
      { op: "add", item: { id: "open", type: "app", appId: open } },
      { op: "add", item: { id: "old", type: "app", appId: old } },
    ],
  });
  await updateSidebarLayoutForGrant(deps, ws.bob, {
    scope: "personal",
    changes: [{ op: "add", item: { id: "theirs", type: "app", appId: bobs } }],
  });
  // Bob's private App is in his own sidebar only.
  expect(shape((await readSidebarLayoutForGrant(deps, ws.bob)).items)).toEqual([
    "pinned-apps",
    "open",
    "old",
    "my-theirs",
  ]);
  await shared.admin`update workspace_artifacts set status = 'archived' where id = ${old}::uuid`;
  expect(shape((await readSidebarLayoutForGrant(deps, ws.ada)).items)).toEqual([
    "pinned-apps",
    "open",
  ]);
  // The next write keeps the archived App's link (hidden until it's
  // restored), and Ada's move lands next to the item she sees even though
  // the stored level holds another.
  const after = await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [
      { op: "add", item: { id: "s", type: "link", url: "https://s.example.com", label: "S" } },
    ],
  });
  expect(shape(after.workspace.items ?? [])).toEqual(["pinned-apps", "open", "s"]);
  const storedIds = async () => {
    const [stored] = await shared!.admin`select layout from sidebar_layouts
      where workspace_id = ${ws.workspaceId}::uuid and subject_id is null`;
    return (stored!.layout as { items: { id: string }[] }).items.map((item) => item.id);
  };
  expect(await storedIds()).toEqual(["pinned-apps", "open", "old", "s"]);
  const moved = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "move", itemId: "s", beforeId: "open" }],
  });
  expect(shape(moved.items)).toEqual(["pinned-apps", "s", "open"]);
  // Restoring the App brings its link back.
  await shared.admin`update workspace_artifacts set status = 'active' where id = ${old}::uuid`;
  expect(shape((await readSidebarLayoutForGrant(deps, ws.ada)).items)).toEqual([
    "pinned-apps",
    "s",
    "open",
    "old",
  ]);
  // A link to an App that no longer exists is dropped on the next write.
  const gone = crypto.randomUUID();
  await shared.admin`update sidebar_layouts
    set layout = jsonb_set(layout, '{items}', layout->'items' || ${JSON.stringify([
      { id: "gone", type: "app", appId: gone },
    ])}::text::jsonb)
    where workspace_id = ${ws.workspaceId}::uuid and subject_id is null`;
  expect(await storedIds()).toEqual(["pinned-apps", "open", "old", "s", "gone"]);
  await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [{ op: "update", itemId: "s", label: "Status" }],
  });
  expect(await storedIds()).toEqual(["pinned-apps", "open", "old", "s"]);
});

test("links to archived Apps make room when a change would go over a limit", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const old = await app(ws, null);
  await shared.admin`update workspace_artifacts set status = 'archived' where id = ${old}::uuid`;
  const links = Array.from({ length: 49 }, (_, index) => ({
    id: `l${index}`,
    type: "link",
    url: `https://l${index}.example.com`,
    label: `L${index}`,
  }));
  await shared.admin`insert into sidebar_layouts (account_id, workspace_id, subject_id, layout, revision)
    values (${ws.accountId}::uuid, ${ws.workspaceId}::uuid, null,
      ${JSON.stringify({ version: 1, items: [{ id: "old", type: "app", appId: old }, ...links] })}::text::jsonb, 1)`;
  const after = await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [
      { op: "add", item: { id: "more", type: "link", url: "https://m.example.com", label: "M" } },
    ],
  });
  expect((after.workspace.items ?? []).at(-1)?.id).toBe("more");
  const [stored] = await shared.admin`select layout from sidebar_layouts
    where workspace_id = ${ws.workspaceId}::uuid and subject_id is null`;
  const ids = (stored!.layout as { items: { id: string }[] }).items.map((item) => item.id);
  expect(ids).toHaveLength(50);
  expect(ids).not.toContain("old");
  // Without an archived link to drop, the limit holds.
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, ws.admin, {
        scope: "workspace",
        changes: [{ op: "add", item: { type: "link", url: "https://n.example.com", label: "N" } }],
      }),
    ),
  ).toBe(422);
});

test("a person's own link to an App that became someone else's Only me is dropped", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const later = await app(ws, null);
  const kept = await app(ws, null);
  await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [
      { op: "add", item: { id: "later", type: "app", appId: later } },
      { op: "add", item: { id: "kept", type: "app", appId: kept } },
    ],
  });
  await shared.admin`update workspace_artifacts
    set visibility = 'user_private', owner_subject_id = 'user:bob' where id = ${later}::uuid`;
  // Hidden from Ada at once, and gone from her storage on her next change.
  const changed = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "move", itemId: "my-kept", index: 0 }],
  });
  expect(shape(changed.items)).toEqual(["my-kept", "pinned-apps"]);
  const [stored] = await shared.admin`select layout from sidebar_layouts
    where workspace_id = ${ws.workspaceId}::uuid and subject_id = 'user:ada'`;
  const added = (stored!.layout as { added: { item: { id: string } }[] }).added;
  expect(added.map((entry) => entry.item.id)).toEqual(["my-kept"]);
});

test("the built-in default is the Pinned apps list until an admin saves another", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const fresh = await readSidebarLayoutForGrant(deps, ws.ada);
  expect(fresh.items).toEqual([
    {
      id: "pinned-apps",
      origin: "workspace",
      type: "live_list",
      list: "pinned_apps",
      label: "Pinned apps",
      limit: 5,
      apps: [],
    },
  ]);
  expect(fresh.workspace.revision).toBe(0);
  // A person hides it for themselves only.
  const hidden = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "remove", itemId: "pinned-apps" }],
  });
  expect(hidden.items).toEqual([]);
  expect(shape((await readSidebarLayoutForGrant(deps, ws.bob)).items)).toEqual(["pinned-apps"]);
  // An admin's first change starts from it, and removing it is saved.
  const removed = await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    expectedRevision: 0,
    changes: [{ op: "remove", itemId: "pinned-apps" }],
  });
  expect(removed.workspace.revision).toBe(1);
  expect(removed.workspace.items).toEqual([]);
  expect((await readSidebarLayoutForGrant(deps, ws.bob)).items).toEqual([]);
});

async function agent(
  scope: { accountId: string; workspaceId: string },
  name: string,
  owner: string | null,
) {
  const created = await createAgent(client!.db, scope, {
    visibility: owner ? "private" : "workspace",
    ownerSubjectId: owner,
    name,
    description: "",
    avatar: owner ? null : { kind: "emoji", emoji: "🛠️", hue: 30 },
    instructions: "",
    memoryEnabled: false,
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: owner ?? "user:admin",
    maxPerWorkspace: 500,
  });
  return created.agent.id;
}

test("agent links show the agent's name and avatar, only to people who can see it", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const withChats: Permission[] = [...MEMBER, "sessions:read"];
  const ada = { ...ws.ada, permissions: withChats };
  const bob = { ...ws.bob, permissions: withChats };
  const admin = { ...ws.admin, permissions: [...withChats, "workspace:admin" as const] };
  const shared_ = await agent(ws, "Release helper", null);
  const adas = await agent(ws, "Ada Lovelace", "user:ada");
  // Nobody adds an agent they can't see, or one that isn't there.
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, bob, {
        scope: "personal",
        changes: [{ op: "add", item: { type: "agent", agentId: adas } }],
      }),
    ),
  ).toBe(422);
  expect(
    await status(() =>
      updateSidebarLayoutForGrant(deps, ws.bob, {
        scope: "personal",
        changes: [{ op: "add", item: { type: "agent", agentId: shared_ } }],
      }),
    ),
  ).toBe(403);
  await updateSidebarLayoutForGrant(deps, admin, {
    scope: "workspace",
    changes: [
      { op: "reset" },
      {
        op: "add",
        item: {
          id: "team",
          type: "group",
          label: "Team",
          items: [{ id: "helper", type: "agent", agentId: shared_ }],
        },
      },
    ],
  });
  const mine = await updateSidebarLayoutForGrant(deps, ada, {
    scope: "personal",
    changes: [
      { op: "add", groupId: "team", item: { id: "me", type: "agent", agentId: adas, label: "Me" } },
      { op: "update", itemId: "my-me", label: null },
    ],
  });
  const team = mine.items.find((item) => item.id === "team");
  expect(team?.type === "group" ? team.items : null).toEqual([
    {
      id: "helper",
      origin: "workspace",
      type: "agent",
      agentId: shared_,
      label: "Release helper",
      avatar: { kind: "emoji", emoji: "🛠️", hue: 30 },
    },
    {
      id: "my-me",
      origin: "personal",
      type: "agent",
      agentId: adas,
      label: "Ada Lovelace",
      avatar: { kind: "letters", letters: "AL", hue: expect.any(Number) },
    },
  ]);
  // Bob sees the shared agent; without access to chats, nobody sees agents.
  expect(shape((await readSidebarLayoutForGrant(deps, bob)).items)).toEqual([["team", ["helper"]]]);
  expect(shape((await readSidebarLayoutForGrant(deps, ws.bob)).items)).toEqual([]);
  // A deleted agent drops out of the sidebar, and out of storage on the next change.
  await deleteAgent(client.db, ws, shared_);
  expect(shape((await readSidebarLayoutForGrant(deps, bob)).items)).toEqual([]);
  await updateSidebarLayoutForGrant(deps, admin, {
    scope: "workspace",
    changes: [{ op: "update", itemId: "team", label: "Crew" }],
  });
  const rows = await readSidebarLayouts(client.db, ws, null);
  expect(rows.workspace?.layout).toEqual({
    version: 1,
    items: [{ id: "team", type: "group", label: "Crew", items: [] }],
  });
  expect(shape((await readSidebarLayoutForGrant(deps, ada)).items)).toEqual([["team", ["my-me"]]]);
});

test("during a rolling deploy, this version's writes keep what a newer replica stored", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  const a = await app(ws, null);
  const scope = { accountId: ws.accountId, workspaceId: ws.workspaceId };
  // A newer replica stored an option, a field and a version this one doesn't know.
  const newer = { railDensity: "compact" };
  await writeSidebarLayout(client.db, scope, {
    subjectId: null,
    expectedRevision: 0,
    layout: { version: 2, items: [], options: { ...newer, sessionsShowApps: false }, sections: [] },
    updatedBy: "user:admin",
  });
  await writeSidebarLayout(client.db, scope, {
    subjectId: "user:ada",
    expectedRevision: 0,
    layout: {
      version: 2,
      hidden: [],
      added: [],
      order: {},
      options: { ...newer, settingsMore: ["workspace:usage"] },
      sections: [],
    },
    updatedBy: "user:ada",
  });
  // This version changes something else in each.
  await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [{ op: "add", item: { id: "a", type: "app", appId: a } }],
  });
  const answer = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "options", sessionsShowApps: true }],
  });
  const rows = await readSidebarLayouts(client.db, scope, "user:ada");
  expect(rows.workspace?.layout).toEqual({
    version: 2,
    items: [{ id: "a", type: "app", appId: a }],
    options: { ...newer, sessionsShowApps: false },
    sections: [],
  });
  expect(rows.personal?.layout).toEqual({
    version: 2,
    hidden: [],
    added: [],
    order: {},
    options: {
      ...newer,
      settingsMore: ["workspace:usage"],
      sessionsShowApps: true,
      appsPlacement: "sessions",
    },
    sections: [],
  });
  // Answers carry only the options this version knows.
  expect(answer.personal.options).toEqual({
    sessionsShowApps: true,
    appsPlacement: "sessions",
    settingsMore: ["workspace:usage"],
  });
  expect(answer.options).toEqual({
    sessionsShowApps: true,
    appsPlacement: "sessions",
    hiddenNavEntries: [],
    settingsMore: ["workspace:usage"],
  });
});

test("apps placement: the default and a person's own choice, as the agent tool sets them", async () => {
  if (!shared || !client) return;
  const ws = await workspace();
  const deps = { db: client.db };
  // Today's behaviour until someone chooses.
  expect((await readSidebarLayoutForGrant(deps, ws.ada)).options).toMatchObject({
    appsPlacement: "sessions",
    sessionsShowApps: true,
  });
  await updateSidebarLayoutForGrant(deps, ws.admin, {
    scope: "workspace",
    changes: [{ op: "options", appsPlacement: "tab" }],
  });
  expect((await readSidebarLayoutForGrant(deps, ws.ada)).options).toMatchObject({
    appsPlacement: "tab",
    sessionsShowApps: true,
  });
  // "I don't want apps in the sidebar", through the older option a saved layout may hold.
  const hidden = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "options", sessionsShowApps: false }],
  });
  expect(hidden.options).toMatchObject({ appsPlacement: "hidden", sessionsShowApps: false });
  expect(hidden.personal.options).toEqual({ appsPlacement: "hidden", sessionsShowApps: false });
  // "Give apps their own tab."
  const tab = await updateSidebarLayoutForGrant(deps, ws.ada, {
    scope: "personal",
    changes: [{ op: "options", appsPlacement: "tab" }],
  });
  expect(tab.options).toMatchObject({ appsPlacement: "tab", sessionsShowApps: true });
  // A member can't change the default.
  await expect(
    updateSidebarLayoutForGrant(deps, ws.ada, {
      scope: "workspace",
      changes: [{ op: "options", appsPlacement: "hidden" }],
    }),
  ).rejects.toThrow();
});
