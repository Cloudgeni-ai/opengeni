import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const signature = "list_uncompacted_recording_tracks_v1(integer, text)";

test("1282 grants the compact-audio inventory to every configured role without provisioning", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("recording-compact-grant");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const roles: string[] = [];
  try {
    await migrate(owned.ownerUrl);
    for (let index = 0; index < 2; index++) {
      const role = `migration_1282_${crypto.randomUUID().replaceAll("-", "")}`;
      await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      roles.push(role);
      await recordTestRoleOwner(owned.admin, role);
    }
    const source = await Bun.file(
      new URL("../drizzle/1282_recording_compact_inventory_grant.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\b(DROP|REVOKE)\b/i);
    await owner.unsafe(
      `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM opengeni_app`,
    );
    // Replay as the non-superuser migration owner, not the provisioning admin.
    // Missing configured roles are ignored and duplicate roles are harmless.
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([
      ...roles,
      roles[0],
      "missing_recording_role",
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
