import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0101_session_mcp_connection_refs.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0101-session-mcp-connection-refs");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0101] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0101 session MCP connection refs (real PostgreSQL)", () => {
  test("preserves existing rows and validates opaque host references", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0101-account') returning id`;
      if (!account) throw new Error("failed to create migration test account");
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account.id}, 'migration-0101-workspace') returning id`;
      if (!workspace) throw new Error("failed to create migration test workspace");
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id
        ) values (
          ${sessionId}, ${account.id}, ${workspace.id}, 'legacy session',
          'scripted-model', 'none', ${sessionId}
        )`;
      await sql`
        insert into session_mcp_servers (
          account_id, workspace_id, session_id, server_id, url
        ) values (
          ${account.id}, ${workspace.id}, ${sessionId}, 'legacy',
          'https://legacy.example/mcp'
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const [legacy] = await sql<Array<{ connectionRef: unknown }>>`
        select connection_ref as "connectionRef"
        from session_mcp_servers where session_id = ${sessionId} and server_id = 'legacy'`;
      expect(legacy?.connectionRef).toBeNull();

      const connectionRef = {
        connectionId: "cloud-connection:azure-devops:42",
        providerDomain: "dev.azure.com",
        kind: "delegated",
      };
      await sql`
        insert into session_mcp_servers (
          account_id, workspace_id, session_id, server_id, url, connection_ref
        ) values (
          ${account.id}, ${workspace.id}, ${sessionId}, 'host_azure',
          'https://azure.example/mcp', ${sql.json(connectionRef)}
        )`;
      const [stored] = await sql<Array<{ connectionRef: unknown }>>`
        select connection_ref as "connectionRef"
        from session_mcp_servers where session_id = ${sessionId} and server_id = 'host_azure'`;
      expect(stored?.connectionRef).toEqual(connectionRef);

      let invalidError: unknown;
      try {
        await sql`
          insert into session_mcp_servers (
            account_id, workspace_id, session_id, server_id, url, connection_ref
          ) values (
            ${account.id}, ${workspace.id}, ${sessionId}, 'invalid',
            'https://invalid.example/mcp', '{"connectionId":"missing-domain"}'::jsonb
          )`;
      } catch (error) {
        invalidError = error;
      }
      expect(invalidError).toBeInstanceOf(Error);
      expect((invalidError as { code?: string }).code).toBe("23514");
    } finally {
      await sql.end();
    }
  }, 180_000);
});
