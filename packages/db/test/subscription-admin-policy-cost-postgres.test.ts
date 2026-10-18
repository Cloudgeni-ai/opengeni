import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { rawRows, withWorkspaceSubjectRls } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

// Migration 0807: organization-admin subscription policies ask the admin
// helper once per statement instead of once per row, with the same answers,
// and turn-scoped runtime capability rows no longer accumulate.
// Migration 0838: rows left by backends that have exited are reclaimed too.

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 61);
const reclaimMigration = new URL(
  "../drizzle/0838_reclaim_exited_backend_runtime_capabilities.sql",
  import.meta.url,
);

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
    // Far above any real transaction ID, so no snapshot treats it as ended.
    const unfinished = "9000000000000000000";
    const reserved = await shared!.admin.reserve();
    try {
      const [backend] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // A row left by an earlier transaction of this backend, and one of
      // another backend's unfinished transaction that must be left alone.
      await reserved`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (${backend!.pid}, '3'::xid8, 'lifecycle', ${accountId}::uuid),
          (${backend!.pid + 1_000_000}, ${unfinished}::xid8, 'lifecycle', ${accountId}::uuid)`;
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
        { pid: backend!.pid + 1_000_000, transaction: unfinished },
      ]);
    } finally {
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      reserved.release();
    }
  });

  test("a grant reclaims rows of exited backends but never a running transaction's grant", async () => {
    const accountId = crypto.randomUUID();
    // The sweep walks the primary key from the lowest backend PID, and no
    // backend ever has PID 1, so this row is the first finished one it meets.
    const exitedPid = 1;
    const holder = await shared!.admin.reserve();
    const granter = await shared!.admin.reserve();
    try {
      // A transaction that holds its grant and is still running.
      await holder`begin`;
      const [held] = await holder<{ pid: number; transaction: string }[]>`
        insert into opengeni_private.subscription_runtime_capabilities
          (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)
        returning backend_pid as pid, transaction_id::text as transaction`;
      // The last grant of a backend that has since disconnected.
      await shared!.admin`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (${exitedPid}, '3'::xid8, 'lifecycle', ${accountId}::uuid)`;

      // A grant in another backend's READ COMMITTED transaction.
      await granter`begin isolation level read committed`;
      await granter`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)`;
      await granter`commit`;

      // Read from the running transaction, the only one that sees its grant.
      const remaining = await holder<{ pid: number }[]>`
        select backend_pid as pid from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid and backend_pid in (${exitedPid}, ${held!.pid})
        order by backend_pid`;
      expect(remaining.map((row) => row.pid)).toEqual([held!.pid]);
      await holder`commit`;
    } finally {
      await holder`rollback`.catch(() => undefined);
      await granter`rollback`.catch(() => undefined);
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      holder.release();
      granter.release();
    }
  });

  test("a grant under REPEATABLE READ leaves finished rows to later grants", async () => {
    const accountId = crypto.randomUUID();
    const exitedPid = 2_000_000_001;
    const granter = await shared!.admin.reserve();
    try {
      const [backend] = await granter<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // Seeded under REPEATABLE READ too, so the seeding reclaims nothing.
      await granter`begin isolation level repeatable read`;
      await granter`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (${exitedPid}, '3'::xid8, 'lifecycle', ${accountId}::uuid),
          (${backend!.pid}, '4'::xid8, 'lifecycle', ${accountId}::uuid)`;
      await granter`commit`;
      // Removing a row another grant removed concurrently would raise a
      // serialization failure here, so such a transaction reclaims nothing.
      await granter`begin isolation level repeatable read`;
      await granter`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)`;
      const [left] = await granter<{ count: number }[]>`
        select count(*)::int as count from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid and transaction_id in ('3'::xid8, '4'::xid8)`;
      await granter`commit`;
      expect(left!.count).toBe(2);
    } finally {
      await granter`rollback`.catch(() => undefined);
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      granter.release();
    }
  });

  test("a grant never waits for, or fails on, a row another grant is reclaiming", async () => {
    const accountId = crypto.randomUUID();
    const owner = await shared!.admin.reserve();
    const sweeper = await shared!.admin.reserve();
    try {
      const [backend] = await owner<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // The owner's grant from an earlier, finished transaction.
      await shared!.admin`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (${backend!.pid}, '3'::xid8, 'lifecycle', ${accountId}::uuid)`;
      // Another backend's grant reclaims it and keeps its transaction open.
      await sweeper`begin isolation level read committed`;
      await sweeper`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)`;
      const [claimed] = await shared!.admin<{ locked: boolean }[]>`
        select exists (
          select 1 from opengeni_private.subscription_runtime_capabilities
          where account_id = ${accountId}::uuid and transaction_id = '3'::xid8
          for update skip locked
        ) = false as locked`;
      expect(claimed!.locked).toBe(true);

      // The owner's next grants finish at once under either isolation level.
      await owner`set statement_timeout = '3s'`;
      for (const isolation of ["read committed", "repeatable read"] as const) {
        await owner.unsafe(`begin isolation level ${isolation}`);
        await owner`insert into opengeni_private.subscription_runtime_capabilities
          (backend_pid, transaction_id, capability_kind, account_id)
          values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)`;
        await owner`commit`;
      }
      await sweeper`commit`;
    } finally {
      await owner`rollback`.catch(() => undefined);
      await sweeper`rollback`.catch(() => undefined);
      await owner`reset statement_timeout`.catch(() => undefined);
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      owner.release();
      sweeper.release();
    }
  });

  test("the one-time cleanup empties an idle table", async () => {
    const accountId = crypto.randomUUID();
    const migrator = await shared!.admin.reserve();
    try {
      await shared!.admin`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (2, '3'::xid8, 'lifecycle', ${accountId}::uuid)`;
      await migrator.unsafe(await readFile(reclaimMigration, "utf8"));
      const [left] = await shared!.admin<{ count: number }[]>`
        select count(*)::int as count from opengeni_private.subscription_runtime_capabilities`;
      expect(left!.count).toBe(0);
    } finally {
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      migrator.release();
    }
  });

  test("the one-time cleanup does not wait for or fail on a busy table", async () => {
    const accountId = crypto.randomUUID();
    const holder = await shared!.admin.reserve();
    const migrator = await shared!.admin.reserve();
    try {
      await shared!.admin`insert into opengeni_private.subscription_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id)
        values (2, '3'::xid8, 'lifecycle', ${accountId}::uuid)`;
      // A running transaction holds its grant, so TRUNCATE cannot take the lock.
      await holder`begin`;
      const [held] = await holder<{ pid: number }[]>`
        insert into opengeni_private.subscription_runtime_capabilities
          (backend_pid, transaction_id, capability_kind, account_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'lifecycle', ${accountId}::uuid)
        returning backend_pid as pid`;

      const started = performance.now();
      await migrator.unsafe(await readFile(reclaimMigration, "utf8"));
      expect(performance.now() - started).toBeLessThan(4_000);

      const remaining = await holder<{ pid: number }[]>`
        select backend_pid as pid from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid order by backend_pid`;
      expect(remaining.map((row) => row.pid)).toEqual([held!.pid]);
      await holder`commit`;
    } finally {
      await holder`rollback`.catch(() => undefined);
      await shared!.admin`delete from opengeni_private.subscription_runtime_capabilities
        where account_id = ${accountId}::uuid`;
      holder.release();
      migrator.release();
    }
  });
});
