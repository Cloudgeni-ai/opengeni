// Migration 0713 is rolling: runtime transactions keep running while it
// applies. They take the canonical workspace prefix first
// (workspace_inference_controls FOR SHARE, workspaces FOR KEY SHARE) and reach
// the subscription tables after it, and workspace or Personal-workspace
// creation holds its new row while 0689's trigger reads the reach table. A
// migration that holds a subscription table while it waits for one of those
// (or the reverse) closes a lock cycle with them, and PostgreSQL aborts one
// side with 40P01, the migration Job included: the shape migration 0299 fixed
// for organization memberships, and the shape an earlier draft of 0713 had.
//
// 0713 locks the owner-only reach table and then the provider registry, and
// no runtime table. These cases apply it as the runner does (its preamble and
// the file in one transaction) as the NOSUPERUSER NOBYPASSRLS owner, race it
// against those runtime shapes as the restricted application role, and take
// the evidence from each side's outcome and PostgreSQL's own deadlock
// counter. Every case but the last rolls 0713 back, so each starts from the
// database a deployment has before it; the last commits it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createOrganizationWorkspace,
  ensureManagedAccessForUser,
  nestedPostgresSqlState,
  withRlsContext,
  type DbClient,
} from "../src";
import { setSubjectRlsContext, type Database } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const REACH_MIGRATION = "0713_subscription_core_provider_keyed_reach.sql";
// 0714 redefines 0713's reach setters, so it is held back with it.
const LATER_MIGRATION = "0714_subscription_workspace_managed_organization_accounts.sql";
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 73);
// What the runner sends ahead of a migration body, in the same transaction
// (`executeMigrationFile` in src/migrate.ts).
const RUNNER_PREAMBLE = `SELECT
  pg_catalog.set_config('lock_timeout', '5s', true),
  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n`;
const REACH_TABLE = "opengeni_private.subscription_codex_auto_assignments";
const REGISTRY = "opengeni_private.subscription_core_providers";
// Tables the racing runtime paths lock.
const RUNTIME_TABLES = [
  "managed_accounts",
  "organization_memberships",
  "subscription_connection_assignment_policies",
  "subscription_connection_workspaces",
  "subscription_connections",
  "subscription_provider_cutovers",
  "subscription_settings",
  "workspace_inference_controls",
  "workspace_memberships",
  "workspaces",
];

type Staged = {
  accountId: string;
  ownerSubjectId: string;
  sharedWorkspaceId: string;
  connections: Record<"sharedOnly" | "personalOnly" | "both", string>;
};
type Lock = { relation: string; mode: string };
type Outcome = { ok: true } | { ok: false; state: string | null; message: string };

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let migrationText = "";
let staged: Staged | null = null;

function appUrl(): string {
  const url = new URL(database!.ownerUrl);
  url.username = "opengeni_app";
  url.password = database!.appPassword;
  return url.toString();
}

