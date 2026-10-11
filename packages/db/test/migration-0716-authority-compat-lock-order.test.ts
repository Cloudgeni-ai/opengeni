// Migration 0716 is rolling: live session and scheduled work keeps running
// while it adds the authority marker, its triggers and the deferred check to
// six carrier tables. Runtime work takes `sessions` before `session_turns`
// (packages/db/src/session-control.ts), while scheduled dispatch can lock a
// task before it creates the task's session, and a reader can reach turns
// before sessions, so no static order of the six tables is cycle-free. A
// first draft took ACCESS EXCLUSIVE one ALTER TABLE at a time, `session_turns`
// first, and closed a lock cycle with live session work: PostgreSQL aborted
// one side with 40P01, the deploy Job or a live runtime transaction.
//
// 0716 now takes the whole lock set first with a 100 ms per-wait lock timeout
// inside a savepoint, retrying until it holds every lock, so it never holds a
// carrier lock long while it waits. These cases apply it as the runner does
// (preamble and file in one transaction) as the NOSUPERUSER NOBYPASSRLS
// owner, race it against runtime shapes in every order as the restricted
// application role, and take the evidence from each side's outcome and
// PostgreSQL's own deadlock counter. Every case but the last rolls 0716 back.
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

const COMPAT = "0716_subscription_authority_compat.sql";
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
// What the runner sends ahead of a migration body, in the same transaction
// (`executeMigrationFile` in src/migrate.ts).
const RUNNER_PREAMBLE = `SELECT
  pg_catalog.set_config('lock_timeout', '5s', true),
  pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
  pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true);\n`;
const CARRIERS = [
  "scheduled_task_revision_authorities",
  "scheduled_tasks",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turns",
  "sessions",
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

/** Carrier-table locks a backend holds (granted) or waits for. */
async function carrierLocks(pid: number, granted: boolean): Promise<Lock[]> {
  return [
    ...(await database!.admin<Lock[]>`
      select lock_row.relation::regclass::text as relation, lock_row.mode
      from pg_locks lock_row
      where lock_row.pid = ${pid} and lock_row.locktype = 'relation'
        and lock_row.granted = ${granted}
        and lock_row.relation::regclass::text = any(${CARRIERS}::text[])
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

/** 0716 as the runner applies it: one transaction, preamble first, as the owner. */
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
          await reserved`insert into schema_migrations (name) values (${COMPAT})`;
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

const lockSession = (tx: Database) =>
  tx
    .execute(sql`select 1 from sessions where id = ${staged!.sessionId}::uuid for no key update`)
    .then(() => undefined);
const readTurns = (tx: Database) =>
  tx
    .execute(sql`select count(*) from session_turns where session_id = ${staged!.sessionId}::uuid`)
    .then(() => undefined);
// Row security on turns and tasks reaches `sessions` too, so a plain read
// already holds the session table. These take only the one table, the shape
// in which a lock cycle with 0716 could form.
const holdTurnsOnly = (tx: Database) =>
  tx.execute(sql`lock table session_turns in row exclusive mode`).then(() => undefined);
const holdTasksOnly = (tx: Database) =>
  tx.execute(sql`lock table scheduled_tasks in row share mode`).then(() => undefined);

async function stage(): Promise<Staged> {
  const userId = `compat-lock-order-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Compatibility lock order",
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
      initialMessage: "compatibility lock order",
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
      prompt: "compatibility lock order",
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
  database = await acquireOwnerMigratedTestDatabase("migration-0716-lock-order");
  if (!database) throw new Error("Real PostgreSQL is required");
  migrationText = await readFile(join(import.meta.dir, "../drizzle", COMPAT), "utf8");
  // A provisioned database without 0716, as a deployment is before it: 0716
  // and every later migration (which may require 0716) are held back.
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= COMPAT)
    .sort();
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack) await owner`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
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

describe("migration 0716 lock order", () => {
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
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "live session work holding a session row reaches its turns while 0716 waits, holding nothing",
    async () => {
      const before = await deadlockCount();
      // The canonical runtime prefix: the session row, then its turns.
      const runtime = hold(lockSession, readTurns);
      await runtime.pid;
      const applying = await startMigration();
      try {
        // 0716 asks for `sessions` first, so while this transaction holds its
        // session row it waits there (retrying), holding no carrier lock.
        expect(
          await until(async () => (await carrierLocks(applying.pid, false)).length > 0, 5_000),
        ).toBe(true);
        // Keep the transaction open across many 100 ms attempts.
        for (let probe = 0; probe < 20; probe += 1) {
          expect(await carrierLocks(applying.pid, true)).toEqual([]);
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
      name: "a writer holding turns that reaches the session row while 0716 holds `sessions`",
      first: holdTurnsOnly,
      then: lockSession,
      waitsOn: "session_turns",
    },
    {
      name: "scheduled work holding a task that reaches its session while 0716 holds the session tables",
      first: holdTasksOnly,
      then: lockSession,
      waitsOn: "scheduled_tasks",
    },
  ]) {
    test.skipIf(!realDb)(
      `${shape.name} is granted it within one attempt and neither side is a deadlock victim`,
      async () => {
        const before = await deadlockCount();
        const runtime = hold(shape.first, shape.then);
        await runtime.pid;
        const applying = await startMigration();
        try {
          // Catch an attempt that holds `sessions` and waits for the table
          // this transaction holds: the shape of a lock cycle once it asks for
          // the session row.
          expect(
            await until(async () => {
              const waiting = await carrierLocks(applying.pid, false);
              const held = await carrierLocks(applying.pid, true);
              return (
                waiting.some((lock) => lock.relation === shape.waitsOn) &&
                held.some((lock) => lock.relation === "sessions")
              );
            }, 10_000),
          ).toBe(true);
          const released = Date.now();
          runtime.release();
          expect(await runtime.done).toEqual({ ok: true });
          // The attempt gave up its wait within its 100 ms lock timeout and
          // released `sessions`; the transaction never waited long enough
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
      const runtime = hold(lockSession, async () => undefined);
      await runtime.pid;
      const applying = await startMigration();
      try {
        await applying.body;
        expect(applying.failure()).toMatch(/^55P03: 0716 could not lock/);
        expect(applying.elapsed()).toBeGreaterThanOrEqual(30_000);
      } finally {
        await applying.finish("rollback");
        runtime.release();
      }
      expect(await runtime.done).toEqual({ ok: true });
      const [column] = await database!.admin<{ present: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_name = 'sessions' and column_name = 'authority_inserted_at'
        ) as present`;
      expect(column?.present).toBe(false);
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
      const runtime = hold(lockSession, readTurns);
      runtime.release();
      expect(await runtime.done).toEqual({ ok: true });
      const [column] = await database!.admin<{ present: boolean }[]>`
        select exists (
          select 1 from information_schema.columns
          where table_name = 'sessions' and column_name = 'authority_inserted_at'
        ) as present`;
      expect(column?.present).toBe(true);
      await expectNoNewDeadlocks(before);
    },
    180_000,
  );
});
