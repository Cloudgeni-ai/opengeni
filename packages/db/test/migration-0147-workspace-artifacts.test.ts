import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "@opengeni/contracts";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession } from "../src/index";

const migration = "0147_workspace_artifacts.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0147-workspace-artifacts");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0147-workspace-artifacts] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("workspace artifacts migration", () => {
  test("is maintenance-gated, FORCE-RLS protected, immutable, and least privilege", async () => {
    const sql = await readFile(join(migrationsDir, migration), "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(sql).toContain('CREATE TABLE "workspace_artifacts"');
    expect(sql).toContain('CREATE TABLE "workspace_artifact_versions"');
    expect(sql).toContain('CREATE TABLE "workspace_artifact_events"');
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(sql.match(/CREATE POLICY workspace_isolation/g)).toHaveLength(3);
    expect(sql.match(/opengeni_private\.workspace_rls_visible/g)).toHaveLength(6);
    expect(sql).toContain("workspace_artifact_versions_immutable");
    expect(sql).toContain("workspace_artifact_events_immutable");
    expect(sql).toContain("pg_trigger_depth() > 1");
    expect(sql).toContain("GRANT SELECT, INSERT ON TABLE");
    expect(sql).toContain('"source_attempt_id" uuid');
    expect(sql).toContain('"source_execution_generation" integer');
    expect(sql).toContain("workspace_artifact_versions_provenance_chk");
    expect(sql).toContain("workspace_artifact_events_source_attempt_fk");
    expect(sql.match(/UPDATE "sessions"/g)).toHaveLength(1);
    expect(sql).not.toContain('SET "first_party_mcp_tools"');
    expect(sql).toContain('WHERE "first_party_mcp_permissions" IS NULL');
    expect(sql).not.toContain('WHERE "first_party_mcp_tools"');
  });

  test("freezes only historical NULL permissions and preserves empty and narrow selections", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    let db: ReturnType<typeof createDb> | null = null;
    try {
      await admin.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await admin`
          insert into schema_migrations (name) values (${file})
          on conflict do nothing`;
      }

      db = createDb(blank.databaseUrl);
      const access = await bootstrapWorkspace(db.db, {
        accountExternalSource: "migration-0147",
        accountExternalId: crypto.randomUUID(),
        accountName: "Migration 0147 account",
        workspaceExternalSource: "migration-0147",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "Migration 0147 workspace",
        subjectId: "user:migration-0147",
      });
      const grant = access.workspaceGrants[0]!;
      const historicalTools = FIRST_PARTY_MCP_TOOL_NAMES.filter(
        (name) => !name.startsWith("artifacts_"),
      );
      const historicalPermissions = DEFAULT_FIRST_PARTY_MCP_PERMISSIONS.filter(
        (permission) => !permission.startsWith("artifacts:"),
      );
      const create = async (suffix: string, permissions?: string[], tools = historicalTools) =>
        await createSession(db!.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          initialMessage: suffix,
          resources: [],
          tools: [],
          metadata: {},
          model: "gpt-5.6-sol",
          sandboxBackend: "none",
          ...(permissions === undefined ? {} : { firstPartyMcpPermissions: permissions as never }),
          firstPartyMcpTools: [...tools],
        });
      const inherited = await create("null-permissions");
      const empty = await create("empty", [], []);
      const narrow = await create("narrow", ["workspace:read"], ["session_get"]);

      await admin.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const rows = await admin<Array<{ id: string; permissions: string[]; tools: string[] }>>`
        select id, first_party_mcp_permissions as permissions, first_party_mcp_tools as tools
        from sessions
        where id in (${inherited.id}, ${empty.id}, ${narrow.id})
        order by initial_message`;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(inherited.id)).toEqual({
        id: inherited.id,
        permissions: historicalPermissions,
        tools: historicalTools,
      });
      expect(byId.get(empty.id)).toEqual({ id: empty.id, permissions: [], tools: [] });
      expect(byId.get(narrow.id)).toEqual({
        id: narrow.id,
        permissions: ["workspace:read"],
        tools: ["session_get"],
      });
      expect(rows.every((row) => row.tools.every((tool) => !tool.startsWith("artifacts_")))).toBe(
        true,
      );

      const [column] = await admin<Array<{ column_default: string | null }>>`
        select column_default
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'sessions'
          and column_name = 'first_party_mcp_tools'`;
      expect(column?.column_default).toContain("artifacts_create");
      expect(column?.column_default).toContain("artifacts_publish");
      expect(column?.column_default).toContain("artifacts_rollback");
    } finally {
      await db?.close();
      await admin.end();
    }
  }, 180_000);
});
