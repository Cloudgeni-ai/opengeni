import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  getSessionLineage,
  getSessionRootId,
  listSessions,
  withWorkspaceSessionActivityRls,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const child = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      parentSessionId: root.id,
    }).catch(() => null);

    // The grandchild is parked on a human: its lineage node says since when.
    const waitingSince = new Date(Date.now() - 10 * 3_600_000);
    waitingSince.setMilliseconds(0);
    await withWorkspaceSessionActivityRls(db, workspaceId, async (scoped) => {
      await scoped.execute(sql`
        update sessions set status = 'requires_action' where id = ${grandchild.id}`);
      await scoped.execute(sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend, resources, tools, metadata,
          execution_generation, updated_at
        ) values (
          ${crypto.randomUUID()}, ${accountId}, ${workspaceId}, ${grandchild.id},
          ${crypto.randomUUID()}, ${`wf-${grandchild.id}`}, 'requires_action',
          2, 'waiting prompt', 'gpt', 'medium', 'none', '[]'::jsonb, '[]'::jsonb,
          '{}'::jsonb, 1, ${waitingSince.toISOString()}::timestamptz
        )`);
    });

    const lineage = await getSessionLineage(db, workspaceId, child.id);
    expect(lineage?.ancestors.map((s) => s.id)).toEqual([root.id]);
    expect(lineage?.children.map((n) => n.session.id)).toEqual([grandchild.id]);
    expect(lineage?.children[0]?.session.requiresActionSince).toBe(waitingSince.toISOString());
    expect(lineage?.ancestors[0]?.requiresActionSince).toBeNull();
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

  test("getSessionLineage returns deep ancestry in full and fails closed at its safety frontier", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const root = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "deep root",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      maxNestedAgentDepthOverride: 64,
      allowNestedAgentDepthIncrease: true,
    });
    const chain = [root];
    for (let depth = 1; depth <= 64; depth += 1) {
      chain.push(
        await createSession(db, {
          accountId,
          workspaceId,
          initialMessage: `deep child ${depth}`,
          resources: [],
          metadata: {},
          model: "gpt",
          reasoningEffort: "medium" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "none",
          parentSessionId: chain.at(-1)!.id,
        }),
      );
    }

    const depth33 = await getSessionLineage(db, workspaceId, chain[33]!.id);
    expect(depth33?.ancestors.map((session) => session.id)).toEqual(
      chain.slice(0, 33).map((session) => session.id),
    );
    await expect(getSessionLineage(db, workspaceId, chain[64]!.id)).rejects.toThrow(
      "has no valid workspace root",
    );
  }, 120_000);

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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        parentSessionId: root.id,
      });
    }

    const lineage = await getSessionLineage(db, workspaceId, root.id);
    expect(lineage?.truncated).toBe(true);
    expect(countLineageNodes(lineage?.children ?? [])).toBeLessThanOrEqual(200);
  }, 120_000);
});
