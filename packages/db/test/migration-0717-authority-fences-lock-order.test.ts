// Migration 0717 is rolling: live work keeps running while it adds policies on
// organization_memberships and organization_user_resource_authorities, forces
// row security on the xAI credentials, and replaces the turn-execution trigger
// on session_turns. Runtime work reads memberships before turns (session
// visibility) and turns before memberships (the turn enqueue then the v2
// writer), so no static order of these tables is cycle-free.
//
// 0717 takes its whole lock set first with a 100 ms per-wait lock timeout
// inside a savepoint, retrying until it holds every lock, so it never holds
// one of these locks long while it waits. These cases apply it as the runner
// does (preamble and file in one transaction) as the NOSUPERUSER NOBYPASSRLS
// owner, race it against runtime shapes in both orders as the restricted
// application role, and take the evidence from each side's outcome and
// PostgreSQL's own deadlock counter. Every case but the last rolls 0717 back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  nestedPostgresSqlState,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  stageVaultPolicyColumns,
  stageConnectionAccountIntentColumns,
} from "./vault-policy-column-fixture";

const FENCES = "0717_subscription_authority_fences.sql";
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
// What the runner sends ahead of a migration body, in the same transaction
// (`executeMigrationFile` in src/migrate.ts).
const RUNNER_PREAMBLE = `SELECT
  pg_catalog.set_config('lock_timeout', '5s', true),
  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n`;
const LOCKED = [
  "claude_subscription_credentials",
  "organization_memberships",
  "organization_user_resource_authorities",
  "session_turns",
  "xai_subscription_credentials",
];

type Lock = { relation: string; mode: string };
type Outcome = { ok: true } | { ok: false; state: string | null; message: string };
type Staged = {
  accountId: string;
  subjectId: string;
  workspaceId: string;
  sessionId: string;
};

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

/** Locks on 0717's tables a backend holds (granted) or waits for. */
async function lockedTableLocks(pid: number, granted: boolean): Promise<Lock[]> {
  return [
    ...(await database!.admin<Lock[]>`
      select lock_row.relation::regclass::text as relation, lock_row.mode
      from pg_locks lock_row
      where lock_row.pid = ${pid} and lock_row.locktype = 'relation'
        and lock_row.granted = ${granted}
        and lock_row.relation::regclass::text = any(${LOCKED}::text[])
      order by 1, 2`),
  ];
}

/** Poll until `probe` holds, at 5 ms intervals, for at most `ms`. */
async function until(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await pause(5);
  }
  return false;
}

type Applying = {
  pid: number;
  /** Settles once the migration body has run or failed; the transaction stays open. */
  body: Promise<void>;
  failure: () => string | null;
  /** Milliseconds from the start of the body to its end. */
  elapsed: () => number;
  finish: (outcome: "commit" | "rollback") => Promise<void>;
};

