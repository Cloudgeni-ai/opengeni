import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  migrate,
  parseBatchedBackfillMigration,
  parseConcurrentIndexMigration,
} from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const fenceMigration = "0404_new_session_draft_project_provenance.sql";
const indexMigration = "0405_new_session_draft_project_provenance_index.sql";
const backfillMigration = "0406_new_session_draft_project_provenance_backfill.sql";
const validationMigration = "0407_new_session_draft_project_provenance_validation.sql";
const capabilityGuc = "opengeni.new_session_draft_project_provenance_backfill_v1";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(900_000);

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function migrationSource(file: string): Promise<string> {
  return await readFile(join(migrationsDir, file), "utf8");
}

async function applyBelow(url: string, lowerBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file >= lowerBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${lowerBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

async function applyThrough(url: string, upperBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file > upperBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    for (const file of deferred) {
      await ledger`delete from schema_migrations where name = ${file}`;
    }
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

function appUrl(database: OwnerMigratedTestDatabase): string {
  const value = new URL(database.adminUrl);
  value.username = "opengeni_app";
  value.password = database.appPassword;
  return value.toString();
}

async function asAppScope<T>(
  sql: postgres.Sql,
  input: { accountId: string; workspaceId: string; subjectId: string },
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (transaction) => {
    await transaction`select
      pg_catalog.set_config('opengeni.account_id', ${input.accountId}, true),
      pg_catalog.set_config('opengeni.workspace_id', ${input.workspaceId}, true),
      pg_catalog.set_config('opengeni.subject_id', ${input.subjectId}, true)`;
    return await operation(transaction);
  })) as T;
}

async function waitForBlockedFinalBackfillBatch(
  admin: postgres.Sql,
  holderPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastState: { remaining: number; blocked: boolean } | null = null;
  while (Date.now() < deadline) {
    const [state] = await admin<Array<{ remaining: number; blocked: boolean }>>`
      select
        count(*) filter (
          where session_options ? 'selectedProjectChannelId'
        )::integer as remaining,
        exists (
          select 1
          from pg_catalog.pg_stat_activity activity
          where activity.datname = current_database()
            and ${holderPid} = any(pg_catalog.pg_blocking_pids(activity.pid))
        ) as blocked
      from new_session_drafts`;
    lastState = state ?? null;
    if (state?.remaining === 1 && state.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error(
    `timed out waiting for committed first backfill batch and blocked final candidate: ${JSON.stringify(lastState)}`,
  );
}

describe("phased new-session draft project provenance migration", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0404-draft-project-provenance");
    if (!owned && requireRealDatabase) {
      throw new Error("real database required but unavailable");
    }
  }, 900_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("declares four bounded rolling phases with matching runner contracts", async () => {
    const [fence, index, backfill, validation, migrationRunner] = await Promise.all([
      migrationSource(fenceMigration),
      migrationSource(indexMigration),
      migrationSource(backfillMigration),
      migrationSource(validationMigration),
      readFile(new URL("../src/migrate.ts", import.meta.url), "utf8"),
    ]);

    expect(fence.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(fence).toContain('ADD COLUMN IF NOT EXISTS "selected_project_channel_id" uuid');
    expect(fence).toContain("NOT VALID");
    expect(fence).toContain("new_session_drafts_project_provenance_backfill_v1");
    expect(fence).toContain("current_user = (");
    expect(fence).toContain("pg_catalog.pg_get_userbyid(relation.relowner)");
    expect(fence).toContain(`'${capabilityGuc}'`);
    expect(fence).toContain('BEFORE INSERT OR UPDATE ON "new_session_drafts"');
    expect(fence).toContain('NEW."selected_project_channel_id" := CASE');
    expect(fence).toContain('NEW."selected_project_compute_snapshot" := CASE');
    expect(fence).toContain(
      'NEW."session_options" := NEW."session_options" - \'selectedProjectChannelId\'',
    );
    expect(fence).toContain("IF NEW.\"session_options\" ? 'selectedProjectChannelId' THEN");
    expect(fence).toContain("ELSIF TG_OP = 'UPDATE' THEN");
    expect(fence).toContain("old_compute_snapshot IS DISTINCT FROM new_compute_snapshot");
    expect(fence).toMatch(
      /NEW\."selected_project_compute_snapshot"\s+IS NOT DISTINCT FROM new_compute_snapshot/u,
    );
    expect(fence).toContain('NEW."selected_project_channel_id" := NULL');
    expect(fence).toContain('NEW."selected_project_compute_snapshot" := NULL');
    expect(fence).not.toMatch(/^\s*UPDATE\s+"?new_session_drafts"?/imu);
    expect(fence).not.toContain("VALIDATE CONSTRAINT");
    expect(fence).not.toContain("NO FORCE ROW LEVEL SECURITY");

    expect(parseConcurrentIndexMigration(indexMigration, index)).toMatchObject({
      indexName: "new_session_drafts_project_provenance_backfill_v1_idx",
      lockTimeout: "5s",
      skipWhenValid: false,
    });
    expect(index).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(index).toContain("ON new_session_drafts (id)");
    expect(index).toContain("WHERE session_options ? 'selectedProjectChannelId'");

    const parsedBackfill = parseBatchedBackfillMigration(backfillMigration, backfill);
    expect(parsedBackfill).toMatchObject({
      batchSize: 500,
      lockTimeout: "1s",
      statementTimeout: "10s",
    });
    expect(parsedBackfill?.statement).not.toContain("backfill_capability AS MATERIALIZED");
    expect(parsedBackfill?.statement).not.toContain("set_config");
    expect(migrationRunner).toContain(
      "const transactionLocalSetting = batchedBackfillTransactionLocalSetting(file)",
    );
    expect(migrationRunner).toContain("${transactionLocalSetting.guc}");
    expect(parsedBackfill?.statement).toContain("ORDER BY draft.id");
    expect(parsedBackfill?.statement).toContain("LIMIT 500");
    expect(parsedBackfill?.statement).toContain("FOR UPDATE OF draft");
    expect(parsedBackfill?.statement).toContain("RETURNING draft.id");
    expect(parsedBackfill?.statement).not.toContain("SKIP LOCKED");
    expect(parsedBackfill?.statement).not.toContain("ALTER TABLE");
    expect(parsedBackfill?.statement).not.toMatch(/\bLOCK\s+TABLE\b/iu);

    expect(validation).toContain(`'${capabilityGuc}'`);
    expect(validation).toContain("IF EXISTS (");
    expect(validation).toContain("WHERE draft.session_options ? 'selectedProjectChannelId'");
    expect(validation).toContain("LIMIT 1");
    expect(validation).toContain("VALIDATE CONSTRAINT");
    expect(validation).not.toContain("NO FORCE ROW LEVEL SECURITY");
  });

  test("fences mixed writers, resumes locked batches, and validates under the real owner posture", async () => {
    if (!owned) return;
    const { admin, ownerRole, ownerUrl } = owned;
    await applyBelow(ownerUrl, fenceMigration);

    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const validProjectId = "11111111-1111-4111-8111-111111111111";
    const lockedDraftId = "00000000-0000-4000-8000-0000000001f5";
    const mixedWriterDraftId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const mixedWriterSubject = "subject:0404-mixed-writer";
    const newWriterInsertDraftId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const newWriterInsertSubject = "subject:0404-new-writer-insert";
    await admin.begin(async (transaction) => {
      await transaction`
        insert into managed_accounts (id, name)
        values (${accountId}, '0404 phased migration account')`;
      await transaction`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, '0404 phased migration workspace')`;
      await transaction.unsafe(
        `insert into new_session_drafts (
          id, account_id, workspace_id, subject_id, revision, text, resources,
          tools, model, reasoning_effort, latency_mode, session_options
        )
        select
          ('00000000-0000-4000-8000-' || lpad(to_hex(series), 12, '0'))::uuid,
          '${accountId}'::uuid,
          '${workspaceId}'::uuid,
          'subject:0404-legacy-' || series::text,
          1,
          '',
          '[]'::jsonb,
          '[]'::jsonb,
          'scripted-model',
          'low',
          'standard',
          jsonb_build_object(
            'sandboxBackend', 'selfhosted',
            'targetSandboxId', '22222222-2222-4222-8222-222222222222',
            'workingDir', '/workspace/project-a',
            'selectedProjectChannelId',
            case
              when series = 2 then null
              when series = 3 then 'malformed-project-id'
              else '${validProjectId}'
            end
          )
        from generate_series(1, 501) series`,
      );
    });

    await applyThrough(ownerUrl, fenceMigration);

    const [afterFence] = await admin<
      Array<{ legacyRows: number; validated: boolean; forced: boolean }>
    >`
      select
        (select count(*)::integer from new_session_drafts
          where session_options ? 'selectedProjectChannelId') as "legacyRows",
        constraint_row.convalidated as validated,
        table_row.relforcerowsecurity as forced
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
      where constraint_row.conname = 'new_session_drafts_project_provenance_check'
        and table_row.oid = 'new_session_drafts'::regclass`;
    expect(afterFence).toEqual({ legacyRows: 501, validated: false, forced: true });

    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_catalog.pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
    const app = postgres(appUrl(owned), { max: 2, prepare: false, onnotice: () => undefined });
    let holder: postgres.Sql | null = null;
    let heldPromise: Promise<unknown> | null = null;
    let holderPid: number | null = null;
    const heldLock: { release?: () => void } = {};
    try {
      const [ownerWithoutCapability] = await owner<Array<{ rows: number }>>`
        select count(*)::integer as rows from new_session_drafts`;
      expect(ownerWithoutCapability?.rows).toBe(0);
      const [ownerWithCapability] = await owner.begin(async (transaction) => {
        await transaction`select pg_catalog.set_config(${capabilityGuc}, '1', true)`;
        return await transaction<Array<{ rows: number }>>`
          select count(*)::integer as rows from new_session_drafts`;
      });
      expect(ownerWithCapability?.rows).toBe(501);
      const [appWithForgedCapability] = await app.begin(async (transaction) => {
        await transaction`select pg_catalog.set_config(${capabilityGuc}, '1', true)`;
        return await transaction<Array<{ rows: number }>>`
          select count(*)::integer as rows from new_session_drafts`;
      });
      expect(appWithForgedCapability?.rows).toBe(0);

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            insert into new_session_drafts (
              id, account_id, workspace_id, subject_id, revision, text, resources,
              tools, model, reasoning_effort, latency_mode, session_options
            ) values (
              ${mixedWriterDraftId}, ${accountId}, ${workspaceId}, ${mixedWriterSubject},
              1, '', '[]'::jsonb, '[]'::jsonb, 'scripted-model', 'low', 'standard',
              '{}'::jsonb
            )`;
          await transaction`
            update new_session_drafts
            set session_options = ${transaction.json({
              sandboxBackend: "selfhosted",
              targetSandboxId: "33333333-3333-4333-8333-333333333333",
              workingDir: "/workspace/mixed-writer",
              selectedProjectChannelId: validProjectId,
            })}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterOldWriter] = await admin<
        Array<{
          projectId: string | null;
          snapshot: Record<string, unknown> | null;
          options: Record<string, unknown>;
        }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot,
          session_options as options
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterOldWriter).toEqual({
        projectId: validProjectId,
        snapshot: {
          sandboxBackend: "selfhosted",
          targetSandboxId: "33333333-3333-4333-8333-333333333333",
          workingDir: "/workspace/mixed-writer",
        },
        options: {
          sandboxBackend: "selfhosted",
          targetSandboxId: "33333333-3333-4333-8333-333333333333",
          workingDir: "/workspace/mixed-writer",
        },
      });

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set text = 'unrelated legacy edit'
            where id = ${mixedWriterDraftId}`;
          await transaction`
            update new_session_drafts
            set session_options = session_options
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterUnrelatedAndNoop] = await admin<
        Array<{ projectId: string | null; snapshot: Record<string, unknown> | null }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterUnrelatedAndNoop).toEqual({
        projectId: validProjectId,
        snapshot: {
          sandboxBackend: "selfhosted",
          targetSandboxId: "33333333-3333-4333-8333-333333333333",
          workingDir: "/workspace/mixed-writer",
        },
      });

      const legacyComputeB = {
        sandboxBackend: "selfhosted",
        targetSandboxId: "55555555-5555-4555-8555-555555555555",
        workingDir: "/workspace/legacy-b",
      };
      const legacyComputeA = {
        sandboxBackend: "selfhosted",
        targetSandboxId: "33333333-3333-4333-8333-333333333333",
        workingDir: "/workspace/mixed-writer",
      };
      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set session_options = ${transaction.json(legacyComputeB)}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterLegacyDeparture] = await admin<
        Array<{ projectId: string | null; snapshot: Record<string, unknown> | null }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterLegacyDeparture).toEqual({ projectId: null, snapshot: null });

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set session_options = ${transaction.json(legacyComputeA)}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterLegacyAba] = await admin<
        Array<{ projectId: string | null; snapshot: Record<string, unknown> | null }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterLegacyAba).toEqual({ projectId: null, snapshot: null });

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set session_options = ${transaction.json({
              ...legacyComputeA,
              selectedProjectChannelId: null,
            })}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterMarkerDefault] = await admin<
        Array<{ projectId: string | null; snapshot: Record<string, unknown> | null }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterMarkerDefault).toEqual({ projectId: null, snapshot: legacyComputeA });

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set session_options = ${transaction.json({
              ...legacyComputeA,
              selectedProjectChannelId: "malformed-project-id",
            })}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterMalformedMarker] = await admin<
        Array<{ projectId: string | null; snapshot: Record<string, unknown> | null }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterMalformedMarker).toEqual({ projectId: null, snapshot: null });

      const explicitProjectId = "44444444-4444-4444-8444-444444444444";
      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          await transaction`
            update new_session_drafts
            set
              selected_project_channel_id = ${explicitProjectId},
              selected_project_compute_snapshot = ${transaction.json({ sandboxBackend: "none" })},
              session_options = ${transaction.json({ sandboxBackend: "none" })}
            where id = ${mixedWriterDraftId}`;
        },
      );
      const [afterNewWriter] = await admin<
        Array<{
          projectId: string | null;
          snapshot: Record<string, unknown> | null;
          options: Record<string, unknown>;
        }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot,
          session_options as options
        from new_session_drafts where id = ${mixedWriterDraftId}`;
      expect(afterNewWriter).toEqual({
        projectId: explicitProjectId,
        snapshot: { sandboxBackend: "none" },
        options: { sandboxBackend: "none" },
      });

      await asAppScope(
        app,
        { accountId, workspaceId, subjectId: newWriterInsertSubject },
        async (transaction) => {
          await transaction`
            insert into new_session_drafts (
              id, account_id, workspace_id, subject_id, revision, text, resources,
              tools, model, reasoning_effort, latency_mode, session_options,
              selected_project_channel_id, selected_project_compute_snapshot
            ) values (
              ${newWriterInsertDraftId}, ${accountId}, ${workspaceId}, ${newWriterInsertSubject},
              1, '', '[]'::jsonb, '[]'::jsonb, 'scripted-model', 'low', 'standard',
              ${transaction.json({ sandboxBackend: "none" })},
              ${explicitProjectId},
              ${transaction.json({ sandboxBackend: "none" })}
            )`;
        },
      );
      const [afterNewWriterInsert] = await admin<
        Array<{
          projectId: string | null;
          snapshot: Record<string, unknown> | null;
          options: Record<string, unknown>;
        }>
      >`
        select
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot,
          session_options as options
        from new_session_drafts where id = ${newWriterInsertDraftId}`;
      expect(afterNewWriterInsert).toEqual({
        projectId: explicitProjectId,
        snapshot: { sandboxBackend: "none" },
        options: { sandboxBackend: "none" },
      });

      await applyThrough(ownerUrl, indexMigration);
      const [index] = await admin<
        Array<{ valid: boolean; ready: boolean; predicate: string | null }>
      >`
        select
          candidate.indisvalid as valid,
          candidate.indisready as ready,
          pg_catalog.pg_get_expr(candidate.indpred, candidate.indrelid) as predicate
        from pg_catalog.pg_index candidate
        join pg_catalog.pg_class relation on relation.oid = candidate.indexrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = current_schema()
          and relation.relname = 'new_session_drafts_project_provenance_backfill_v1_idx'
      `;
      expect(index).toMatchObject({ valid: true, ready: true });
      expect(index?.predicate).toContain("session_options ? 'selectedProjectChannelId'::text");

      const [lastCandidate] = await admin<Array<{ id: string }>>`
        select id
        from new_session_drafts
        where session_options ? 'selectedProjectChannelId'
        order by id desc
        limit 1`;
      if (!lastCandidate) throw new Error("expected a final legacy backfill candidate");
      expect(lastCandidate.id).toBe(lockedDraftId);

      holder = postgres(owned.adminUrl, {
        max: 1,
        prepare: false,
        onnotice: () => undefined,
      });
      let locked!: () => void;
      let releaseLock!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
        heldLock.release = resolve;
      });
      heldPromise = holder.begin(async (transaction) => {
        const [backend] = await transaction<Array<{ pid: number }>>`
          select pg_catalog.pg_backend_pid() as pid`;
        holderPid = backend?.pid ?? null;
        await transaction`select id from new_session_drafts where id = ${lockedDraftId} for update`;
        locked();
        await release;
      });
      await lockReady;

      const migrationRun = migrate(ownerUrl).then(
        () => null,
        (error: unknown) => error,
      );
      if (!holderPid) throw new Error("lock holder backend pid was not captured");
      await waitForBlockedFinalBackfillBatch(admin, holderPid);

      const duringBlockedBatch = await asAppScope(
        app,
        { accountId, workspaceId, subjectId: mixedWriterSubject },
        async (transaction) => {
          const [updated] = await transaction<Array<{ text: string }>>`
            update new_session_drafts
            set text = 'application write during blocked backfill'
            where id = ${mixedWriterDraftId}
            returning text`;
          const [read] = await transaction<Array<{ text: string }>>`
            select text from new_session_drafts where id = ${mixedWriterDraftId}`;
          return { updated: updated?.text, read: read?.text };
        },
      );
      expect(duringBlockedBatch).toEqual({
        updated: "application write during blocked backfill",
        read: "application write during blocked backfill",
      });
      expect(await migrationRun).toMatchObject({ code: "55P03" });

      const [partialState] = await admin<
        Array<{
          convertedLegacy: number;
          remainingLegacy: number;
          markerlessWriterRows: number;
          backfillLedgered: boolean;
        }>
      >`
        select
          count(*) filter (
            where not (session_options ? 'selectedProjectChannelId')
              and subject_id like 'subject:0404-legacy-%'
          )::integer as "convertedLegacy",
          count(*) filter (
            where session_options ? 'selectedProjectChannelId'
              and subject_id like 'subject:0404-legacy-%'
          )::integer as "remainingLegacy",
          count(*) filter (
            where not (session_options ? 'selectedProjectChannelId')
              and id in (${mixedWriterDraftId}::uuid, ${newWriterInsertDraftId}::uuid)
          )::integer as "markerlessWriterRows",
          exists (
            select 1 from schema_migrations where name = ${backfillMigration}
          ) as "backfillLedgered"
        from new_session_drafts`;
      expect(partialState).toEqual({
        convertedLegacy: 500,
        remainingLegacy: 1,
        markerlessWriterRows: 2,
        backfillLedgered: false,
      });

      const edgeRows = await admin<
        Array<{
          id: string;
          projectId: string | null;
          snapshot: Record<string, unknown> | null;
          hasLegacyKey: boolean;
        }>
      >`
        select
          id,
          selected_project_channel_id as "projectId",
          selected_project_compute_snapshot as snapshot,
          session_options ? 'selectedProjectChannelId' as "hasLegacyKey"
        from new_session_drafts
        where id = any(array[
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-000000000003'::uuid
        ])
        order by id`;
      expect([...edgeRows]).toEqual([
        {
          id: "00000000-0000-4000-8000-000000000001",
          projectId: validProjectId,
          snapshot: {
            sandboxBackend: "selfhosted",
            targetSandboxId: "22222222-2222-4222-8222-222222222222",
            workingDir: "/workspace/project-a",
          },
          hasLegacyKey: false,
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          projectId: null,
          snapshot: {
            sandboxBackend: "selfhosted",
            targetSandboxId: "22222222-2222-4222-8222-222222222222",
            workingDir: "/workspace/project-a",
          },
          hasLegacyKey: false,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          projectId: null,
          snapshot: null,
          hasLegacyKey: false,
        },
      ]);

      releaseLock();
      await heldPromise;
      await holder.end({ timeout: 5 });
      holder = null;
      heldPromise = null;

      await migrate(ownerUrl);
      const [finalState] = await admin<
        Array<{
          legacyRows: number;
          validated: boolean;
          forced: boolean;
          backfillLedgered: boolean;
          validationLedgered: boolean;
        }>
      >`
        select
          (select count(*)::integer from new_session_drafts
            where session_options ? 'selectedProjectChannelId') as "legacyRows",
          constraint_row.convalidated as validated,
          table_row.relforcerowsecurity as forced,
          exists (
            select 1 from schema_migrations where name = ${backfillMigration}
          ) as "backfillLedgered",
          exists (
            select 1 from schema_migrations where name = ${validationMigration}
          ) as "validationLedgered"
        from pg_catalog.pg_constraint constraint_row
        join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
        where constraint_row.conname = 'new_session_drafts_project_provenance_check'
          and table_row.oid = 'new_session_drafts'::regclass`;
      expect(finalState).toEqual({
        legacyRows: 0,
        validated: true,
        forced: true,
        backfillLedgered: true,
        validationLedgered: true,
      });
    } finally {
      heldLock.release?.();
      await heldPromise?.catch(() => undefined);
      await Promise.all([
        holder?.end({ timeout: 5 }).catch(() => undefined),
        owner.end({ timeout: 5 }).catch(() => undefined),
        app.end({ timeout: 5 }).catch(() => undefined),
      ]);
    }
  }, 900_000);
});
