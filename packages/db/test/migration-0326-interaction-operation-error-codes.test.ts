// Migration 0326 repairs an invalid historical interaction-operation receipt
// under the same NOSUPERUSER/NOBYPASSRLS owner posture used in production.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migrationUrl = new URL(
  "../drizzle/0326_interaction_operation_error_codes.sql",
  import.meta.url,
);
const REPAIR_MIGRATION = "0326_interaction_operation_error_codes.sql";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OPERATION = "33333333-3333-4333-8333-333333333333";

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function applyBelow(url: string, upperBound: string): Promise<void> {
  const deferred = (await migrationFiles()).filter((file) => file >= upperBound);
  const ledger = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await ledger.unsafe(
      `CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )`,
    );
    for (const file of deferred) {
      await ledger`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
    await migrate(url);
    await ledger`delete from schema_migrations where name >= ${upperBound}`;
  } finally {
    await ledger.end({ timeout: 5 });
  }
}

describe("migration 0326 interaction operation error codes", () => {
  let owned: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0326-interaction-error-codes");
  }, 600_000);

  afterAll(async () => {
    await owned?.release();
  }, 120_000);

  test("declares and closes the FORCE-RLS owner repair window", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const noForce = 'ALTER TABLE "interaction_operations" NO FORCE ROW LEVEL SECURITY;';
    const force = 'ALTER TABLE "interaction_operations" FORCE ROW LEVEL SECURITY;';
    expect(sql.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(sql.indexOf(noForce)).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(noForce)).toBeLessThan(sql.indexOf("UPDATE %1$I.interaction_operations"));
    expect(sql.indexOf(force)).toBeGreaterThan(sql.indexOf("UPDATE %1$I.interaction_operations"));
  });

  test("repairs legacy receipts as the production migration owner and restores FORCE RLS", async () => {
    if (!owned) return;
    const { admin, ownerUrl, ownerRole } = owned;
    await applyBelow(ownerUrl, REPAIR_MIGRATION);

    const [identity] = await admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    await admin.unsafe(`
      insert into managed_accounts (id, name)
        values ('${ACCOUNT}', 'interaction-repair-account');
      insert into workspaces (id, account_id, name)
        values ('${WORKSPACE}', '${ACCOUNT}', 'interaction-repair-workspace');
      insert into interaction_operations (
        operation_id, account_id, workspace_id, resource_kind, resource_id,
        kind, request_digest, state, error_code, error_message,
        error_retryable, actor_subject_id, settled_at
      ) values (
        '${OPERATION}', '${ACCOUNT}', '${WORKSPACE}', 'browser_session',
        '44444444-4444-4444-8444-444444444444', 'create', repeat('a', 64),
        'outcome_unknown', 'controller_transition_expired', 'legacy receipt',
        false, 'migration-test', now()
      );
    `);

    const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      const [visible] = await owner<Array<{ count: string }>>`
        select count(*)::text as count from interaction_operations`;
      expect(visible?.count).toBe("0");
    } finally {
      await owner.end({ timeout: 5 });
    }

    await migrate(ownerUrl);

    const [operation] = await admin<Array<{ state: string; errorCode: string }>>`
      select state, error_code as "errorCode"
      from interaction_operations
      where operation_id = ${OPERATION}`;
    expect(operation).toEqual({ state: "outcome_unknown", errorCode: "outcome_unknown" });

    const [posture] = await admin<Array<{ forced: boolean }>>`
      select relforcerowsecurity as forced
      from pg_class
      where oid = 'interaction_operations'::regclass`;
    expect(posture?.forced).toBe(true);

    const [reaper] = await admin<Array<{ definition: string }>>`
      select pg_get_functiondef(proc.oid) as definition
      from pg_proc proc
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'opengeni_private'
        and proc.proname = 'reap_stale_interaction_transitions'
        and pg_get_function_identity_arguments(proc.oid) = 'p_interaction_holder_ttl_ms bigint'`;
    expect(reaper?.definition).toContain("error_code = 'outcome_unknown'");
    expect(reaper?.definition).not.toContain("error_code = 'controller_transition_expired'");
  }, 900_000);
});
