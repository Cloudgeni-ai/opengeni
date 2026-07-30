import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0136_unified_session_tool_policy.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0136");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0136] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0136 (unified session tool policy)", () => {
  test("backfills populated rows, removes legacy policy, and clears per-turn drafts", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`
          insert into schema_migrations (name)
          values (${file})
          on conflict do nothing
        `;
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0136-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0136-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, tool_policy, first_party_mcp_tools
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'fixture',
          'test-model', 'none', ${sessionId},
          ${sql.json({ mode: "legacy", inheritedFromSessionId: null })}, null
        )`;
      await sql`
        insert into composer_drafts (
          account_id, workspace_id, session_id, subject_id, revision, text,
          resources, tools, tools_provided, model, reasoning_effort
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, 'user:test', 1, 'draft',
          '[]'::jsonb, ${sql.json([{ kind: "mcp", id: "linear" }])}, true,
          'test-model', 'medium'
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const [session] = await sql<
        Array<{ policy: unknown; first_party_count: number; policy_nullable: string }>
      >`
        select tool_policy as policy,
               jsonb_array_length(first_party_mcp_tools)::int as first_party_count,
               (
                 select is_nullable
                 from information_schema.columns
                 where table_schema = 'public'
                   and table_name = 'sessions'
                   and column_name = 'tool_policy'
               ) as policy_nullable
        from sessions where id = ${sessionId}`;
      expect(session).toEqual({
        policy: { mode: "explicit", inheritedFromSessionId: null },
        first_party_count: 50,
        policy_nullable: "NO",
      });

      const [draft] = await sql<Array<{ tools: unknown; tools_provided: boolean }>>`
        select tools, tools_provided from composer_drafts where session_id = ${sessionId}`;
      expect(draft).toEqual({ tools: [], tools_provided: false });

      let rejectedLegacy = false;
      try {
        await sql`
          update sessions
          set tool_policy = ${sql.json({ mode: "legacy", inheritedFromSessionId: null })}
          where id = ${sessionId}`;
      } catch {
        rejectedLegacy = true;
      }
      expect(rejectedLegacy).toBe(true);
    } finally {
      await sql.end();
    }
  }, 180_000);
});
