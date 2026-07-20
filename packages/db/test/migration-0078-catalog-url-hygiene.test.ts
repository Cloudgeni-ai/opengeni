import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0078_quarantine_credential_bearing_catalog_urls.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0078-catalog-url-hygiene");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0078] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0078 catalog URL hygiene (real PostgreSQL)", () => {
  test("scrubs unsafe imported endpoints and batch diagnostics while retaining safe rows", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      await sql`
        insert into import_batches (
          source, snapshot_date, attribution_note, details
        ) values (
          'integrations.sh', now(), 'fixture',
          ${sql.json({ skipped: [{ mcpUrl: "https://fixture.example/mcp?token=fixture" }] })}
        )`;
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0076-account') returning id`;
      const [localWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0076-local-workspace') returning id`;
      const [globalWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0076-global-workspace') returning id`;

      for (const [id, endpointUrl, mcpUrl] of [
        ["safe", "https://safe.example/mcp", "https://safe.example/mcp"],
        [
          "endpoint-query",
          "https://endpoint-query.example/mcp?token=fixture",
          "https://endpoint-query.example/mcp",
        ],
        [
          "mcp-fragment",
          "https://mcp-fragment.example/mcp",
          "https://mcp-fragment.example/mcp#token=fixture",
        ],
        [
          "endpoint-userinfo",
          "HTTPS://user:fixture@endpoint-userinfo.example/mcp",
          "https://endpoint-userinfo.example/mcp",
        ],
        [
          "opaque-path",
          `https://opaque-path.example/mcp/${"a1".repeat(16)}`,
          "https://opaque-path.example/mcp",
        ],
        [
          "shared",
          "https://shared.example/mcp?token=fixture",
          "https://shared.example/mcp?token=fixture",
        ],
      ] as const) {
        await sql`
          insert into capability_catalog_items (
            id, kind, source, name, endpoint_url, provider_domain, mcp_url, metadata
          ) values (
            ${`migration-0076-${id}`}, 'mcp', 'registry', ${id}, ${endpointUrl},
            ${`${id}.example`}, ${mcpUrl}, ${sql.json({ registry: "integrations.sh" })}
          )`;
      }
      await sql`
        insert into capability_catalog_items (
          id, account_id, workspace_id, kind, source, name, endpoint_url, provider_domain, mcp_url
        ) values (
          'migration-0076-shared', ${account!.id}, ${localWorkspace!.id}, 'mcp', 'manual',
          'Safe local override', 'https://local-shared.example/mcp',
          'local-shared.example', 'https://local-shared.example/mcp'
        )`;
      for (const workspaceId of [localWorkspace!.id, globalWorkspace!.id]) {
        await sql`
          insert into capability_installations (
            account_id, workspace_id, capability_id, kind
          ) values (
            ${account!.id}, ${workspaceId}, 'migration-0076-shared', 'mcp'
          )`;
      }

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const rows = await sql<
        Array<{
          id: string;
          workspaceId: string | null;
          endpointUrl: string | null;
          mcpUrl: string | null;
          stale: boolean;
        }>
      >`
        select id, workspace_id as "workspaceId", endpoint_url as "endpointUrl",
          mcp_url as "mcpUrl", stale
        from capability_catalog_items
        where id like 'migration-0076-%'
        order by id, workspace_id nulls first`;
      expect([...rows]).toEqual([
        {
          id: "migration-0076-safe",
          workspaceId: null,
          endpointUrl: "https://safe.example/mcp",
          mcpUrl: "https://safe.example/mcp",
          stale: false,
        },
        {
          id: "migration-0076-shared",
          workspaceId: localWorkspace!.id,
          endpointUrl: "https://local-shared.example/mcp",
          mcpUrl: "https://local-shared.example/mcp",
          stale: false,
        },
      ]);
      const installations = await sql<Array<{ workspaceId: string; capabilityId: string }>>`
        select workspace_id as "workspaceId", capability_id as "capabilityId"
        from capability_installations
        where capability_id = 'migration-0076-shared'
        order by workspace_id`;
      expect([...installations]).toEqual([
        { workspaceId: localWorkspace!.id, capabilityId: "migration-0076-shared" },
      ]);
      const [batch] = await sql<Array<{ details: Record<string, unknown> }>>`
        select details from import_batches where source = 'integrations.sh'`;
      expect(batch?.details).toEqual({});
    } finally {
      await sql.end();
    }
  }, 180_000);
});
