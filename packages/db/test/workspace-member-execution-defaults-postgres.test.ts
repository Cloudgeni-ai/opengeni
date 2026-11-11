import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  clearWorkspaceMemberExecutionDefault,
  createDb,
  getWorkspaceMemberExecutionDefault,
  setWorkspaceMemberExecutionDefault,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-member-execution-defaults");
  if (!shared) {
    if (requireRealDatabase)
      throw new Error(
        "[workspace-member-execution-defaults] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[workspace-member-execution-defaults] docker unavailable, skipping");
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

async function workspace() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('member-execution-defaults') returning id`;
  const [row] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'member-execution-defaults', ${admin.json({})}) returning id`;
  return { accountId: account!.id, workspaceId: row!.id };
}

describe("Workspace member execution defaults (real PostgreSQL + FORCE RLS)", () => {
  test("are one person's own, replaceable and clearable, and never another person's", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await workspace();
    const ada = { workspaceId, subjectId: "user:ada" };
    const bob = { workspaceId, subjectId: "user:bob" };
    expect(await getWorkspaceMemberExecutionDefault(db, ada)).toBeNull();

    const first = await setWorkspaceMemberExecutionDefault(db, {
      ...ada,
      accountId,
      target: { kind: "machine", targetSandboxId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(first.version).toBe(1);
    const second = await setWorkspaceMemberExecutionDefault(db, {
      ...ada,
      accountId,
      target: { kind: "managed" },
    });
    expect(second).toMatchObject({ target: { kind: "managed" }, version: 2 });
    expect(await getWorkspaceMemberExecutionDefault(db, ada)).toMatchObject({
      target: { kind: "managed" },
      version: 2,
    });
    expect(await getWorkspaceMemberExecutionDefault(db, bob)).toBeNull();

    // FORCE RLS: another subject cannot read or write Ada's row, even directly.
    const visibleToBob = await withWorkspaceSubjectRls(
      db,
      workspaceId,
      "user:bob",
      async (tx) =>
        await tx.execute<{ count: number }>(
          sql`select count(*)::int as count from workspace_member_execution_defaults`,
        ),
    );
    expect(visibleToBob).toEqual([{ count: 0 }]);
    await expect(
      withWorkspaceSubjectRls(db, workspaceId, "user:bob", async (tx) => {
        await tx.execute(sql`
          insert into workspace_member_execution_defaults (account_id, workspace_id, subject_id, target)
          values (${accountId}, ${workspaceId}, 'user:ada', ${JSON.stringify({ kind: "managed" })}::jsonb)
          on conflict (workspace_id, subject_id) do update set target = excluded.target`);
      }),
    ).rejects.toThrow();
    // The stored shape is checked.
    await expect(
      admin`
        insert into workspace_member_execution_defaults (account_id, workspace_id, subject_id, target)
        values (${accountId}, ${workspaceId}, 'user:carol', ${admin.json({ kind: "other" })})`,
    ).rejects.toThrow();
    const [table] = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
      where oid = 'workspace_member_execution_defaults'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    expect(await clearWorkspaceMemberExecutionDefault(db, ada)).toBe(true);
    expect(await clearWorkspaceMemberExecutionDefault(db, ada)).toBe(false);
    expect(await getWorkspaceMemberExecutionDefault(db, ada)).toBeNull();

    // Deleting the workspace removes its rows.
    await setWorkspaceMemberExecutionDefault(db, {
      ...ada,
      accountId,
      target: { kind: "managed" },
    });
    await admin`delete from workspaces where id = ${workspaceId}`;
    const [remaining] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspace_member_execution_defaults
      where workspace_id = ${workspaceId}`;
    expect(remaining?.count).toBe(0);
  });
});
