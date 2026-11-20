import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migration = "1513_session_first_request_tools_revision.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = "user:first-request-tools-revision";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("first-request-tools-revision");
  if (!owned) throw new Error("Real PostgreSQL is required for the first-request tools revision");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-first-request-tools-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1513 session first-request tools revision", () => {
  test("existing sessions keep revision 0; sessions created after start undecided", async () => {
    const access = await bootstrapWorkspace(client!.db, {
      accountExternalSource: "first-request-tools-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "First-request tools",
      workspaceExternalSource: "first-request-tools-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "First-request tools",
      subjectId,
    });
    const accountId = access.defaultAccountId!;
    const workspaceId = access.defaultWorkspaceId!;
    const admin = owned!.admin;
    // Raw SQL, not the Drizzle helpers: the schema describes head, and this
    // database stops before 1513.
    const insertSession = async (message: string) =>
      await admin.begin(async (tx) => {
        await tx`
          select set_config('opengeni.account_id', ${accountId}, true),
            set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        const [row] = await tx<{ id: string }[]>`
          insert into sessions (
            account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
            sandbox_backend, sandbox_group_id, tool_policy
          ) values (
            ${accountId}, ${workspaceId}, ${message}, 'test-model', 'medium', 'standard', 'none',
            gen_random_uuid(),
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
          )
          returning id`;
        return row!.id;
      });
    const existing = await insertSession("before 1513");

    await migrate(owned!.ownerUrl);

    const created = await insertSession("after 1513");
    const rows = await admin<{ id: string; revision: number | null }[]>`
      select id, first_request_tools_revision as revision
      from sessions where workspace_id = ${workspaceId}`;
    const byId = new Map(rows.map((row) => [row.id, row.revision]));
    expect(byId.get(existing)).toBe(0);
    expect(byId.get(created)).toBeNull();

    const [column] = await admin<{ nullable: string; defaulted: string | null }[]>`
      select is_nullable as nullable, column_default as defaulted
      from information_schema.columns
      where table_schema = 'public' and table_name = 'sessions'
        and column_name = 'first_request_tools_revision'`;
    expect(column).toEqual({ nullable: "YES", defaulted: null });
  }, 180_000);
});