/** 0717 as the runner applies it: one transaction, preamble first, as the owner. */
async function startMigration(): Promise<Applying> {
  const connection = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
  const reserved = await connection.reserve();
  const [backend] = await reserved<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
  await reserved`begin`;
  let failed: string | null = null;
  let finished = false;
  const started = Date.now();
  let ended = 0;
  const body = reserved.unsafe(RUNNER_PREAMBLE + migrationText).then(
    () => {
      ended = Date.now();
    },
    (error: unknown) => {
      ended = Date.now();
      failed = `${nestedPostgresSqlState(error) ?? "error"}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    },
  );
  return {
    pid: backend!.pid,
    body,
    failure: () => failed,
    elapsed: () => (ended || Date.now()) - started,
    finish: async (outcome) => {
      if (finished) return;
      finished = true;
      await body;
      try {
        if (failed || outcome === "rollback") {
          await reserved`rollback`;
        } else {
          await reserved`commit`;
          await reserved`insert into schema_migrations (name) values (${FENCES})`;
        }
      } finally {
        reserved.release();
        await connection.end();
      }
    },
  };
}

type Held = {
  /** The backend running the transaction, once its first step ran. */
  pid: Promise<number>;
  release: () => void;
  done: Promise<Outcome>;
};

/**
 * A runtime transaction as the application role in the owner's Personal
 * workspace: runs `first`, waits to be released, then runs `then` in the same
 * transaction.
 */
function hold(first: (tx: Database) => Promise<void>, then: (tx: Database) => Promise<void>): Held {
  const reached = gate();
  const release = gate();
  let backendPid = 0;
  const org = staged!;
  const done = settle(
    withSessionRlsActorContext({ subjectId: org.subjectId }, () =>
      withRlsContext(
        client!.db,
        { accountId: org.accountId, workspaceId: org.workspaceId },
        async (tx) => {
          const rows = (await tx.execute(sql`select pg_backend_pid()::int as pid`)) as unknown as
            | { pid: number }[]
            | { rows: { pid: number }[] };
          backendPid = Array.isArray(rows) ? rows[0]!.pid : rows.rows[0]!.pid;
          await first(tx);
          reached.open();
          await release.opened;
          await then(tx);
        },
      ),
    ),
  );
  return {
    pid: Promise.race([reached.opened, done.then(() => undefined)]).then(() => backendPid),
    release: release.open,
    done,
  };
}

/**
 * A transaction holding one table in ACCESS SHARE mode, then reading
 * memberships, as the test administrator: a stand-in for the owner's
 * routines, the only runtime path to tables the application role holds no
 * privilege on (the authorities and, for reads, the Claude credentials).
 */
function holdAsOwnerRoutine(table: string): Held {
  const reached = gate();
  const release = gate();
  let backendPid = 0;
  const done = settle(
    (async () => {
      const reserved = await database!.admin.reserve();
      try {
        await reserved`begin`;
        const [row] = await reserved<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
        backendPid = row!.pid;
        await reserved.unsafe(`lock table ${table} in access share mode`);
        reached.open();
        await release.opened;
        await reserved`select count(*) from organization_memberships`;
        await reserved`commit`;
      } catch (error) {
        await reserved`rollback`.catch(() => undefined);
        throw error;
      } finally {
        reserved.release();
      }
    })(),
  );
  return {
    pid: Promise.race([reached.opened, done.then(() => undefined)]).then(() => backendPid),
    release: release.open,
    done,
  };
}

// Each runtime step takes exactly one of 0717's tables (row security on other
// reads reaches further tables), the shape in which a lock cycle could form.
// The application role reads memberships only through the owner's routines.
const holdMemberships = (tx: Database) =>
  tx
    .execute(sql`select count(*) from list_self_organization_memberships(${staged!.subjectId})`)
    .then(() => undefined);
const holdTurns = (tx: Database) =>
  tx.execute(sql`lock table session_turns in row exclusive mode`).then(() => undefined);
const holdXaiCredentials = (tx: Database) =>
  tx
    .execute(sql`lock table xai_subscription_credentials in access share mode`)
    .then(() => undefined);
const readTurns = (tx: Database) =>
  tx
    .execute(sql`select count(*) from session_turns where session_id = ${staged!.sessionId}::uuid`)
    .then(() => undefined);
const readMemberships = holdMemberships;

async function policyPresent(): Promise<boolean> {
  const [row] = await database!.admin<{ present: boolean }[]>`
    select exists (
      select 1 from pg_policies
      where tablename = 'organization_memberships'
        and policyname = 'claude_subscription_membership_lock'
    ) as present`;
  return row?.present ?? false;
}

async function stage(): Promise<Staged> {
  const userId = `fences-lock-order-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Fences lock order",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await database!.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  const workspaceId = membership!.personal_workspace_id;
  const session = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client!.db, {
      accountId,
      workspaceId,
      initialMessage: "fences lock order",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "user_private",
      subjectId,
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  await withSessionRlsActorContext({ subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "fences lock order",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId },
    }),
  );
  return { accountId, subjectId, workspaceId, sessionId: session.id };
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("migration-0717-lock-order");
  if (!database) throw new Error("Real PostgreSQL is required");
  migrationText = await readFile(join(import.meta.dir, "../drizzle", FENCES), "utf8");
  // A provisioned database without 0717, as a deployment is before it: 0717
  // and every later migration (which may require 0717) are held back.
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= FENCES)
    .sort();
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack) await owner`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await stageVaultPolicyColumns(database.ownerUrl);
    await stageConnectionAccountIntentColumns(database.ownerUrl);
    // Current adapters project the immutable Site audience. This fixture never
    // advances through 0793: expose nullable columns only, without installing
    // later audience triggers or changing the historical lock topology.
    await owner`alter table sessions
      add column site_id uuid,
      add column site_access_root_id uuid,
      add column site_viewer_principal text,
      add column site_owner_subject_id text`;
    await owner`delete from schema_migrations where name = any(${heldBack}::text[])`;
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  client = createDb(appUrl(), { max: 8 });
  staged = await stage();
}, 600_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe("migration 0717 lock order", () => {
  test.skipIf(!realDb)(
    "runs as an owner and application role that bypass nothing, under the default deadlock timeout",
    async () => {
      const [roles] = await database!.admin<{ owner: boolean; app: boolean }[]>`
        select (owner_role.rolsuper or owner_role.rolbypassrls) as owner,
          (app_role.rolsuper or app_role.rolbypassrls) as app
        from pg_roles owner_role, pg_roles app_role
        where owner_role.rolname = ${database!.ownerRole} and app_role.rolname = 'opengeni_app'`;
      expect(roles).toEqual({ owner: false, app: false });
      const [timeout] = await database!.admin<{ setting: string }[]>`
        select setting from pg_settings where name = 'deadlock_timeout'`;
      expect(Number(timeout!.setting)).toBeGreaterThanOrEqual(1000);
      expect(await policyPresent()).toBe(false);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "live work holding memberships reaches turns while 0717 waits, holding nothing",
    async () => {
      const before = await deadlockCount();
      // Session visibility: memberships, then turns.
      const runtime = hold(holdMemberships, readTurns);
      await runtime.pid;
      const applying = await startMigration();
      try {
        // 0717 asks for organization_memberships first, so while this
        // transaction holds it the migration waits there (retrying), holding
        // none of its tables.
        expect(
          await until(async () => (await lockedTableLocks(applying.pid, false)).length > 0, 5_000),
        ).toBe(true);
        // Keep the transaction open across many 100 ms attempts.
        for (let probe = 0; probe < 20; probe += 1) {
          expect(await lockedTableLocks(applying.pid, true)).toEqual([]);
          await pause(100);
        }
        runtime.release();
        expect(await runtime.done).toEqual({ ok: true });
        await applying.body;
        expect(applying.failure()).toBeNull();
      } finally {
        runtime.release();
        await applying.finish("rollback");
      }
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );

  for (const shape of [
    {
      name: "a turn writer holding turns that reaches memberships (the enqueue then the v2 writer)",
      start: () => hold(holdTurns, readMemberships),
      waitsOn: "session_turns",
    },
    {
      name: "a credential reader holding xAI credentials that reaches memberships",
      start: () => hold(holdXaiCredentials, readMemberships),
      waitsOn: "xai_subscription_credentials",
    },
    {
      name: "an owner routine holding Claude credentials that reaches memberships",
      start: () => holdAsOwnerRoutine("claude_subscription_credentials"),
      waitsOn: "claude_subscription_credentials",
    },
    {
      name: "an owner routine holding authorities that reaches memberships",
      start: () => holdAsOwnerRoutine("organization_user_resource_authorities"),
      waitsOn: "organization_user_resource_authorities",
    },
  ]) {
    test.skipIf(!realDb)(
      `${shape.name} is granted it within one attempt and neither side is a deadlock victim`,
      async () => {
        const before = await deadlockCount();
        const runtime = shape.start();
        await runtime.pid;
        const applying = await startMigration();
        try {
          // Catch an attempt that holds memberships and waits for the table
          // this transaction holds: the shape of a lock cycle once it reads
          // memberships.
          expect(
            await until(async () => {
              const waiting = await lockedTableLocks(applying.pid, false);
              const held = await lockedTableLocks(applying.pid, true);
              return (
                waiting.some((lock) => lock.relation === shape.waitsOn) &&
                held.some((lock) => lock.relation === "organization_memberships")
              );
            }, 10_000),
          ).toBe(true);
          const released = Date.now();
          runtime.release();
          expect(await runtime.done).toEqual({ ok: true });
          // The attempt gave up its wait within its 100 ms lock timeout and
          // released memberships; the transaction never waited long enough
          // for a deadlock check (one second).
          expect(Date.now() - released).toBeLessThan(900);
          await applying.body;
          expect(applying.failure()).toBeNull();
        } finally {
          runtime.release();
          await applying.finish("rollback");
        }
        await expectNoNewDeadlocks(before);
      },
      180_000,
    );
  }

  test.skipIf(!realDb)(
    "gives up after 30 seconds without the whole set, changing nothing (55P03, safe to retry)",
    async () => {
      const runtime = hold(holdMemberships, async () => undefined);
      await runtime.pid;
      const applying = await startMigration();
      try {
        await applying.body;
        expect(applying.failure()).toMatch(/^55P03: 0717 could not lock/);
        expect(applying.elapsed()).toBeGreaterThanOrEqual(30_000);
      } finally {
        await applying.finish("rollback");
        runtime.release();
      }
      expect(await runtime.done).toEqual({ ok: true });
      expect(await policyPresent()).toBe(false);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "applies and commits once it holds the set, and live work then proceeds",
    async () => {
      const before = await deadlockCount();
      const applying = await startMigration();
      try {
        await applying.body;
        expect(applying.failure()).toBeNull();
      } finally {
        await applying.finish("commit");
      }
      const runtime = hold(holdMemberships, readTurns);
      runtime.release();
      expect(await runtime.done).toEqual({ ok: true });
      expect(await policyPresent()).toBe(true);
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );
});
