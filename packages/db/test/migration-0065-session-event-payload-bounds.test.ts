import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationName = "0065_session_event_payload_bounds.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type GuardedRow = {
  payload: {
    id?: string;
    name?: string;
    preview?: string;
    truncation?: {
      truncated?: boolean;
      surface?: string;
      reason?: string;
      originalBytes?: number;
      deliveredBytes?: number;
      omittedBytes?: number;
      estimatedOriginalTokens?: number;
      estimatedDeliveredTokens?: number;
      fullEvidence?: unknown;
    };
  };
  storageBytes: number;
};

let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

function assertDatabaseGuard(row: GuardedRow, originalBytes: number): void {
  expect(row.storageBytes).toBeLessThanOrEqual(65_536);
  expect(row.payload.preview).toBe("[event payload omitted by durable audit storage guard]");
  expect(row.payload.truncation).toMatchObject({
    truncated: true,
    surface: "database_guard",
    reason: "database_guard",
    originalBytes,
    deliveredBytes: row.storageBytes,
    omittedBytes: originalBytes - row.storageBytes,
    estimatedOriginalTokens: Math.ceil(originalBytes / 4),
    estimatedDeliveredTokens: Math.ceil(row.storageBytes / 4),
    fullEvidence: { available: false, reason: "not_retained" },
  });
}

beforeAll(async () => {
  const explicitDatabaseUrl = process.env.OPENGENI_MIGRATION_0065_TEST_DATABASE_URL;
  blank = explicitDatabaseUrl
    ? { databaseUrl: explicitDatabaseUrl, release: async () => {} }
    : await acquireBlankTestDatabase("migration-0065-payload-bounds");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0065] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0065 session event payload bounds (real PostgreSQL)", () => {
  test("preserves historical rows and guards old-binary inserts/updates with exact accounting", async () => {
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
        insert into managed_accounts (name) values ('migration-0065-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0065-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'migration fixture',
          'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;

      const historicalPayload = {
        id: "historical",
        name: "sessions_list",
        output: `HEAD-${"h".repeat(180_000)}-TAIL`,
      };
      const insertPayload = {
        id: "insert-guard",
        name: "sessions_list",
        type: "function_call_output",
        status: "completed",
        isError: false,
        output: "i".repeat(220_000),
      };
      const updatePayload = {
        id: "update-guard",
        name: "parallel",
        code: "E2BIG",
        isError: true,
        output: "u".repeat(240_000),
      };
      const [sizes] = await admin<Array<{ historical: number; inserted: number; updated: number }>>`
        select
          octet_length(${admin.json(historicalPayload)}::jsonb::text)::integer as historical,
          octet_length(${admin.json(insertPayload)}::jsonb::text)::integer as inserted,
          octet_length(${admin.json(updatePayload)}::jsonb::text)::integer as updated`;

      await admin`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 1,
          'agent.tool_call.completed', ${admin.json(historicalPayload)}
        ), (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 2,
          'agent.tool_call.completed', ${admin.json({ id: "update-target", output: "small" })}
        )`;

      await applyFile(admin, migrationName);

      const [historical] = await admin<Array<{ payload: typeof historicalPayload; bytes: number }>>`
        select payload, octet_length(payload::text)::integer as bytes
        from session_events where session_id = ${sessionId} and sequence = 1`;
      expect(historical?.bytes).toBe(sizes!.historical);
      expect(historical?.bytes).toBeGreaterThan(65_536);
      expect(historical?.payload.output).toStartWith("HEAD-");
      expect(historical?.payload.output).toEndWith("-TAIL");

      const [constraint] = await admin<Array<{ validated: boolean }>>`
        select convalidated as validated
        from pg_constraint
        where conrelid = 'session_events'::regclass
          and conname = 'session_events_payload_bytes_check'`;
      expect(constraint).toEqual({ validated: false });

      const [inserted] = await admin<GuardedRow[]>`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 3,
          'agent.tool_call.completed', ${admin.json(insertPayload)}
        )
        returning payload, octet_length(payload::text)::integer as "storageBytes"`;
      assertDatabaseGuard(inserted!, sizes!.inserted);
      expect(inserted?.payload).toMatchObject({
        id: "insert-guard",
        name: "sessions_list",
        type: "function_call_output",
        status: "completed",
        isError: false,
      });

      const [updated] = await admin<GuardedRow[]>`
        update session_events set payload = ${admin.json(updatePayload)}
        where session_id = ${sessionId} and sequence = 2
        returning payload, octet_length(payload::text)::integer as "storageBytes"`;
      assertDatabaseGuard(updated!, sizes!.updated);
      expect(updated?.payload).toMatchObject({
        id: "update-guard",
        name: "parallel",
        code: "E2BIG",
        isError: true,
      });

      // NOT VALID leaves historical rows untouched but still rejects every new
      // violating row. Disable the trigger briefly to prove the check itself.
      await admin.unsafe(
        "alter table session_events disable trigger session_events_bound_payload_before_insert",
      );
      let constraintError: unknown;
      try {
        await admin`
          insert into session_events (
            account_id, workspace_id, session_id, sequence, type, payload
          ) values (
            ${account!.id}, ${workspace!.id}, ${sessionId}, 4,
            'agent.tool_call.completed', ${admin.json(insertPayload)}
          )`;
      } catch (error) {
        constraintError = error;
      } finally {
        await admin.unsafe(
          "alter table session_events enable trigger session_events_bound_payload_before_insert",
        );
      }
      expect((constraintError as { code?: string } | undefined)?.code).toBe("23514");
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
