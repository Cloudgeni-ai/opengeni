import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const payloadBoundsMigration = "0067_session_event_payload_bounds.sql";
const controlBoundsMigration = "0068_workspace_control_event_bounds.sql";
const backfillMigration = "0069_session_event_history_backfill.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

beforeAll(async () => {
  const explicitDatabaseUrl = process.env.OPENGENI_MIGRATION_0067_TEST_DATABASE_URL;
  blank = explicitDatabaseUrl
    ? { databaseUrl: explicitDatabaseUrl, release: async () => {} }
    : await acquireBlankTestDatabase("migration-0067-event-history-backfill");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0067] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0067 session-event history backfill (real PostgreSQL)", () => {
  test("rewrites legacy violations and validates every durable event envelope bound", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const prior = files.filter((file) => file.localeCompare(payloadBoundsMigration) < 0);
      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of prior) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0067-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0067-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'migration fixture',
          'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;

      const payload = {
        id: "legacy-payload",
        name: "sessions_list",
        output: `HEAD-${"p".repeat(180_000)}-TAIL`,
      };
      const poisonType = `legacy\r\ntype-${"界".repeat(100_000)}`;
      const poisonClient = "🙂".repeat(1_000);
      const poisonProducer = "界".repeat(1_000);
      const poisonDuplicateReason = "界".repeat(2_000);
      const canonicalId = crypto.randomUUID();

      await admin`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 1,
          'agent.tool_call.completed', ${admin.json(payload)}
        ), (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 2, ${poisonType},
          ${admin.json({ id: "legacy-envelope", output: "small" })}
        )`;
      await admin`
        update session_events
        set client_event_id = ${poisonClient}, producer_id = ${poisonProducer}
        where session_id = ${sessionId} and sequence = 2`;
      await admin`
        insert into session_events (
          id, account_id, workspace_id, session_id, sequence, type, payload, turn_association
        ) values (
          ${canonicalId}, ${account!.id}, ${workspace!.id}, ${sessionId}, 3,
          'agent.model.usage', ${admin.json({ sourceKey: "canonical" })}, 'current'
        )`;
      await admin`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload,
          turn_association, duplicate_of_event_id, duplicate_reason
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 4, 'agent.model.usage',
          ${admin.json({ sourceKey: "duplicate" })}, 'duplicate', ${canonicalId},
          ${poisonDuplicateReason}
        )`;

      await applyFile(admin, payloadBoundsMigration);
      await applyFile(admin, controlBoundsMigration);

      const [before] = await admin<
        Array<{
          payloadBytes: number;
          typeBytes: number;
          clientBytes: number;
          producerBytes: number;
          associationBytes: number;
          reasonBytes: number;
        }>
      >`
        select
          max(octet_length(payload::text))::integer as "payloadBytes",
          max(octet_length(type))::integer as "typeBytes",
          max(octet_length(client_event_id))::integer as "clientBytes",
          max(octet_length(producer_id))::integer as "producerBytes",
          max(octet_length(turn_association))::integer as "associationBytes",
          max(octet_length(duplicate_reason))::integer as "reasonBytes"
        from session_events where session_id = ${sessionId}`;
      expect(before!.payloadBytes).toBeGreaterThan(65_536);
      expect(before!.typeBytes).toBeGreaterThan(256);
      expect(before!.clientBytes).toBeGreaterThan(1_024);
      expect(before!.producerBytes).toBeGreaterThan(1_024);
      // The pre-existing enum check already makes an oversized association
      // physically impossible; 0065's byte check is still unvalidated until
      // this migration closes the expand/contract sequence below.
      expect(before!.associationBytes).toBeLessThanOrEqual(64);
      expect(before!.reasonBytes).toBeGreaterThan(4_096);

      const constraintNames = [
        "session_events_payload_bytes_check",
        "session_events_type_bytes_check",
        "session_events_client_event_id_bytes_check",
        "session_events_producer_id_bytes_check",
        "session_events_turn_association_bytes_check",
        "session_events_duplicate_reason_bytes_check",
      ];
      const unvalidated = await admin<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conrelid = 'session_events'::regclass and conname = any(${constraintNames})`;
      expect(unvalidated).toHaveLength(6);
      expect(unvalidated.every((constraint) => constraint.validated === false)).toBeTrue();

      await applyFile(admin, backfillMigration);

      const [boundedPayload] = await admin<
        Array<{
          payload: {
            preview?: string;
            truncation?: {
              truncated?: boolean;
              surface?: string;
              reason?: string;
              originalBytes?: number;
              deliveredBytes?: number;
              omittedBytes?: number;
              fullEvidence?: unknown;
            };
          };
          bytes: number;
        }>
      >`
        select payload, octet_length(payload::text)::integer as bytes
        from session_events where session_id = ${sessionId} and sequence = 1`;
      expect(boundedPayload!.bytes).toBeLessThanOrEqual(65_536);
      expect(boundedPayload!.payload).toMatchObject({
        preview: "[event payload omitted by durable audit storage guard]",
        truncation: {
          truncated: true,
          surface: "database_guard",
          reason: "database_guard",
          deliveredBytes: boundedPayload!.bytes,
          fullEvidence: { available: false, reason: "not_retained" },
        },
      });
      expect(boundedPayload!.payload.truncation!.originalBytes).toBeGreaterThan(65_536);
      expect(boundedPayload!.payload.truncation!.omittedBytes).toBe(
        boundedPayload!.payload.truncation!.originalBytes! - boundedPayload!.bytes,
      );

      const [boundedEnvelope] = await admin<
        Array<{
          type: string;
          typeBytes: number;
          clientBytes: number;
          producerBytes: number;
          turnAssociation: string | null;
          payload: { envelopeProjection?: { truncated?: boolean; fields?: unknown[] } };
        }>
      >`
        select type, octet_length(type)::integer as "typeBytes",
          octet_length(client_event_id)::integer as "clientBytes",
          octet_length(producer_id)::integer as "producerBytes",
          turn_association as "turnAssociation", payload
        from session_events where session_id = ${sessionId} and sequence = 2`;
      expect(boundedEnvelope).toMatchObject({
        type: "session.event.envelope_omitted",
        turnAssociation: null,
        payload: {
          envelopeProjection: {
            truncated: true,
            fields: expect.arrayContaining([
              expect.objectContaining({ field: "type" }),
              expect.objectContaining({ field: "clientEventId" }),
              expect.objectContaining({ field: "producerId" }),
            ]),
          },
        },
      });
      expect(boundedEnvelope!.typeBytes).toBeLessThanOrEqual(256);
      expect(boundedEnvelope!.clientBytes).toBeLessThanOrEqual(1_024);
      expect(boundedEnvelope!.producerBytes).toBeLessThanOrEqual(1_024);

      const [duplicate] = await admin<Array<{ reasonBytes: number; payload: unknown }>>`
        select octet_length(duplicate_reason)::integer as "reasonBytes", payload
        from session_events where session_id = ${sessionId} and sequence = 4`;
      expect(duplicate!.reasonBytes).toBeLessThanOrEqual(4_096);
      expect(duplicate!.payload).toMatchObject({
        envelopeProjection: {
          fields: expect.arrayContaining([expect.objectContaining({ field: "duplicateReason" })]),
        },
      });

      const validated = await admin<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conrelid = 'session_events'::regclass and conname = any(${constraintNames})`;
      expect(validated).toHaveLength(6);
      expect(validated.every((constraint) => constraint.validated)).toBeTrue();

      const [violations] = await admin<{ count: number }[]>`
        select count(*)::integer as count
        from session_events
        where octet_length(payload::text) > 65536
          or octet_length(type) > 256
          or position(E'\n' in type) > 0
          or position(E'\r' in type) > 0
          or (client_event_id is not null and octet_length(client_event_id) > 1024)
          or (producer_id is not null and octet_length(producer_id) > 1024)
          or (turn_association is not null and octet_length(turn_association) > 64)
          or (duplicate_reason is not null and octet_length(duplicate_reason) > 4096)`;
      expect(violations?.count).toBe(0);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
