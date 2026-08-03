import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0169_retire_model_visible_github_token.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0169-retire-model-visible-github-token");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0169-retire-model-visible-github-token] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("retire model-visible GitHub token migration", () => {
  test("requires a maintenance cutover and permanently rejects the retired tool", async () => {
    const sql = await readFile(join(migrationsDir, migration), "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(sql).toContain(`"first_party_mcp_tools" - 'github_token'`);
    expect(sql).toContain("sessions_first_party_mcp_tools_no_model_credentials_chk");
    expect(sql).toContain(`'["github_token"]'::jsonb`);
  });

  test("strips only github_token, updates the default, and fences stale writers", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      await admin.unsafe(`
        create table sessions (
          id uuid primary key,
          first_party_mcp_tools jsonb not null default '["session_get", "github_token"]'::jsonb
        )
      `);
      const legacySessionId = crypto.randomUUID();
      const narrowSessionId = crypto.randomUUID();
      await admin`
        insert into sessions (id, first_party_mcp_tools) values
          (
            ${legacySessionId},
            ${admin.json(["session_get", "github_token", "session_steer", "github_token"])}
          ),
          (
            ${narrowSessionId}, ${admin.json(["session_get"])}
          )`;

      await admin.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const rows = await admin<Array<{ id: string; tools: string[] }>>`
        select id, first_party_mcp_tools as tools
        from sessions
        where id in (${legacySessionId}, ${narrowSessionId})`;
      const byId = new Map(rows.map((row) => [row.id, row.tools]));
      expect(byId.get(legacySessionId)).toEqual(["session_get", "session_steer"]);
      expect(byId.get(narrowSessionId)).toEqual(["session_get"]);

      const [column] = await admin<Array<{ column_default: string | null }>>`
        select column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'sessions'
          and column_name = 'first_party_mcp_tools'`;
      expect(column?.column_default).not.toContain("github_token");
      for (const tool of FIRST_PARTY_MCP_TOOL_NAMES) {
        expect(column?.column_default).toContain(tool);
      }

      let staleWriterError: unknown;
      try {
        await admin`
          update sessions
          set first_party_mcp_tools = ${admin.json(["session_get", "github_token"])}
          where id = ${narrowSessionId}`;
      } catch (error) {
        staleWriterError = error;
      }
      expect(String(staleWriterError)).toMatch(
        /sessions_first_party_mcp_tools_no_model_credentials_chk/,
      );
    } finally {
      await admin.end({ timeout: 5 });
    }
  }, 180_000);
});
