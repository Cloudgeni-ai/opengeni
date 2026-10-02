import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { nestedPostgresSqlState } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES } from "../src/runtime-posture";

let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0583-operator-permission");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0583 requires local PostgreSQL");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

async function expectState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function organization(activated: boolean): Promise<string> {
  if (!owned) throw new Error("test database unavailable");
  const [account] = await owned.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('0583 permission test') returning id`;
  if (activated)
    await owned.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${account!.id}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'local-fixture')`;
  return account!.id;
}

describe("migration 0583 inert operator permission preparation", () => {
  test("defines only the owner seam, with truthful audit and two drain checks", () => {
    const source = readFileSync(
      new URL("../drizzle/0583_session_tenancy_operator_permission.sql", import.meta.url),
      "utf8",
    );
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION enable_organization_private_sessions_from_activation(uuid,text[]) FROM PUBLIC",
    );
    expect(source).not.toContain("GRANT EXECUTE");
    expect(source.match(/FROM pg_stat_activity activity/g)?.length).toBe(2);
    expect(source).toContain("service:session-tenancy-activation");
    expect(source).not.toMatch(
      /UPDATE sessions|UPDATE session_turns|INSERT INTO session_tenancy_activations/,
    );
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(
      "enable_organization_private_sessions_from_activation(uuid, text[])",
    );
  });

  test("is forced-RLS owner-only, receipt-gated, live-login-gated and truthful/idempotent", async () => {
    if (!owned || !owner) return;
    const accountId = await organization(false);
    const [role] = await owned.admin<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = ${owned.ownerRole}`;
    expect(role).toEqual({ superuser: false, bypass: false });
    const [acl] = await owned.admin<{ allowed: boolean }[]>`
      select has_function_privilege('opengeni_app', 'enable_organization_private_sessions_from_activation(uuid,text[])', 'EXECUTE') as allowed`;
    expect(acl?.allowed).toBe(false);
    await expectState(
      () => owner!`
      select enable_organization_private_sessions_from_activation(${accountId}::uuid, ARRAY['does_not_exist'])`,
      "22023",
    );
    await expectState(
      () => owner!`
      select enable_organization_private_sessions_from_activation(${accountId}::uuid, ARRAY['opengeni_app'])`,
      "55000",
    );
    const activeId = await organization(true);
    const enabled = async () => {
      const [row] = await owner!<{ setting: Record<string, unknown> }[]>`
        select enable_organization_private_sessions_from_activation(${activeId}::uuid, ARRAY['opengeni_app']) as setting`;
      return row!.setting;
    };
    expect(await enabled()).toMatchObject({ enabled: true, version: 1, changed: true });
    expect(await enabled()).toMatchObject({ enabled: true, version: 1, changed: false });
    const [audit] = await owned.admin<{ count: number; actor: string; member: string | null }[]>`
      select count(*)::int as count, max(actor_subject_id) as actor, max(actor_membership_id::text) as member
      from organization_private_session_setting_events where account_id = ${activeId}`;
    expect(audit).toEqual({ count: 1, actor: "service:session-tenancy-activation", member: null });
    await owned.admin`update organization_private_session_settings set enabled = false where account_id = ${activeId}`;
    expect(await enabled()).toMatchObject({ enabled: true, version: 2, changed: true });

    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    const runtime = postgres(appUrl.toString(), { max: 1 });
    try {
      await runtime`select 1`; // Idle counts too, even for an already-enabled org.
      await expectState(enabled, "55000");
      await expectState(
        () => runtime`
        select enable_organization_private_sessions_from_activation(${activeId}::uuid, ARRAY['opengeni_app'])`,
        "42501",
      );
    } finally {
      await runtime.end({ timeout: 5 });
    }
  }, 180_000);

  test("a later org failure rolls back earlier permission and audit writes", async () => {
    if (!owned || !owner) return;
    const first = await organization(true);
    const second = await organization(false);
    await expectState(
      () =>
        owner!.begin(async (transaction) => {
          await transaction`select enable_organization_private_sessions_from_activation(${first}::uuid, ARRAY['opengeni_app'])`;
          await transaction`select enable_organization_private_sessions_from_activation(${second}::uuid, ARRAY['opengeni_app'])`;
        }),
      "55000",
    );
    const [rows] = await owned.admin<{ settings: number; events: number }[]>`
      select (select count(*)::int from organization_private_session_settings where account_id = ${first}) as settings,
        (select count(*)::int from organization_private_session_setting_events where account_id = ${first}) as events`;
    expect(rows).toEqual({ settings: 0, events: 0 });
  }, 180_000);
});
