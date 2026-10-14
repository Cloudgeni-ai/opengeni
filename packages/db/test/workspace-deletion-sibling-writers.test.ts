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

/** Resolve once the deletion has finished or is parked on a row/advisory lock,
 * so the writer's next lock request is ordered after the deletion's locks. */
async function deletionSettledOrBlocked(settled: () => boolean, writerPid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !settled()) {
    const [row] = await admin<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and pid <> ${writerPid}`;
    if ((row?.waiting ?? 0) > 0) return;
    await Bun.sleep(20);
  }
  if (!settled()) throw new Error("deletion neither finished nor blocked on a lock");
}

/** Model a concurrent writer that takes `first`, lets the deletion run until it
 * finishes or blocks, then takes `second` in the same transaction. */
async function raceDeletionWithWriter(input: {
  accountId: string;
  workspaceId: string;
  first: string;
  second: string;
}): Promise<{
  deletion: PromiseSettledResult<Awaited<ReturnType<typeof deleteWorkspaceIfQuiescent>>>;
  writer: PromiseSettledResult<string>;
}> {
  const writer = postgres(shared!.adminUrl, { max: 1 });
  try {
    let releaseWriter!: () => void;
    const writerMayContinue = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerPid = 0;
    let firstLockHeld!: () => void;
    const firstLock = new Promise<void>((resolve) => {
      firstLockHeld = resolve;
    });
    const writerResult = writer.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      writerPid = backend!.pid;
      await tx.unsafe(input.first);
      firstLockHeld();
      await writerMayContinue;
      await tx.unsafe(input.second);
      return "committed";
    });
    await firstLock;
    let deletionSettled = false;
    const deletion = deleteWorkspaceIfQuiescent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    }).finally(() => {
      deletionSettled = true;
    });
    try {
      await deletionSettledOrBlocked(() => deletionSettled, writerPid);
    } finally {
      releaseWriter();
    }
    const [deletionResult, writerOutcome] = await Promise.allSettled([deletion, writerResult]);
    return { deletion: deletionResult, writer: writerOutcome };
  } finally {
    await writer.end({ timeout: 5 });
  }
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
    const { deletion, writer } = await raceDeletionWithWriter({
      accountId,
      workspaceId: targetWorkspaceId,
      first: `select 1 from workspaces where id = '${siblingWorkspaceId}' for key share`,
      second: `select 1 from managed_accounts where id = '${accountId}' for key share`,
    });
    expect(deletion.status).toBe("fulfilled");
    expect(writer.status).toBe("fulfilled");
    expect(deletion.status === "fulfilled" ? deletion.value.status : null).toBe("deleted");
    const remaining = await admin<{ id: string }[]>`
      select id from workspaces where account_id = ${accountId}`;
    expect(remaining.map((row) => row.id)).toEqual([siblingWorkspaceId]);
  }, 60_000);

  test("does not deadlock with a writer holding the target's control row first", async () => {
    if (!available) return;
    const { accountId, workspaceIds } = await accountWithWorkspaces(2);
    const [targetWorkspaceId] = workspaceIds as [string, string];

    // The canonical writer prefix (and the organization membership lifecycle)
    // takes the inference-control row before the workspace row. The deletion
    // cascade removes that control row, so the deletion must not hold the
    // workspace row while waiting for it.
    const { deletion, writer } = await raceDeletionWithWriter({
      accountId,
      workspaceId: targetWorkspaceId,
      first: `select 1 from workspace_inference_controls where workspace_id = '${targetWorkspaceId}' for share`,
      second: `select 1 from workspaces where id = '${targetWorkspaceId}' for key share`,
    });
    expect(writer.status).toBe("fulfilled");
    expect(deletion.status).toBe("fulfilled");
    expect(deletion.status === "fulfilled" ? deletion.value.status : null).toBe("deleted");
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

  test("a missing workspace is still not found", async () => {
    if (!available) return;
    const { accountId } = await accountWithWorkspaces(2);
    const result = await deleteWorkspaceIfQuiescent(db, {
      accountId,
      workspaceId: crypto.randomUUID(),
    });
    expect(result.status).toBe("not_found");
  }, 60_000);
});
