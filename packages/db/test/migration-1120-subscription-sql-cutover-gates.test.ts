import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

const migration = "1120_retire_subscription_sql_cutover_gates.sql";
const names = [
  "authorize_subscription_personal_access",
  "authorize_subscription_personal_placement_access",
  "quarantine_subscription_core_connection",
  "recover_subscription_core_connection_health",
  "subscription_core_acceptance_authority_v2",
  "subscription_core_task_authority_v2",
];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let owner: postgres.Sql | null = null;
let prefix: string | null = null;
let accountId: string;
let before: Array<{ name: string; body: string }>;

async function definitions() {
  return Array.from(
    await owned!.admin<{ name: string; body: string }[]>`
      select p.proname as name, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private' and p.proname = any(${names}::text[])
      order by p.proname`,
  );
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("subscription-sql-switch-retirement");
  if (!owned) throw new Error("Real PostgreSQL is required for SQL switch retirement");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-subscription-sql-switches-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "subscription-switch-retirement-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Subscription switch retirement",
    workspaceExternalSource: "subscription-switch-retirement-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Subscription switch retirement",
    subjectId: "subscription-switch-retirement-test",
  });
  accountId = access.defaultAccountId!;
  before = await definitions();
  expect(before).toHaveLength(6);
  expect(before.every((routine) => routine.body.includes("subscription_provider_cutovers"))).toBe(
    true,
  );
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("retire subscription SQL cutover switches", () => {
  test("an incomplete tenant cutover hidden by FORCE RLS aborts before changing routines", async () => {
    await owned!.admin`
      update subscription_provider_cutovers set enabled = false
      where account_id = ${accountId} and provider = 'codex'`;
    try {
      const [role] = await owner!<{ superuser: boolean; bypass: boolean }[]>`
        select rolsuper as superuser, rolbypassrls as bypass
        from pg_roles where rolname = current_user`;
      expect(role).toEqual({ superuser: false, bypass: false });
      const hidden = await owner!`
        select provider from subscription_provider_cutovers where account_id = ${accountId}`;
      expect(hidden).toHaveLength(0);
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
        "subscription-core cutover must be complete",
      );
      expect(await definitions()).toEqual(before);
      const [state] = await owned!.admin<{ forced: boolean; applied: boolean }[]>`
        select c.relforcerowsecurity as forced,
          exists(select 1 from schema_migrations where name = ${migration}) as applied
        from pg_class c where c.oid = 'public.subscription_provider_cutovers'::regclass`;
      expect(state).toEqual({ forced: true, applied: false });
      await assertRuntimeDatabasePosture(client!.db, {
        rlsStrategy: "force",
        targetSchema: "public",
      });
    } finally {
      await owned!.admin`
        update subscription_provider_cutovers set enabled = true
        where account_id = ${accountId} and provider = 'codex'`;
    }
  }, 180_000);

  test("a missing provider row also refuses and keeps all prior definitions", async () => {
    await owned!.admin`
      delete from subscription_provider_cutovers where account_id = ${accountId} and provider = 'xai'`;
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
        "subscription-core cutover must be complete",
      );
      expect(await definitions()).toEqual(before);
    } finally {
      await owned!.admin`
        insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${accountId}, 'xai', true)`;
    }
  }, 180_000);

  test("a completed predecessor retires exactly the six SQL switch reads without widening posture", async () => {
    await migrate(owned!.ownerUrl);
    const after = await definitions();
    expect(after).toHaveLength(6);
    for (const routine of after) {
      expect(routine.body).not.toContain("subscription_provider_cutovers");
      expect(routine.body).toContain("subscription_provider_cutover_committed(p_provider)");
    }
    await assertRuntimeDatabasePosture(client!.db, {
      rlsStrategy: "force",
      targetSchema: "public",
    });
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, {
      rlsStrategy: "force",
      targetSchema: "public",
    });
    await migrate(owned!.ownerUrl);
    expect(await definitions()).toEqual(after);
  }, 180_000);
});
