import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type postgres from "postgres";

const migrationUrl = new URL(
  "../drizzle/0220_memory_slack_append_only_cascade.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;
let sql: postgres.ReservedSql | null = null;

async function expectPostgresRejection(query: PromiseLike<unknown>): Promise<void> {
  try {
    await query;
  } catch {
    return;
  }
  throw new Error("Expected PostgreSQL to reject an immutable Memory Slack row mutation");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0220-memory-slack-cascade");
  if (!shared) return;
  sql = await shared.admin.reserve();
  await sql`set lock_timeout = '5s'`;
  await sql`set statement_timeout = '10s'`;
});

afterAll(async () => {
  sql?.release();
  await shared?.release();
});

describe("migration 0220 Memory Slack append-only cascade repair", () => {
  test("is rolling, schema-portable, and keeps ordinary mutation forbidden", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("pg_trigger_depth() > 1");
    expect(source).toContain("TG_TABLE_SCHEMA");
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = pg_catalog");
    expect(source).not.toMatch(/ACCESS\s+EXCLUSIVE/i);
  });

  test("allows only the parent cascade and removes the complete delivery history", async () => {
    if (!sql) return;
    const database = sql;
    const [account] = await database<{ id: string }[]>`
      insert into managed_accounts (name)
      values ('migration-0220-memory-slack-account')
      returning id`;
    const [workspace] = await database<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration-0220-memory-slack-workspace')
      returning id`;
    const [configuration] = await database<{ id: string }[]>`
      insert into memory_slack_publication_configurations (
        account_id, workspace_id, revision, enabled, connection_id,
        slack_team_id, slack_channel_id, auto_importances, review_importances,
        created_by_subject_id
      ) values (
        ${account!.id}, ${workspace!.id}, 1, true, ${crypto.randomUUID()},
        'T_TEST', 'C_TEST', array['major'], array['normal'], 'subject-1'
      ) returning id`;
    const [publication] = await database<{ id: string }[]>`
      insert into memory_slack_publications (
        account_id, workspace_id, configuration_id, configuration_revision,
        connection_id, slack_team_id, slack_channel_id, source_type, source_id,
        source_idempotency_key, projection, projection_sha256, importance,
        delivery_mode, state, operation_id, initiator_kind, initiator_subject_id
      ) values (
        ${account!.id}, ${workspace!.id}, ${configuration!.id}, 1,
        ${crypto.randomUUID()}, 'T_TEST', 'C_TEST', 'workspace_memory', 'memory-1',
        'memory-1:v1', ${database.json({ summary: "Durable decision" })}::jsonb,
        ${"a".repeat(64)}, 'major', 'auto', 'queued', ${crypto.randomUUID()},
        'service', 'goal-continuation'
      ) returning id`;
    const [receipt] = await database<{ id: string }[]>`
      insert into memory_slack_publication_receipts (
        account_id, workspace_id, publication_id, sequence, kind, state,
        attempt_number, actor_kind, actor_subject_id, operation_id
      ) values (
        ${account!.id}, ${workspace!.id}, ${publication!.id}, 1, 'enqueued',
        'queued', 0, 'service', 'goal-continuation', ${crypto.randomUUID()}
      ) returning id`;

    await expectPostgresRejection(
      database`update memory_slack_publication_configurations
        set enabled = false where id = ${configuration!.id}`,
    );
    await expectPostgresRejection(
      database`delete from memory_slack_publication_configurations
        where id = ${configuration!.id}`,
    );
    await expectPostgresRejection(
      database`delete from memory_slack_publication_receipts where id = ${receipt!.id}`,
    );

    await database`delete from managed_accounts where id = ${account!.id}`;

    const [remaining] = await database<
      Array<{ configurations: number; publications: number; receipts: number }>
    >`
      select
        (select count(*)::int from memory_slack_publication_configurations
          where account_id = ${account!.id}) as configurations,
        (select count(*)::int from memory_slack_publications
          where account_id = ${account!.id}) as publications,
        (select count(*)::int from memory_slack_publication_receipts
          where account_id = ${account!.id}) as receipts`;
    expect(remaining).toEqual({
      configurations: 0,
      publications: 0,
      receipts: 0,
    });
  }, 60_000);
});