function settle(work: Promise<unknown>): Promise<Outcome> {
  return work.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({
      ok: false as const,
      state: nestedPostgresSqlState(error),
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Superuser connections of their own for sides that stay blocked or hold a
 * transaction open, so the probes below always find a free admin connection.
 */
function sidePool(max: number): postgres.Sql {
  return postgres(database!.adminUrl, { max, onnotice: () => undefined });
}

/** PostgreSQL's own deadlock counter for this database (see the 0299 test). */
async function deadlockCount(): Promise<number> {
  const [row] = await database!.admin<{ deadlocks: number }[]>`
    select deadlocks::int as deadlocks from pg_stat_database where datname = current_database()`;
  return row?.deadlocks ?? 0;
}

/**
 * A backend publishes its deadlock count within about a second of going idle,
 * so watch the counter for a bounded window after every side has finished.
 */
async function expectNoNewDeadlocks(before: number): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    expect(await deadlockCount()).toBe(before);
    await pause(100);
  }
}

/** Relation locks a backend of this database waits for. */
async function waitingOn(pid: number): Promise<Lock[]> {
  return [
    ...(await database!.admin<Lock[]>`
      select lock_row.relation::regclass::text as relation, lock_row.mode
      from pg_locks lock_row
      where lock_row.pid = ${pid} and lock_row.locktype = 'relation' and not lock_row.granted
      order by 1, 2`),
  ];
}

/** Relation locks a backend holds, outside the system catalogs. */
async function heldBy(pid: number): Promise<Lock[]> {
  return [
    ...(await database!.admin<Lock[]>`
      select lock_row.relation::regclass::text as relation, lock_row.mode
      from pg_locks lock_row
      join pg_class relation on relation.oid = lock_row.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where lock_row.pid = ${pid} and lock_row.locktype = 'relation' and lock_row.granted
        and namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      order by 1, 2`),
  ];
}

/** Wait until `expected` backends of this database wait for a lock on `relation`. */
async function waitForWaitersOn(relation: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await database!.admin<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_locks lock_row
      join pg_stat_activity activity on activity.pid = lock_row.pid
      where not lock_row.granted and lock_row.locktype = 'relation'
        and lock_row.relation = ${relation}::regclass
        and activity.datname = current_database()`;
    if ((row?.waiting ?? 0) >= expected) return;
    await pause(25);
  }
  throw new Error(`fewer than ${expected} backends waited on ${relation} within the probe window`);
}

type Applying = {
  pid: number;
  /** Settles once the migration body has run or failed; the transaction stays open. */
  body: Promise<void>;
  failure: () => string | null;
  /** Its granted relation locks outside the system catalogs, read inside its transaction. */
  lockSet: () => Promise<Lock[]>;
  /** Ends the transaction once; later calls do nothing. */
  finish: (outcome: "commit" | "rollback") => Promise<void>;
};

/** 0713 as the runner applies it: one transaction, preamble first, as the owner. */
async function startMigration(): Promise<Applying> {
  const connection = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
  const reserved = await connection.reserve();
  const [backend] = await reserved<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  await reserved`begin`;
  let failed: string | null = null;
  let finished = false;
  const body = reserved.unsafe(RUNNER_PREAMBLE + migrationText).then(
    () => undefined,
    (error: unknown) => {
      failed = `${nestedPostgresSqlState(error) ?? "error"}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    },
  );
  return {
    pid: backend!.pid,
    body,
    failure: () => failed,
    lockSet: async () => [
      ...(await reserved<Lock[]>`
        select lock_row.relation::regclass::text as relation, lock_row.mode
        from pg_catalog.pg_locks lock_row
        join pg_catalog.pg_class relation on relation.oid = lock_row.relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where lock_row.pid = pg_catalog.pg_backend_pid() and lock_row.locktype = 'relation'
          and lock_row.granted
          and namespace.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        order by 1, 2`),
    ],
    finish: async (outcome) => {
      if (finished) return;
      finished = true;
      await body;
      try {
        if (failed || outcome === "rollback") {
          await reserved`rollback`;
        } else {
          await reserved`commit`;
          // The runner records the migration after its transaction commits.
          await reserved`insert into schema_migrations (name) values (${REACH_MIGRATION})`;
        }
      } finally {
        reserved.release();
        await connection.end();
      }
    },
  };
}

/** Whether 0713 parked on a lock or ran its whole body first. */
async function parkedOrApplied(applying: Applying): Promise<"parked" | "applied" | "failed"> {
  let settled = false;
  void applying.body.then(() => {
    settled = true;
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (settled) return applying.failure() ? "failed" : "applied";
    if ((await waitingOn(applying.pid)).length > 0) return "parked";
    await pause(25);
  }
  throw new Error("0713 neither finished nor parked within the probe window");
}

type Held = { reached: Promise<void>; release: () => void; done: Promise<Outcome> };

/**
 * A runtime transaction (the application role, in a workspace scope) that
 * takes the canonical workspace prefix, waits to be released, then runs
 * `next` in the same transaction.
 */
function holdWorkspacePrefix(next: (tx: Database) => Promise<void>): Held {
  const reached = gate();
  const release = gate();
  const org = staged!;
  const done = settle(
    withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      async (tx) => {
        await tx.execute(sql`select 1 from workspace_inference_controls
          where workspace_id = ${org.sharedWorkspaceId}::uuid for share`);
        await tx.execute(sql`select 1 from workspaces
          where id = ${org.sharedWorkspaceId}::uuid for key share`);
        reached.open();
        await release.opened;
        await next(tx);
      },
    ),
  );
  return {
    reached: Promise.race([reached.opened, done.then(() => undefined)]),
    release: release.open,
    done,
  };
}

