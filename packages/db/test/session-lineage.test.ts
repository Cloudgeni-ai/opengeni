import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  getSessionLineage,
  listSessions,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-lineage");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[session-lineage] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch { /* noop */ }
  await shared?.release();
});

describe("session lineage", () => {
  test("listSessions filters roots and direct children by parentSessionId", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const root = await createSession(db, {
      accountId, workspaceId, initialMessage: "root", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId, workspaceId, initialMessage: "child", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const grandchild = await createSession(db, {
      accountId, workspaceId, initialMessage: "grandchild", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
      parentSessionId: child.id,
    });

    expect((await listSessions(db, workspaceId, { parentSessionId: null })).map((s) => s.id)).toEqual([root.id]);
    expect((await listSessions(db, workspaceId, { parentSessionId: root.id })).map((s) => s.id)).toEqual([child.id]);
    expect((await listSessions(db, workspaceId, { parentSessionId: child.id })).map((s) => s.id)).toEqual([grandchild.id]);
  }, 60_000);

  test("getSessionLineage returns root-first ancestors and nested workspace-scoped descendants", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const other = await freshWorkspace();
    const root = await createSession(db, {
      accountId, workspaceId, initialMessage: "root", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId, workspaceId, initialMessage: "child", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const sibling = await createSession(db, {
      accountId, workspaceId, initialMessage: "sibling", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const grandchild = await createSession(db, {
      accountId, workspaceId, initialMessage: "grandchild", resources: [], metadata: {}, model: "gpt", sandboxBackend: "none",
      parentSessionId: child.id,
    });
    await createSession(db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      initialMessage: "foreign",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
      parentSessionId: root.id,
    }).catch(() => null);

    const lineage = await getSessionLineage(db, workspaceId, child.id);
    expect(lineage?.ancestors.map((s) => s.id)).toEqual([root.id]);
    expect(lineage?.children.map((n) => n.session.id)).toEqual([grandchild.id]);

    const rootLineage = await getSessionLineage(db, workspaceId, root.id);
    expect(rootLineage?.ancestors).toEqual([]);
    expect(rootLineage?.children.map((n) => n.session.id).sort()).toEqual([child.id, sibling.id].sort());
    const childNode = rootLineage?.children.find((n) => n.session.id === child.id);
    expect(childNode?.children.map((n) => n.session.id)).toEqual([grandchild.id]);
  }, 60_000);
});
