import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const signature = "summarize_queued_turns_by_hold()";

test("1274 grants the queued-turn hold summary to every configured role without PUBLIC", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("queued-turn-hold-grant");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const roles: string[] = [];
  try {
    await migrate(owned.ownerUrl);
    for (let index = 0; index < 2; index++) {
      const role = `migration_1274_${crypto.randomUUID().replaceAll("-", "")}`;
      await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      roles.push(role);
      await recordTestRoleOwner(owned.admin, role);
    }
    const source = await Bun.file(
      new URL("../drizzle/1274_queued_turn_hold_runtime_grant.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\b(DROP|REVOKE)\b/i);
    // Start from 0988's withheld state, then replay as the non-superuser
    // migration owner. Missing roles are ignored and duplicates are harmless.
    await owner.unsafe(
      `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM opengeni_app`,
    );
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([
      ...roles,
      roles[0],
      "missing_queued_turn_hold_role",
    ])}, false)`;
    await owner.unsafe(source);
    await owner.unsafe(source);
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
  } finally {
    await owner.end();
    for (const role of roles) {
      await owned.admin.unsafe(
        `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM "${role}"`,
      );
      await owned.admin.unsafe(`DROP ROLE "${role}"`);
    }
    await owned.release();
  }
}, 180_000);
