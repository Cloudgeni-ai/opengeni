import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { rawRows, withWorkspaceSubjectRls } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// Migration 0807: organization-admin subscription policies ask the admin
// helper once per statement instead of once per row, with the same answers,
// and turn-scoped runtime capability rows no longer accumulate.

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 61);

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-admin-policy-cost-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = { accountId: string; ownerSubjectId: string; workspaceIds: string[] };

async function workspace(accountId: string, subjectId: string, name: string): Promise<string> {
  const [row] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, ${name}) returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${row!.id}::uuid, ${subjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}::uuid, ${accountId}::uuid)`;
  return row!.id;
}

async function organization(): Promise<Org> {
  const userId = `admin-policy-cost-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Admin policy cost fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const workspaceIds = [
    await workspace(accountId, ownerSubjectId, "Shared A"),
    await workspace(accountId, ownerSubjectId, "Shared B"),
  ];
  // Several connections, each assigned to both workspaces, so a per-row
  // helper would run many times for one listing.
  for (let index = 0; index < 4; index += 1) {
    const label = `admin-policy-${index}-${crypto.randomUUID()}`;
    const [row] = await shared!.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at, label
      ) values (
        ${accountId}::uuid, 'codex', 'subscription',
        ${encryptEnvironmentValue(key, JSON.stringify({ access_token: label, refresh_token: label }))},
        'shared', 'workspaces', false, ${`chatgpt-${label}`}, 'pro',
        ${shared!.admin.json({ isFedramp: false })}::jsonb,
        ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
      ) returning id::text as id`;
    for (const workspaceId of workspaceIds) {
      await shared!.admin`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
        values (${accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
    }
  }
  return { accountId, ownerSubjectId, workspaceIds };
}

describe.skipIf(!realDb)("subscription admin policies", () => {
  test("an administrator sees every assignment while the helper runs once per statement", async () => {
    const org = await organization();
    const result = await withWorkspaceSubjectRls(
      client!.db,
      org.workspaceIds[0]!,
      org.ownerSubjectId,
      async (tx) => {
        const [visible] = await rawRows<{ count: number }>(
          tx,
          sql`select count(*)::int as count from subscription_connection_workspaces
            where account_id = ${org.accountId}::uuid`,
        );
        // The admin helper records and removes one lifecycle capability per
        // call; this transaction's own counters show how often it ran.
        const [writes] = await rawRows<{ inserted: number }>(
          tx,
          sql`select coalesce(sum(n_tup_ins), 0)::int as inserted from pg_stat_xact_all_tables
            where relid = 'opengeni_private.subscription_runtime_capabilities'::regclass`,
        );
        return { visible: visible!.count, inserted: writes!.inserted };
      },
    );
    expect(result.visible).toBe(8);
    expect(result.inserted).toBe(1);
  });

  test("a non-administrator still sees only the current workspace's assignments", async () => {
    const org = await organization();
    const outsider = `user:admin-policy-outsider-${crypto.randomUUID()}`;
    const visible = await withWorkspaceSubjectRls(
      client!.db,
      org.workspaceIds[0]!,
      outsider,
      async (tx) =>
        await rawRows<{ workspace_id: string }>(
          tx,
          sql`select workspace_id::text as workspace_id from subscription_connection_workspaces
            where account_id = ${org.accountId}::uuid`,
        ),
    );
    expect(visible).toHaveLength(4);
    expect([...new Set(visible.map((row) => row.workspace_id))]).toEqual([org.workspaceIds[0]!]);
  });

  test("write checks still admit administrators and refuse everyone else", async () => {
    const org = await organization();
    const [connection] = await shared!.admin<{ id: string }[]>`
      select connection_id::text as id from subscription_connection_workspaces
      where account_id = ${org.accountId}::uuid limit 1`;
    const third = await workspace(org.accountId, org.ownerSubjectId, "Shared C");
    await withWorkspaceSubjectRls(
      client!.db,
      org.workspaceIds[0]!,
      org.ownerSubjectId,
      async (tx) => {
        await tx.execute(sql`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
        values (${org.accountId}::uuid, ${connection!.id}::uuid, ${third}::uuid)`);
      },
    );
    const outsider = `user:admin-policy-outsider-${crypto.randomUUID()}`;
    const fourth = await workspace(org.accountId, org.ownerSubjectId, "Shared D");
    await expect(
      withWorkspaceSubjectRls(client!.db, org.workspaceIds[0]!, outsider, async (tx) => {
        await tx.execute(sql`insert into subscription_connection_workspaces
          (account_id, connection_id, workspace_id)
          values (${org.accountId}::uuid, ${connection!.id}::uuid, ${fourth}::uuid)`);
      }),
    ).rejects.toThrow();
    const [count] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from subscription_connection_workspaces
      where account_id = ${org.accountId}::uuid and workspace_id = ${fourth}::uuid`;
    expect(count!.count).toBe(0);
  });

  test("a backend reclaims its capability rows from finished transactions", async () => {
    const accountId = crypto.randomUUID();
    const reserved = await shared!.admin.reserve();
    try {
      const [backend] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // A row left by an earlier transaction of this backend, and one of
      // another backend that must be left alone.
      await reserved`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (${backend!.pid}, '3'::xid8, 'lifecycle', ${accountId}::uuid),
          (${backend!.pid + 1_000_000}, '3'::xid8, 'lifecycle', ${accountId}::uuid)`;
      // A later transaction of the same backend grants a new capability.
      const [granted] = await reserved<{ transaction: string }[]>`
        insert into opengeni_private.subscription_runtime_capabilities
          (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)
        returning transaction_id::text as transaction`;
      const rows = await reserved<{ pid: number; transaction: string }[]>`
        select backend_pid as pid, transaction_id::text as transaction
        from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid order by backend_pid`;
      expect([...rows]).toEqual([
        { pid: backend!.pid, transaction: granted!.transaction },
        { pid: backend!.pid + 1_000_000, transaction: "3" },
      ]);
    } finally {
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      reserved.release();
    }
  });
});
