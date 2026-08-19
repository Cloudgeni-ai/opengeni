import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { bootstrapWorkspace, createDb, createSession, getSession, type DbClient } from "../src";

const migrationUrl = new URL(
  "../drizzle/0289_session_composer_policy_authority.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0289-session-composer-policy-authority");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("migration 0289 session composer policy authority", () => {
  test("declares the one-way drained cutover and bounded historical backfill", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source.match(/opengeni_app sessions to be stopped/gu)).toHaveLength(2);
    expect(source).toContain('LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "session_turns" IN SHARE MODE');
    expect(source).toContain("session.\"metadata\" ->> 'reasoningEffort'");
    expect(source).toContain('SELECT turn."reasoning_effort"');
    expect(source).toContain("'medium'");
    expect(source).toContain("session.\"metadata\" ->> 'latencyMode'");
    expect(source).toContain('SELECT turn."latency_mode"');
    expect(source).toContain("'standard'");
    expect(source).toContain('ALTER COLUMN "reasoning_effort" SET NOT NULL');
    expect(source).toContain('ALTER COLUMN "latency_mode" SET NOT NULL');
    expect(source).toContain("CREATE OR REPLACE FUNCTION %1$I.fork_session_content(");
    expect(source).toContain("source_session.reasoning_effort, source_session.latency_mode");
  });

  test("persists and maps typed session policy under database checks", async () => {
    if (!shared || !client) return;
    const subjectId = `user:${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "migration-0286-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Migration 0289",
      workspaceExternalSource: "migration-0286-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Migration 0289",
      subjectId,
    });
    const grant = access.workspaceGrants[0]!;
    const created = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "freeze exact session policy",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "high",
      latencyMode: "priority",
      sandboxBackend: "none",
    });

    expect(await getSession(client.db, grant.workspaceId!, created.id)).toMatchObject({
      model: "test-model",
      reasoningEffort: "high",
      latencyMode: "priority",
    });
    const columns = await shared.admin<
      Array<{ columnName: string; nullable: string; constraintDefinition: string }>
    >`
      select
        column_name as "columnName",
        is_nullable as nullable,
        pg_get_constraintdef(con.oid) as "constraintDefinition"
      from information_schema.columns column_info
      join pg_constraint con
        on con.conrelid = 'sessions'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%' || column_info.column_name || '%'
      where table_schema = current_schema()
        and table_name = 'sessions'
        and column_name in ('reasoning_effort', 'latency_mode')
      order by column_name`;
    expect([...columns]).toEqual([
      expect.objectContaining({
        columnName: "latency_mode",
        nullable: "NO",
        constraintDefinition: expect.stringContaining("standard"),
      }),
      expect.objectContaining({
        columnName: "reasoning_effort",
        nullable: "NO",
        constraintDefinition: expect.stringContaining("medium"),
      }),
    ]);
  });
});
