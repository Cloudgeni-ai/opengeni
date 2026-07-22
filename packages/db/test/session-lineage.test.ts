import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  getSessionLineage,
  getSessionRootId,
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
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

type TestLineageNode = {
  children: TestLineageNode[];
};

function countLineageNodes(nodes: TestLineageNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countLineageNodes(node.children), 0);
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
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("session lineage", () => {
  test("listSessions filters roots and direct children by parentSessionId", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const root = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "root",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const grandchild = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "grandchild",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
      parentSessionId: child.id,
    });

    expect(
      (await listSessions(db, workspaceId, { parentSessionId: null })).map((s) => s.id),
    ).toEqual([root.id]);
    expect(
      (await listSessions(db, workspaceId, { parentSessionId: root.id })).map((s) => s.id),
    ).toEqual([child.id]);
    expect(
      (await listSessions(db, workspaceId, { parentSessionId: child.id })).map((s) => s.id),
    ).toEqual([grandchild.id]);
  }, 60_000);

  test("getSessionLineage returns root-first ancestors and nested workspace-scoped descendants", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const other = await freshWorkspace();
    const root = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "root",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const sibling = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "sibling",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
      parentSessionId: root.id,
    });
    const grandchild = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "grandchild",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
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
    expect(lineage?.truncated).toBe(false);
    expect(await getSessionRootId(db, workspaceId, child.id)).toBe(root.id);
    expect(await getSessionRootId(db, workspaceId, grandchild.id)).toBe(root.id);
    expect(await getSessionRootId(db, workspaceId, root.id)).toBe(root.id);
    expect(await getSessionRootId(db, workspaceId, crypto.randomUUID())).toBeNull();

    const rootLineage = await getSessionLineage(db, workspaceId, root.id);
    expect(rootLineage?.ancestors).toEqual([]);
    expect(rootLineage?.children.map((n) => n.session.id).sort()).toEqual(
      [child.id, sibling.id].sort(),
    );
    const childNode = rootLineage?.children.find((n) => n.session.id === child.id);
    expect(childNode?.children.map((n) => n.session.id)).toEqual([grandchild.id]);
    expect(rootLineage?.truncated).toBe(false);
  }, 60_000);

  test("getSessionLineage caps descendants and reports truncation", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const root = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "root",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "none",
    });
    for (let i = 0; i < 201; i += 1) {
      await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: `child ${i}`,
        resources: [],
        metadata: {},
        model: "gpt",
        sandboxBackend: "none",
        parentSessionId: root.id,
      });
    }

    const lineage = await getSessionLineage(db, workspaceId, root.id);
    expect(lineage?.truncated).toBe(true);
    expect(countLineageNodes(lineage?.children ?? [])).toBeLessThanOrEqual(200);
  }, 120_000);
});
