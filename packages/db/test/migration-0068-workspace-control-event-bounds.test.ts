import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WORKSPACE_CONTROL_ACTOR_MAX_BYTES,
  WORKSPACE_CONTROL_REASON_MAX_BYTES,
  sessionEventJsonBytes,
} from "@opengeni/contracts";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  listWorkspaceControlEvents,
  migrate,
  mutateWorkspaceControlInTransaction,
  withWorkspaceRls,
} from "../src";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0068_workspace_control_event_bounds.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const encoder = new TextEncoder();
const boundedHistoricalRowCount = 25_000;

let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

beforeAll(async () => {
  const explicitDatabaseUrl = process.env.OPENGENI_MIGRATION_0068_TEST_DATABASE_URL;
  blank = explicitDatabaseUrl
    ? { databaseUrl: explicitDatabaseUrl, release: async () => {} }
    : await acquireBlankTestDatabase("migration-0068-control-bounds");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0068] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0068 workspace-control event bounds (real PostgreSQL)", () => {
  test("rewrites only poison rows at production-shaped cardinality and guards every writer", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const prior = files.filter((file) => file.localeCompare(migrationName) < 0);
      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of prior) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0068-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0068-workspace') returning id`;
      const historicalReason = `HEAD-${"🙂".repeat(600_000)}-TAIL`;
      const historicalActor = `historical-${"界".repeat(300_000)}`;

      await admin`
        insert into workspace_control_events (
          account_id, workspace_id, revision, scope, action, automatic, reason, actor
        ) values (
          ${account!.id}, ${workspace!.id}, 1, 'workspace', 'pause', false,
          ${historicalReason}, ${historicalActor}
        )`;

      await admin`
        insert into workspace_control_events (
          account_id, workspace_id, revision, scope, action, automatic, reason, actor
        )
        select ${account!.id}, ${workspace!.id}, generated.revision,
          'workspace', 'resume', false,
          'bounded-reason-' || generated.revision,
          'bounded-actor-' || generated.revision
        from generate_series(
          100,
          ${99 + boundedHistoricalRowCount}
        ) as generated(revision)`;
      await admin`
        create temp table migration_0068_bounded_before on commit preserve rows as
        select id, xmin::text as row_xmin
        from workspace_control_events
        where workspace_id = ${workspace!.id} and revision >= 100`;
      const [walBefore] = await admin<Array<{ lsn: string }>>`
        select pg_current_wal_insert_lsn()::text as lsn`;
      const migrationStartedAt = performance.now();
      await applyFile(admin, migrationName);
      const migrationMilliseconds = Math.ceil(performance.now() - migrationStartedAt);

      const [boundedEvidence] = await admin<
        Array<{
          total: number;
          nullMetadata: number;
          unchangedXmin: number;
          maxReasonBytes: number;
          maxActorBytes: number;
        }>
      >`
        select count(*)::integer as total,
          count(*) filter (
            where event.reason_original_bytes is null
              and event.actor_original_bytes is null
          )::integer as "nullMetadata",
          count(*) filter (where event.xmin::text = before.row_xmin)::integer as "unchangedXmin",
          max(octet_length(event.reason))::integer as "maxReasonBytes",
          max(octet_length(event.actor))::integer as "maxActorBytes"
        from workspace_control_events event
        join migration_0068_bounded_before before using (id)`;
      const [walEvidence] = await admin<Array<{ bytes: string }>>`
        select pg_wal_lsn_diff(
          pg_current_wal_insert_lsn(),
          ${walBefore!.lsn}::text::pg_lsn
        )::text as bytes`;
      expect(boundedEvidence).toEqual({
        total: boundedHistoricalRowCount,
        nullMetadata: boundedHistoricalRowCount,
        unchangedXmin: boundedHistoricalRowCount,
        maxReasonBytes: 20,
        maxActorBytes: 19,
      });
      expect(BigInt(walEvidence!.bytes)).toBeGreaterThan(0n);
      console.info(
        `[migration-0068] rows=${boundedHistoricalRowCount} unchanged_xmin=${boundedEvidence!.unchangedXmin} poison_rows=1 runtime_ms=${migrationMilliseconds} wal_bytes=${walEvidence!.bytes}`,
      );

      const [historical] = await admin<
        Array<{
          reason: string;
          actor: string;
          reasonBytes: number;
          actorBytes: number;
          reasonOriginalBytes: number;
          actorOriginalBytes: number;
        }>
      >`
        select reason, actor,
          octet_length(reason)::integer as "reasonBytes",
          octet_length(actor)::integer as "actorBytes",
          reason_original_bytes as "reasonOriginalBytes",
          actor_original_bytes as "actorOriginalBytes"
        from workspace_control_events
        where workspace_id = ${workspace!.id} and revision = 1`;
      expect(historical).toMatchObject({
        reasonOriginalBytes: encoder.encode(historicalReason).byteLength,
        actorOriginalBytes: encoder.encode(historicalActor).byteLength,
      });
      expect(historical?.reasonBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_REASON_MAX_BYTES);
      expect(historical?.actorBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_ACTOR_MAX_BYTES);
      expect(historical?.reason).toStartWith("HEAD-");
      expect(historical?.reason).toEndWith("…[truncated]");
      expect(historical?.actor).toStartWith("historical-");
      expect(historical?.actor).toEndWith("…[truncated]");

      const oldInsertReason = `insert-${"界".repeat(500_000)}`;
      const oldInsertActor = `insert-actor-${"🙂".repeat(200_000)}`;
      const [inserted] = await admin<
        Array<{
          reasonBytes: number;
          actorBytes: number;
          reasonOriginalBytes: number;
          actorOriginalBytes: number;
        }>
      >`
        insert into workspace_control_events (
          account_id, workspace_id, revision, scope, action, automatic, reason, actor
        ) values (
          ${account!.id}, ${workspace!.id}, 2, 'workspace', 'resume', false,
          ${oldInsertReason}, ${oldInsertActor}
        ) returning
          octet_length(reason)::integer as "reasonBytes",
          octet_length(actor)::integer as "actorBytes",
          reason_original_bytes as "reasonOriginalBytes",
          actor_original_bytes as "actorOriginalBytes"`;
      expect(inserted).toMatchObject({
        reasonOriginalBytes: encoder.encode(oldInsertReason).byteLength,
        actorOriginalBytes: encoder.encode(oldInsertActor).byteLength,
      });
      expect(inserted?.reasonBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_REASON_MAX_BYTES);
      expect(inserted?.actorBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_ACTOR_MAX_BYTES);

      const updateReason = `update-${"🙂".repeat(400_000)}`;
      const updateActor = `update-actor-${"界".repeat(400_000)}`;
      const [updated] = await admin<
        Array<{ reasonOriginalBytes: number; actorOriginalBytes: number }>
      >`
        update workspace_control_events
        set reason = ${updateReason}, actor = ${updateActor}
        where workspace_id = ${workspace!.id} and revision = 2
        returning reason_original_bytes as "reasonOriginalBytes",
          actor_original_bytes as "actorOriginalBytes"`;
      expect(updated).toEqual({
        reasonOriginalBytes: encoder.encode(updateReason).byteLength,
        actorOriginalBytes: encoder.encode(updateActor).byteLength,
      });

      await admin`
        update workspace_control_events
        set reason = 'short replacement', actor = 'short actor'
        where workspace_id = ${workspace!.id} and revision = 2`;
      const [shortReplacement] = await admin<
        Array<{ reasonOriginalBytes: number; actorOriginalBytes: number }>
      >`
        select reason_original_bytes as "reasonOriginalBytes",
          actor_original_bytes as "actorOriginalBytes"
        from workspace_control_events
        where workspace_id = ${workspace!.id} and revision = 2`;
      expect(shortReplacement).toEqual({
        reasonOriginalBytes: encoder.encode("short replacement").byteLength,
        actorOriginalBytes: encoder.encode("short actor").byteLength,
      });

      const constraints = await admin<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conrelid = 'workspace_control_events'::regclass
          and conname in (
            'workspace_control_events_reason_bytes_check',
            'workspace_control_events_actor_bytes_check',
            'workspace_control_events_original_bytes_check',
            'workspace_control_events_actor_original_bytes_check'
          )`;
      expect(constraints).toHaveLength(4);
      expect(constraints.every((constraint) => constraint.validated)).toBeTrue();

      const projectionClient = createDb(blank.databaseUrl, { max: 1 });
      try {
        const projected = await listWorkspaceControlEvents(
          projectionClient.db,
          workspace!.id,
          0,
          10,
        );
        expect(projected).toHaveLength(10);
        const projectedPoison = projected.find((event) => event.sequence === 1);
        const projectedReplacement = projected.find((event) => event.sequence === 2);
        const projectedBoundedLegacy = projected.find((event) => event.sequence === 100);
        expect(projectedPoison?.truncation).toMatchObject({
          truncated: true,
          surface: "durable_control",
          deliveredBytes: sessionEventJsonBytes(projectedPoison),
          fullEvidence: { available: false, reason: "not_retained" },
        });
        expect(projectedPoison?.truncation?.fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: "reason" }),
            expect.objectContaining({ field: "actor" }),
          ]),
        );
        expect(projectedReplacement?.truncation).toBeUndefined();
        expect(projectedBoundedLegacy?.truncation).toBeUndefined();
      } finally {
        await projectionClient.close();
      }

      // Prove the validated byte constraints independently from the trigger.
      await admin.unsafe(
        "alter table workspace_control_events disable trigger workspace_control_events_bound_fields",
      );
      let constraintError: unknown;
      try {
        await admin`
          insert into workspace_control_events (
            account_id, workspace_id, revision, scope, action, reason, actor,
            reason_original_bytes, actor_original_bytes
          ) values (
            ${account!.id}, ${workspace!.id}, 3, 'workspace', 'pause',
            ${"x".repeat(WORKSPACE_CONTROL_REASON_MAX_BYTES + 1)}, 'actor',
            ${WORKSPACE_CONTROL_REASON_MAX_BYTES + 1}, 5
          )`;
      } catch (error) {
        constraintError = error;
      } finally {
        await admin.unsafe(
          "alter table workspace_control_events enable trigger workspace_control_events_bound_fields",
        );
      }
      expect((constraintError as { code?: string } | undefined)?.code).toBe("23514");

      // Continue from the staged production-shaped database through the exact
      // latest migration chain, then exercise the actual application insert
      // path. The application supplies pre-bound values plus larger source-byte
      // facts; the trigger must not collapse those facts to delivered lengths.
      await admin`
        insert into schema_migrations (name) values (${migrationName}) on conflict do nothing`;
      await migrate(blank.databaseUrl);
      const latestClient = createDb(blank.databaseUrl, { max: 1 });
      try {
        const suffix = crypto.randomUUID();
        const access = await bootstrapWorkspace(latestClient.db, {
          accountExternalSource: "migration-test",
          accountExternalId: `migration-0068-account-${suffix}`,
          accountName: "Migration 0068 latest-chain account",
          workspaceExternalSource: "migration-test",
          workspaceExternalId: `migration-0068-workspace-${suffix}`,
          workspaceName: "Migration 0068 latest-chain workspace",
          subjectId: `migration-0068-subject-${suffix}`,
        });
        const grant = access.workspaceGrants[0]!;
        const applicationReason = `application-${"🙂".repeat(3_000)}`;
        const applicationActor = `subject-${"界".repeat(400)}`;
        const mutation = await withWorkspaceRls(latestClient.db, grant.workspaceId!, (scopedDb) =>
          mutateWorkspaceControlInTransaction(scopedDb, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            actor: { type: "human", subjectId: applicationActor },
            operationKey: crypto.randomUUID(),
            action: "pause",
            reason: applicationReason,
          }),
        );
        const [applicationRow] = await admin<
          Array<{
            reasonBytes: number;
            actorBytes: number;
            reasonOriginalBytes: number;
            actorOriginalBytes: number;
          }>
        >`
          select octet_length(reason)::integer as "reasonBytes",
            octet_length(actor)::integer as "actorBytes",
            reason_original_bytes as "reasonOriginalBytes",
            actor_original_bytes as "actorOriginalBytes"
          from workspace_control_events
          where id = ${mutation.workspaceControlEventId}`;
        expect(applicationRow).toMatchObject({
          reasonOriginalBytes: encoder.encode(applicationReason).byteLength,
          actorOriginalBytes: encoder.encode(applicationActor).byteLength,
        });
        expect(applicationRow?.reasonBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_REASON_MAX_BYTES);
        expect(applicationRow?.actorBytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_ACTOR_MAX_BYTES);
        const [applicationProjection] = await listWorkspaceControlEvents(
          latestClient.db,
          grant.workspaceId!,
          0,
          10,
        );
        expect(applicationProjection?.truncation?.fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: "reason",
              originalBytes: encoder.encode(applicationReason).byteLength,
            }),
            expect.objectContaining({
              field: "actor",
              originalBytes: encoder.encode(applicationActor).byteLength,
            }),
          ]),
        );
      } finally {
        await latestClient.close();
      }
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