/** The organization administrator's scope, as the application role. */
function asOrganizationAdministrator<T>(work: (tx: Database) => Promise<T>): Promise<T> {
  const org = staged!;
  return withRlsContext(client!.db, { accountId: org.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, org.ownerSubjectId);
    return await work(tx);
  });
}

async function readSubscriptionTables(tx: Database): Promise<void> {
  await tx.execute(sql`select count(*) from subscription_connections`);
  await tx.execute(sql`select count(*) from subscription_connection_workspaces`);
  await tx.execute(sql`select count(*) from subscription_connection_assignment_policies`);
}

async function assigned(workspaceId: string): Promise<string[]> {
  return (
    await database!.admin<{ connection_id: string }[]>`
      select connection_id::text as connection_id from subscription_connection_workspaces
      where workspace_id = ${workspaceId}::uuid`
  )
    .map((row) => row.connection_id)
    .sort();
}

/** An organization with a shared workspace and three Codex connections with reach. */
async function stage(): Promise<Staged> {
  const admin = database!.admin;
  const userId = `reach-lock-order-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Reach lock order",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Lock order shared')
    returning id::text as id`;
  const sharedWorkspaceId = workspace!.id;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${sharedWorkspaceId}::uuid, ${ownerSubjectId}, 'owner')`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${sharedWorkspaceId}::uuid, ${accountId}::uuid)`;
  const connection = async (label: string) => {
    const [row] = await admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at, label
      ) values (
        ${accountId}::uuid, 'codex', 'subscription',
        ${encryptEnvironmentValue(key, JSON.stringify({ access_token: label, refresh_token: label }))},
        'shared', 'workspaces', false, ${`codex-${label}`}, 'pro',
        ${admin.json({ isFedramp: false })}::jsonb,
        ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz, ${label}
      ) returning id::text as id`;
    return row!.id;
  };
  staged = {
    accountId,
    ownerSubjectId,
    sharedWorkspaceId,
    connections: {
      sharedOnly: await connection("shared-only"),
      personalOnly: await connection("personal-only"),
      both: await connection("both"),
    },
  };
  // Reach written through the Codex-named routine a deployment's binary calls.
  for (const [id, shared, personal] of [
    [staged.connections.sharedOnly, true, false],
    [staged.connections.personalOnly, false, true],
    [staged.connections.both, true, true],
  ] as const) {
    await asOrganizationAdministrator((tx) =>
      tx.execute(sql`select opengeni_private.set_subscription_codex_reach(
        ${accountId}::uuid, ${id}::uuid, ${shared}::boolean, ${personal}::boolean)`),
    );
  }
  return staged;
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("migration-0713-lock-order");
  if (!database) throw new Error("Real PostgreSQL is required");
  migrationText = await readFile(join(import.meta.dir, "../drizzle", REACH_MIGRATION), "utf8");
  // A provisioned database without 0713, as a deployment is before it.
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${REACH_MIGRATION}), (${LATER_MIGRATION})`;
    await migrate(database.ownerUrl);
    await owner`delete from schema_migrations where name in (${REACH_MIGRATION}, ${LATER_MIGRATION})`;
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  client = createDb(appUrl(), { max: 8 });
  await stage();
}, 600_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe("migration 0713 lock order", () => {
  test.skipIf(!realDb)(
    "takes the reach table holding nothing, then the registry, and locks no runtime table",
    async () => {
      const [roles] = await database!.admin<{ owner: boolean; app: boolean }[]>`
        select (owner_role.rolsuper or owner_role.rolbypassrls) as owner,
          (app_role.rolsuper or app_role.rolbypassrls) as app
        from pg_roles owner_role, pg_roles app_role
        where owner_role.rolname = ${database!.ownerRole} and app_role.rolname = 'opengeni_app'`;
      expect(roles).toEqual({ owner: false, app: false });
      // No runtime role can write the registry, so no runtime transaction
      // holds a lock that its SHARE ROW EXCLUSIVE lock waits for.
      const [registryWriter] = await database!.admin<{ writes: boolean }[]>`
        select has_table_privilege('opengeni_app', ${REGISTRY}::regclass,
          'INSERT, UPDATE, DELETE, TRUNCATE') as writes`;
      expect(registryWriter?.writes).toBe(false);

      // A reader of the reach table (0689's trigger, 0702's helpers) holds
      // 0713 at its first lock, and 0713 holds nothing while it waits.
      const side = sidePool(2);
      const reader = await side.reserve();
      const writer = await side.reserve();
      try {
        await reader`begin`;
        await reader.unsafe(`select count(*) from ${REACH_TABLE}`);
        // A writer of the registry (only a migration can be one) holds it at
        // its second, with only the reach table held.
        await writer`begin`;
        await writer.unsafe(`lock table ${REGISTRY} in row exclusive mode`);
        const applying = await startMigration();
        try {
          expect(await parkedOrApplied(applying)).toBe("parked");
          expect(await waitingOn(applying.pid)).toEqual([
            { relation: REACH_TABLE, mode: "AccessExclusiveLock" },
          ]);
          expect(await heldBy(applying.pid)).toEqual([]);
          await reader`commit`;
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const waiting = await waitingOn(applying.pid);
            if (waiting.length > 0 && waiting[0]!.relation === REGISTRY) break;
            await pause(25);
          }
          expect(await waitingOn(applying.pid)).toEqual([
            { relation: REGISTRY, mode: "ShareRowExclusiveLock" },
          ]);
          expect(await heldBy(applying.pid)).toEqual([
            { relation: REACH_TABLE, mode: "AccessExclusiveLock" },
          ]);
          await writer`commit`;
          await applying.body;
          expect(applying.failure()).toBeNull();
          // The whole lock set, read inside 0713's transaction: owner data
          // only (the reach table and its indexes, the registry and its key,
          // and the table and view 0713 creates), never a runtime table.
          const locks = await applying.lockSet();
          const locked = [...new Set(locks.map((lock) => lock.relation))].sort();
          for (const table of RUNTIME_TABLES) expect(locked).not.toContain(table);
          expect(locked).toEqual([
            "opengeni_private.subscription_codex_auto_assignments",
            "opengeni_private.subscription_codex_auto_assignments_account_idx",
            "opengeni_private.subscription_codex_auto_assignments_pkey",
            "opengeni_private.subscription_core_auto_assignments",
            "opengeni_private.subscription_core_plan_change_providers",
            "opengeni_private.subscription_core_plan_change_providers_pkey",
            "opengeni_private.subscription_core_providers",
            "opengeni_private.subscription_core_providers_pkey",
          ]);
          const modes = (relation: string) =>
            locks.filter((lock) => lock.relation === relation).map((lock) => lock.mode);
          expect(modes(REACH_TABLE)).toContain("AccessExclusiveLock");
          expect(modes(REGISTRY)).toContain("ShareRowExclusiveLock");
          expect(modes(REGISTRY)).not.toContain("AccessExclusiveLock");
          expect(modes(REGISTRY)).not.toContain("ExclusiveLock");
        } finally {
          await applying.finish("rollback");
        }
      } finally {
        await reader`rollback`.catch(() => undefined);
        await writer`rollback`.catch(() => undefined);
        reader.release();
        writer.release();
        await side.end();
      }
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "a transaction holding its workspace prefix reaches the subscription tables while 0713 applies",
    async () => {
      const before = await deadlockCount();
      const holder = holdWorkspacePrefix(readSubscriptionTables);
      await holder.reached;
      const applying = await startMigration();
      let state: Awaited<ReturnType<typeof parkedOrApplied>>;
      try {
        // 0713 needs nothing this transaction holds, so it runs its whole
        // body without waiting; the transaction then reaches the
        // subscription tables while 0713 still holds its locks.
        state = await parkedOrApplied(applying);
        holder.release();
        expect(await holder.done).toEqual({ ok: true });
      } finally {
        holder.release();
        await applying.finish("rollback");
      }
      // A migration that waited for the prefix while holding a subscription
      // table would be PostgreSQL's deadlock victim here (40P01).
      expect(applying.failure()).toBeNull();
      expect(state).toBe("applied");
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "an older binary's reach edit holds 0713 at its first lock and still reaches the connections",
    async () => {
      const org = staged!;
      const before = await deadlockCount();
      const reached = gate();
      const release = gate();
      // 0702's helper reads the connection, then writes the reach table.
      const editor = settle(
        asOrganizationAdministrator(async (tx) => {
          await tx.execute(sql`select opengeni_private.set_subscription_codex_reach(
            ${org.accountId}::uuid, ${org.connections.sharedOnly}::uuid, true, false)`);
          reached.open();
          await release.opened;
          await tx.execute(sql`select 1 from subscription_connections
            where id = ${org.connections.sharedOnly}::uuid for key share`);
          await readSubscriptionTables(tx);
        }),
      );
      await Promise.race([reached.opened, editor]);
      const applying = await startMigration();
      try {
        expect(await parkedOrApplied(applying)).toBe("parked");
        expect(await waitingOn(applying.pid)).toEqual([
          { relation: REACH_TABLE, mode: "AccessExclusiveLock" },
        ]);
        expect(await heldBy(applying.pid)).toEqual([]);
        release.open();
        expect(await editor).toEqual({ ok: true });
        await applying.body;
        expect(applying.failure()).toBeNull();
      } finally {
        release.open();
        await applying.finish("rollback");
      }
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "workspace and Personal-workspace creation straddle 0713's commit with Codex reach applied",
    async () => {
      const org = staged!;
      const before = await deadlockCount();
      // Created before 0713 as a shared workspace, claimed as a member's
      // Personal workspace while 0713 holds its lock.
      const [personal] = await database!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${org.accountId}::uuid, 'Lock order Personal') returning id::text as id`;
      expect(await assigned(personal!.id)).toEqual(
        [org.connections.sharedOnly, org.connections.both].sort(),
      );
      // A runtime transaction holding its workspace prefix and the
      // connections stays open while 0713 starts.
      const reader = holdWorkspacePrefix(readSubscriptionTables);
      await reader.reached;
      const applying = await startMigration();
      const member = sidePool(1);
      let created: Outcome | null = null;
      let createdId: string | null = null;
      let claimed: Outcome | null = null;
      try {
        const state = await parkedOrApplied(applying);
        expect(state).toBe("applied");
        const creating = settle(
          createOrganizationWorkspace(client!.db, {
            organizationId: org.accountId,
            actorSubjectId: org.ownerSubjectId,
            name: "Lock order created",
            operationId: crypto.randomUUID(),
          }).then((workspace) => {
            createdId = workspace.id;
          }),
        );
        const claiming = settle(
          (async () =>
            await member`insert into organization_memberships
              (account_id, subject_id, role, status, personal_workspace_id)
              values (${org.accountId}::uuid, ${`user:reach-lock-order-member-${crypto.randomUUID()}`},
                'member', 'active', ${personal!.id}::uuid)`)(),
        );
        // Both creations reach 0689's triggers and wait on the reach table
        // 0713 holds, holding their new rows.
        await waitForWaitersOn(REACH_TABLE, 2);
        reader.release();
        expect(await reader.done).toEqual({ ok: true });
        await applying.finish("commit");
        created = await creating;
        claimed = await claiming;
      } finally {
        reader.release();
        await applying.finish("rollback");
        await member.end();
      }
      expect(applying.failure()).toBeNull();
      expect(created).toEqual({ ok: true });
      expect(claimed).toEqual({ ok: true });
      // Reach applied exactly as before 0713: the shared rules to the new
      // workspace, the Personal rules to the claimed one.
      expect(await assigned(createdId!)).toEqual(
        [org.connections.sharedOnly, org.connections.both].sort(),
      );
      expect(await assigned(personal!.id)).toEqual(
        [org.connections.personalOnly, org.connections.both].sort(),
      );
      const [applied] = await database!.admin<{ recorded: number; provider: number }[]>`
        select (select count(*)::int from schema_migrations where name = ${REACH_MIGRATION})
            as recorded,
          (select count(*)::int from pg_attribute
            where attrelid = ${REACH_TABLE}::regclass and attname = 'provider'
              and not attisdropped) as provider`;
      expect(applied).toEqual({ recorded: 1, provider: 1 });
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );
});
