import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const signatures = [
  "nango_connections_in_use_v1(text[])",
  "nango_live_connection_owners_v1(text, text, text, integer)",
];

test("1499 grants both Nango definers to every configured role without PUBLIC, and 1500 validates the identity key check", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("nango-definers-grant");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const roles: string[] = [];
  try {
    await migrate(owned.ownerUrl);
    const [constraint] = await owned.admin<Array<{ validated: boolean }>>`
      select convalidated as validated from pg_constraint
      where conname = 'connections_account_identity_key_check'`;
    expect(constraint).toEqual({ validated: true });
    for (let index = 0; index < 2; index++) {
      const role = `migration_1499_${crypto.randomUUID().replaceAll("-", "")}`;
      await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      roles.push(role);
      await recordTestRoleOwner(owned.admin, role);
    }
    const source = await Bun.file(
      new URL("../drizzle/1499_nango_definers_runtime_grant.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\b(DROP|REVOKE)\b/i);
    // Start from 1482's and 1487's withheld state, then replay as the
    // non-superuser migration owner. Missing roles are ignored and duplicates
    // are harmless.
    for (const signature of signatures) {
      await owner.unsafe(
        `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM opengeni_app`,
      );
    }
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([
      ...roles,
      roles[0],
      "missing_nango_definer_role",
    ])}, false)`;
    await owner.unsafe(source);
    await owner.unsafe(source);
    for (const signature of signatures) {
      for (const role of ["opengeni_app", ...roles]) {
        const [row] = await owned.admin`
          select has_function_privilege(${role}, p.oid, 'EXECUTE') as granted,
            exists (
              select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            ) as public_execute
          from pg_proc p where p.oid = ${`opengeni_private.${signature}`}::regprocedure`;
        expect(row).toEqual({ granted: true, public_execute: false });
      }
    }
  } finally {
    await owner.end();
    for (const role of roles) {
      for (const signature of signatures) {
        await owned.admin.unsafe(
          `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM "${role}"`,
        );
      }
      await owned.admin.unsafe(`DROP ROLE "${role}"`);
    }
    await owned.release();
  }
}, 180_000);
