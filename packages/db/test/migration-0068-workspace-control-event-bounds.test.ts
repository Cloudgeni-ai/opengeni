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
import { createDb, listWorkspaceControlEvents } from "../src";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0068_workspace_control_event_bounds.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const encoder = new TextEncoder();

let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

beforeAll(async () => {
  const explicitDatabaseUrl = process.env.OPENGENI_MIGRATION_0066_TEST_DATABASE_URL;
  blank = explicitDatabaseUrl
    ? { databaseUrl: explicitDatabaseUrl, release: async () => {} }
    : await acquireBlankTestDatabase("migration-0066-control-bounds");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0066] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0066 workspace-control event bounds (real PostgreSQL)", () => {
  test("backfills poison rows and guards old-binary inserts/updates with exact UTF-8 truth", async () => {
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
        insert into managed_accounts (name) values ('migration-0066-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0066-workspace') returning id`;
      const historicalReason = `HEAD-${"🙂".repeat(600_000)}-TAIL`;
      const historicalActor = `historical-${"界".repeat(300_000)}`;

      await admin`
        insert into workspace_control_events (
          account_id, workspace_id, revision, scope, action, automatic, reason, actor
        ) values (
          ${account!.id}, ${workspace!.id}, 1, 'workspace', 'pause', false,
          ${historicalReason}, ${historicalActor}
        )`;

      await applyFile(admin, migrationName);

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
        expect(projected).toHaveLength(2);
        expect(projected[0]?.truncation).toMatchObject({
          truncated: true,
          surface: "durable_control",
          deliveredBytes: sessionEventJsonBytes(projected[0]),
          fullEvidence: { available: false, reason: "not_retained" },
        });
        expect(projected[0]?.truncation?.fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: "reason" }),
            expect.objectContaining({ field: "actor" }),
          ]),
        );
        expect(projected[1]?.truncation).toBeUndefined();
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
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
