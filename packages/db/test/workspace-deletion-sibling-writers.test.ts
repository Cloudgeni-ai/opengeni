import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, deleteWorkspaceIfQuiescent, type Database } from "../src/index";

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: ReturnType<typeof createDb> | null = null;
let db: Database;
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-deletion-sibling-writers");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[workspace-deletion-sibling-writers] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function accountWithWorkspaces(count: number): Promise<{
  accountId: string;
  workspaceIds: string[];
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('deletion-lock-order') returning id`;
  const workspaceIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`ws-${index}`})
      returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    workspaceIds.push(workspace!.id);
  }
  return { accountId: account!.id, workspaceIds };
}

describe("workspace deletion lock order (real PostgreSQL)", () => {
  test("does not deadlock with an ordinary writer in a sibling workspace", async () => {
    if (!available) return;
    const { accountId, workspaceIds } = await accountWithWorkspaces(2);
    const [targetWorkspaceId, siblingWorkspaceId] = workspaceIds as [string, string];

    // An ordinary session writer in the sibling workspace: a child insert's FK
    // check takes the sibling workspace row FOR KEY SHARE, and a later insert
    // in the same transaction takes the account row FOR KEY SHARE through its
    // account FK (session_events references both).
    const writerName = `sibling-writer-${crypto.randomUUID().slice(0, 8)}`;
    const writer = postgres(shared!.adminUrl, {
      max: 1,
      connection: { application_name: writerName },
    });
    try {
      const writerResult = writer.begin(async (tx) => {
        await tx.unsafe(
          `select 1 from workspaces where id = '${siblingWorkspaceId}' for key share`,
        );
        // Let the deletion take its account and workspace locks first.
        await Bun.sleep(300);
        await tx.unsafe(`select 1 from managed_accounts where id = '${accountId}' for key share`);
        return "committed" as const;
      });

      await Bun.sleep(100);
      const deletion = deleteWorkspaceIfQuiescent(db, {
        accountId,
        workspaceId: targetWorkspaceId,
      });

      const [deleted, written] = await Promise.allSettled([deletion, writerResult]);
      expect(deleted.status).toBe("fulfilled");
      expect(written.status).toBe("fulfilled");
      expect(deleted.status === "fulfilled" ? deleted.value.status : null).toBe("deleted");
    } finally {
      await writer.end({ timeout: 5 });
    }
    const remaining = await admin<{ id: string }[]>`
      select id from workspaces where account_id = ${accountId}`;
    expect(remaining.map((row) => row.id)).toEqual([siblingWorkspaceId]);
  }, 60_000);

  test("still refuses to delete the account's last workspace under concurrency", async () => {
    if (!available) return;
    const { accountId, workspaceIds } = await accountWithWorkspaces(2);
    const results = await Promise.all(
      workspaceIds.map((workspaceId) => deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })),
    );
    expect(results.map((result) => result.status).sort()).toEqual(["deleted", "only_workspace"]);
    const [remaining] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspaces where account_id = ${accountId}`;
    expect(remaining?.count).toBe(1);
  }, 60_000);
});
