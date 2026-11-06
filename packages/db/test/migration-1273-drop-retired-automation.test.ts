import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  assertRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  RETIRING_FEATURE_TABLES,
} from "../src/runtime-posture";

const migration = "1273_drop_retired_automation_and_pr_review.sql";
const sourceDirectory = join(import.meta.dir, "../drizzle");
const retired = [...RETIRING_FEATURE_TABLES.automations, ...RETIRING_FEATURE_TABLES.prReview];
const options = { rlsStrategy: "force" as const, targetSchema: "public" };
// The database stops before 1273, so tables later migrations add are absent
// from it by design. Compare the posture around the refused migration rather
// than against the current contract, which grows with every later table.
async function postureViolations(): Promise<string[]> {
  return evaluateRuntimeDatabasePosture(
    await inspectRuntimeDatabasePosture(client!.db, options),
    options,
  );
}
let predecessorViolations: string[] = [];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;
let client: DbClient | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string };

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("retired-automation-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for schema contraction");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-automation-contract-"));
  for (const name of await readdir(sourceDirectory)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(sourceDirectory, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2, rlsStrategy: "force" });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "automation-retirement-test",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "automation-retirement-test",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Current automation",
    workspaceName: "Current automation",
    subjectId: "contract-test-owner",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  predecessorViolations = await postureViolations();
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function assertNotApplied() {
  const tables = await owned!.admin<{ name: string; forced: boolean; rls: boolean }[]>`
    select c.relname as name, c.relforcerowsecurity as forced, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any(${retired}::text[])
    order by c.relname`;
  expect(tables.map((table) => table.name)).toEqual([...retired].sort());
  for (const table of tables) {
    const routing = ["automation_webhook_endpoints", "pr_review_managed_github_routes"].includes(
      table.name,
    );
    expect({ name: table.name, forced: table.forced, rls: table.rls }).toEqual({
      name: table.name,
      forced: !routing,
      rls: !routing,
    });
  }
  const [receipt] = await owned!.admin<{ present: boolean }[]>`
    select exists(select 1 from schema_migrations where name = ${migration}) as present`;
  expect(receipt?.present).toBe(false);
  expect(await postureViolations()).toEqual(predecessorViolations);
}

describe.skipIf(!realDatabase)("retired automation and PR-review contraction", () => {
  test("uses the real migration principal and unchanged predecessor posture", async () => {
    const [role] = await owner!<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`;
    expect(role).toEqual({ superuser: false, bypass: false });
    // The predecessor's only gaps are tables that migrations after 1273 create.
    const later = (await readdir(sourceDirectory)).filter(
      (name) => name.endsWith(".sql") && name > migration,
    );
    const laterSql = (
      await Promise.all(later.map((name) => readFile(join(sourceDirectory, name), "utf8")))
    ).join("\n");
    for (const violation of predecessorViolations) {
      const missing = /^(?:runtime privilege|protected) tables are missing: (.+)$/.exec(violation);
      expect({ violation, missingTables: missing !== null }).toEqual({
        violation,
        missingTables: true,
      });
      for (const table of missing![1]!.split(", ")) {
        const created = new RegExp(`create table (?:if not exists )?(?:public\\.)?${table}\\b`, "i");
        expect({ table, createdLater: created.test(laterSql) }).toEqual({
          table,
          createdLater: true,
        });
      }
    }
    await assertNotApplied();
  }, 180_000);

  test("an unexpected dependency fails closed without CASCADE or a partial drop", async () => {
    await owner!.unsafe(
      "create view unexpected_automation_reader as select id from automation_sources",
    );
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow("depend");
      await assertNotApplied();
      const [view] = await owned!.admin<{ present: boolean }[]>`
        select to_regclass('public.unexpected_automation_reader') is not null as present`;
      expect(view?.present).toBe(true);
    } finally {
      await owner!.unsafe("drop view unexpected_automation_reader");
    }
  }, 180_000);

  test("drops the closed retired group with its old rows and keeps current resources and readiness", async () => {
    // A retired tenant row, hidden from the migration owner by FORCE RLS, goes
    // with its table instead of blocking the contraction.
    await owned!.admin`
      insert into automation_sources
        (id, account_id, workspace_id, name, adapter_id, webhook_secret_encrypted, created_by_subject_id)
      values (${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, 'Old source', 'old', 'test', 'contract-test-owner')`;
    await migrate(owned!.ownerUrl);
    const [remaining] = await owned!.admin<{ count: number }[]>`
      select count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${retired}::text[])`;
    expect(remaining?.count).toBe(0);
    for (const name of [
      "automation_templates",
      "event_sources",
      "event_ingress_routes",
      "scheduled_tasks",
      "vaults",
      "subscription_connections",
    ]) {
      const [relation] = await owned!.admin<{ present: boolean }[]>`
        select to_regclass(${`public.${name}`}) is not null as present`;
      expect({ name, present: relation?.present }).toEqual({ name, present: true });
    }
    const session = await createSession(client!.db, {
      ...scope,
      initialMessage: "Current session after legacy automation contraction",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: "contract-test-owner" },
    });
    expect(session.workspaceId).toBe(scope.workspaceId);
    await assertRuntimeDatabasePosture(client!.db, options);
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, options);
    await migrate(owned!.ownerUrl);
    await assertRuntimeDatabasePosture(client!.db, options);
  }, 180_000);
});
