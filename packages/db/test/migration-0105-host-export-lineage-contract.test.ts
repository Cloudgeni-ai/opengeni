import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration0097 = "0097_host_export_outbox.sql";
const migration0103 = "0103_host_export_root_session.sql";
const migration0104 = "0104_host_export_root_session_backfill.sql";
const migration0105 = "0105_host_export_lineage_contract.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const publishedHashes = {
  [migration0097]: "918763f2438efd06232f221305db6acac76e2bee5fa436e9665a860794c43d03",
  [migration0103]: "7a1a5c22bd7f0f5e38c5641257f709c99d7cfa0b4816fcdab2f8cbe0ba9db743",
  [migration0104]: "42d29994ac12b7118f0a1e3c252615509e887ee84bb1854056c9bf90e578760d",
} as const;

let availabilityProbe: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  availabilityProbe = await acquireBlankTestDatabase("migration-0105-availability");
  if (!availabilityProbe) {
    if (requireRealDatabase) {
      throw new Error("[migration-0105] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await availabilityProbe?.release();
});

describe("0105 forward-only host-export lineage contract", () => {
  test("preserves published history and declares bounded, data-read-only repair", async () => {
    for (const [file, expected] of Object.entries(publishedHashes)) {
      const bytes = await readFile(join(migrationsDir, file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }

    const forward = await readFile(join(migrationsDir, migration0105), "utf8");
    expect(forward.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(forward).toContain("SET LOCAL lock_timeout = '5s'");
    expect(forward).toContain("SET LOCAL statement_timeout = '5min'");
    expect(forward.match(/FOR SHARE;/g)).toHaveLength(2);
    expect(forward).toContain('VALIDATE CONSTRAINT "host_export_outbox_root_session_check"');
    expect(forward).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+"?host_export_outbox\b/i);
  });

  test("upgrades the zero-population published chain and replays after a ledger-write crash", async () => {
    await withBlankDatabase("migration-0105-zero", async (sql) => {
      await applyThrough(sql, migration0104);
      const [before] = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from host_export_outbox`;
      expect(before?.count).toBe(0);

      const forward = await migrationSql(migration0105);
      await sql.unsafe(forward);
      // The canonical runner commits SQL before inserting the filename into its
      // ledger. Replaying the committed schema must be safe after that crash.
      await sql.unsafe(forward);
      await recordMigration(sql, migration0105);

      const [constraint] = await sql<Array<{ validated: boolean; expression: string }>>`
        select c.convalidated as validated,
          pg_get_expr(c.conbin, c.conrelid, true) as expression
        from pg_catalog.pg_constraint c
        where c.conname = 'host_export_outbox_root_session_check'
          and c.conrelid = 'host_export_outbox'::regclass`;
      expect(constraint).toMatchObject({
        validated: true,
        expression: expect.stringContaining("root_session_id IS NOT NULL"),
      });

      const definitions = await enqueueDefinitions(sql);
      expect(definitions).toHaveLength(2);
      expect(definitions.every((definition) => definition.includes("FOR SHARE"))).toBe(true);

      const scope = await seedScope(sql, "zero");
      const sourceId = crypto.randomUUID();
      await insertOutbox(sql, {
        ...scope,
        sourceId,
        sessionId: scope.childId,
        key: "zero-current-child",
      });
      const [captured] = await sql<Array<{ rootSessionId: string | null }>>`
        select root_session_id as "rootSessionId"
        from host_export_outbox where source_id = ${sourceId}::uuid`;
      expect(captured?.rootSessionId).toBe(scope.rootId);

      let nullRootError: unknown;
      try {
        await sql`
          update host_export_outbox set root_session_id = null
          where source_id = ${sourceId}::uuid`;
      } catch (error) {
        nullRootError = error;
      }
      expect(nullRootError).toBeInstanceOf(Error);
      expect((nullRootError as Error).message).toContain("host_export_outbox_root_session_check");
    });
  }, 180_000);

  test("rejects non-null roots produced by the old backfill without immutable provenance", async () => {
    await withBlankDatabase("migration-0105-old-ledger", async (sql) => {
      await applyThrough(sql, migration0097);
      const scope = await seedScope(sql, "old-ledger");
      const sourceId = crypto.randomUUID();
      await insertOutbox(sql, {
        ...scope,
        sourceId,
        sessionId: scope.childId,
        key: "old-ledger-child",
      });

      await applyRange(sql, migration0097, migration0103);
      await applyRange(sql, migration0103, migration0104);
      const [backfilled] = await sql<Array<{ rootSessionId: string | null }>>`
        select root_session_id as "rootSessionId"
        from host_export_outbox where source_id = ${sourceId}::uuid`;
      expect(backfilled?.rootSessionId).toBe(scope.rootId);
      const definitionsBefore = await enqueueDefinitions(sql);
      expect(definitionsBefore.every((definition) => !definition.includes("FOR SHARE"))).toBe(true);

      let provenanceError: unknown;
      try {
        await sql.unsafe(await migrationSql(migration0105));
      } catch (error) {
        provenanceError = error;
      }
      expect(provenanceError).toBeInstanceOf(Error);
      expect((provenanceError as Error).message).toContain("without immutable-capture provenance");

      const [constraintAfter] = await sql<Array<{ count: number }>>`
        select count(*)::integer as count
        from pg_catalog.pg_constraint
        where conname = 'host_export_outbox_root_session_check'
          and conrelid = 'host_export_outbox'::regclass`;
      expect(constraintAfter?.count).toBe(0);
      const definitionsAfter = await enqueueDefinitions(sql);
      expect(definitionsAfter).toEqual(definitionsBefore);
    });
  }, 180_000);

  test("accepts post-0103 capture and linearizes first-consumer registration", async () => {
    await withBlankDatabase("migration-0105-concurrency", async (sql, databaseUrl) => {
      await applyThrough(sql, migration0103);
      const scope = await seedScope(sql, "concurrency");
      const existingSourceId = crypto.randomUUID();
      await insertOutbox(sql, {
        ...scope,
        sourceId: existingSourceId,
        sessionId: scope.childId,
        key: "post-0103-child",
      });
      await applyRange(sql, migration0103, migration0104);
      await applyRange(sql, migration0104, migration0105);

      const sourceApplication = `migration-0105-source-${crypto.randomUUID()}`;
      const source = postgres(databaseUrl, {
        max: 1,
        prepare: false,
        connection: { application_name: sourceApplication },
      });
      const registration = postgres(databaseUrl, { max: 1, prepare: false });
      const eventId = crypto.randomUUID();
      let sourceOpen = false;
      let registrationOpen = false;
      try {
        await source.unsafe("begin");
        sourceOpen = true;
        await source`
          insert into session_events (
            id, account_id, workspace_id, session_id, sequence, type, payload
          ) values (
            ${eventId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.childId},
            1, 'agent.message.completed', ${source.json({ forward: true })}
          )`;

        await registration.unsafe("begin");
        registrationOpen = true;
        await registration`select opengeni_host_export.register_host_export_consumer(
          'session_event', 'migration-0105-concurrent'
        )`;

        let sourceSettled = false;
        const sourceCommit = source.unsafe("commit").finally(() => {
          sourceOpen = false;
          sourceSettled = true;
        });
        let waitedForRegistration = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (sourceSettled) break;
          const [activity] = await sql<Array<{ waitEventType: string | null }>>`
            select wait_event_type as "waitEventType"
            from pg_catalog.pg_stat_activity
            where application_name = ${sourceApplication}`;
          if (activity?.waitEventType === "Lock") {
            waitedForRegistration = true;
            break;
          }
          await Bun.sleep(10);
        }

        await registration.unsafe("commit");
        registrationOpen = false;
        await sourceCommit;
        expect(waitedForRegistration).toBe(true);
      } finally {
        if (registrationOpen) await registration.unsafe("rollback").catch(() => undefined);
        if (sourceOpen) await source.unsafe("rollback").catch(() => undefined);
        await registration.end();
        await source.end();
      }

      const [exported] = await sql<Array<{ rootSessionId: string | null }>>`
        select root_session_id as "rootSessionId"
        from host_export_outbox where source_id = ${eventId}::uuid`;
      expect(exported?.rootSessionId).toBe(scope.rootId);
    });
  }, 180_000);

  test("bounds scale and lock contention and rejects incompatible partial state", async () => {
    await withBlankDatabase("migration-0105-bounds", async (sql, databaseUrl) => {
      await applyThrough(sql, migration0104);
      const scope = await seedScope(sql, "bounds");
      await sql.unsafe(
        `insert into host_export_outbox (
          export_kind, source_id, account_id, workspace_id, session_id,
          event_type, idempotency_key, payload, envelope_bytes,
          occurred_at, source_recorded_at, enqueued_at
        )
        select 'session_event', gen_random_uuid(), $1::uuid, $2::uuid, null,
          'test.scale', 'scale:' || value::text, '{}'::jsonb, 128,
          now(), now(), now()
        from generate_series(1, 25000) value`,
        [scope.accountId, scope.workspaceId],
      );

      const forward = await migrationSql(migration0105);
      await sql.unsafe(forward);
      const [scaled] = await sql<Array<{ count: number }>>`
        select count(*)::integer as count from host_export_outbox`;
      expect(scaled?.count).toBe(25_000);

      await sql.unsafe(`
        ALTER TABLE host_export_outbox
          DROP CONSTRAINT host_export_outbox_root_session_check;
        ALTER TABLE host_export_outbox
          ADD CONSTRAINT host_export_outbox_root_session_check
          CHECK (session_id IS NULL OR root_session_id IS NOT NULL) NOT VALID;
      `);
      await sql.unsafe(forward);
      const [recoveredPartial] = await sql<Array<{ validated: boolean }>>`
        select convalidated as validated from pg_catalog.pg_constraint
        where conname = 'host_export_outbox_root_session_check'
          and conrelid = 'host_export_outbox'::regclass`;
      expect(recoveredPartial?.validated).toBe(true);

      await sql.unsafe(`
        ALTER TABLE host_export_outbox
          DROP CONSTRAINT host_export_outbox_root_session_check;
        ALTER TABLE host_export_outbox
          ADD CONSTRAINT host_export_outbox_root_session_check
          CHECK (session_id IS NULL) NOT VALID;
      `);
      let incompatibleError: unknown;
      try {
        await sql.unsafe(forward);
      } catch (error) {
        incompatibleError = error;
      }
      expect(incompatibleError).toBeInstanceOf(Error);
      expect((incompatibleError as Error).message).toContain("incompatible expression");

      await sql.unsafe(`ALTER TABLE host_export_outbox
        DROP CONSTRAINT host_export_outbox_root_session_check`);
      const blocker = postgres(databaseUrl, { max: 1, prepare: false });
      const contender = postgres(databaseUrl, { max: 1, prepare: false });
      let blockerOpen = false;
      try {
        await blocker.unsafe("begin");
        blockerOpen = true;
        await blocker.unsafe("lock table host_export_outbox in access exclusive mode");
        let lockError: unknown;
        try {
          await contender.unsafe(forward);
        } catch (error) {
          lockError = error;
        }
        expect(lockError).toBeInstanceOf(Error);
        expect((lockError as { code?: string }).code).toBe("55P03");
        expect((lockError as Error).message).toContain("lock timeout");
      } finally {
        if (blockerOpen) await blocker.unsafe("rollback").catch(() => undefined);
        await contender.end();
        await blocker.end();
      }

      await sql.unsafe(forward);
      const [finalConstraint] = await sql<Array<{ validated: boolean }>>`
        select convalidated as validated from pg_catalog.pg_constraint
        where conname = 'host_export_outbox_root_session_check'
          and conrelid = 'host_export_outbox'::regclass`;
      expect(finalConstraint?.validated).toBe(true);
    });
  }, 240_000);
});

async function withBlankDatabase(
  label: string,
  callback: (sql: postgres.Sql, databaseUrl: string) => Promise<void>,
): Promise<void> {
  if (!available) return;
  const blank = await acquireBlankTestDatabase(label);
  if (!blank) throw new Error(`[migration-0105] lost real PostgreSQL harness for ${label}`);
  const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
  try {
    await sql.unsafe(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await callback(sql, blank.databaseUrl);
  } finally {
    await sql.end();
    await blank.release();
  }
}

async function applyThrough(sql: postgres.Sql, through: string): Promise<void> {
  await applyRange(sql, null, through);
}

async function applyRange(sql: postgres.Sql, after: string | null, through: string): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => (after === null || file > after) && file <= through);
  for (const file of files) {
    await sql.unsafe(await migrationSql(file));
    await recordMigration(sql, file);
  }
}

async function recordMigration(sql: postgres.Sql, file: string): Promise<void> {
  await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
}

async function migrationSql(file: string): Promise<string> {
  return readFile(join(migrationsDir, file), "utf8");
}

async function enqueueDefinitions(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<Array<{ definition: string }>>`
    select pg_get_functiondef(p.oid) as definition
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'opengeni_private'
      and p.proname in (
        'enqueue_host_session_event_export',
        'enqueue_host_usage_event_export'
      )
    order by p.proname`;
  return rows.map((row) => row.definition);
}

async function seedScope(
  sql: postgres.Sql,
  label: string,
): Promise<{
  accountId: string;
  workspaceId: string;
  rootId: string;
  childId: string;
}> {
  const [account] = await sql<Array<{ id: string }>>`
    insert into managed_accounts (name) values (${`migration-0105-${label}-account`}) returning id`;
  const [workspace] = await sql<Array<{ id: string }>>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`migration-0105-${label}-workspace`}) returning id`;
  const rootId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  await sql`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id
    ) values (
      ${rootId}, ${account!.id}, ${workspace!.id}, 'root',
      'scripted-model', 'none', ${rootId}
    )`;
  await sql`
    insert into sessions (
      id, account_id, workspace_id, initial_message, model,
      sandbox_backend, sandbox_group_id, parent_session_id
    ) values (
      ${childId}, ${account!.id}, ${workspace!.id}, 'child',
      'scripted-model', 'none', ${childId}, ${rootId}
    )`;
  return { accountId: account!.id, workspaceId: workspace!.id, rootId, childId };
}

async function insertOutbox(
  sql: postgres.Sql,
  input: {
    accountId: string;
    workspaceId: string;
    sourceId: string;
    sessionId: string | null;
    key: string;
  },
): Promise<void> {
  await sql`
    insert into host_export_outbox (
      export_kind, source_id, account_id, workspace_id, session_id,
      event_type, idempotency_key, payload, envelope_bytes,
      occurred_at, source_recorded_at, enqueued_at
    ) values (
      'session_event', ${input.sourceId}, ${input.accountId}, ${input.workspaceId},
      ${input.sessionId}, 'test.event', ${input.key}, '{}'::jsonb, 128,
      now(), now(), clock_timestamp()
    )`;
}
