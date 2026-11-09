import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const signature = "list_uncompacted_recording_tracks_v1(integer, text)";

test("1283 withholds the compact-audio inventory 1282 granted from every configured role", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("recording-compact-withhold");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const roles: string[] = [];
  const execute = async (role: string) => {
    const [row] = await owned.admin`
      select has_function_privilege(${role}, p.oid, 'EXECUTE') as granted,
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as public_execute
      from pg_proc p where p.oid = ${`opengeni_private.${signature}`}::regprocedure`;
    return row;
  };
  try {
    // The whole chain runs 1282 and then 1283, so the runtime ends without it.
    await migrate(owned.ownerUrl);
    expect(await execute("opengeni_app")).toEqual({ granted: false, public_execute: false });
    for (let index = 0; index < 2; index++) {
      const role = `migration_1283_${crypto.randomUUID().replaceAll("-", "")}`;
      await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      roles.push(role);
      await recordTestRoleOwner(owned.admin, role);
    }
    const grant = await Bun.file(
      new URL("../drizzle/1282_recording_compact_inventory_grant.sql", import.meta.url),
    ).text();
    const withhold = await Bun.file(
      new URL("../drizzle/1283_withhold_recording_compact_inventory.sql", import.meta.url),
    ).text();
    expect(withhold).toStartWith("-- deployment-mode: rolling");
    expect(withhold).not.toMatch(/\b(DROP|GRANT)\b/);
    // A database where 1282 already granted it (staging): replay as the
    // non-superuser migration owner, not the provisioning admin. Missing
    // configured roles are ignored and duplicate roles are harmless.
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([
      ...roles,
      roles[0],
      "missing_recording_role",
    ])}, false)`;
    await owner.unsafe(grant);
    for (const role of ["opengeni_app", ...roles]) {
      expect(await execute(role)).toEqual({ granted: true, public_execute: false });
    }
    await owner.begin((transaction) => transaction.unsafe(withhold));
    await owner.begin((transaction) => transaction.unsafe(withhold));
    for (const role of ["opengeni_app", ...roles]) {
      expect(await execute(role)).toEqual({ granted: false, public_execute: false });
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
