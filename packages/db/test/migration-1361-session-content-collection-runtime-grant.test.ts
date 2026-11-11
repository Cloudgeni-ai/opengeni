import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

test("1361 activates the session content collector for all application roles, never PUBLIC", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("session-content-collection-grant");
  if (!owned) throw new Error("PostgreSQL is required");
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const role = `migration_1361_${crypto.randomUUID().replaceAll("-", "")}`;
  const signatures = [
    "opengeni_private.session_content_garbage_candidates_v1(integer)",
    "opengeni_private.collect_session_content_garbage_v1(uuid, uuid, integer)",
  ];
  let created = false;
  try {
    await migrate(owned.ownerUrl);
    await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
    created = true;
    await recordTestRoleOwner(owned.admin, role);
    for (const signature of signatures) {
      await owner.unsafe(`REVOKE EXECUTE ON FUNCTION ${signature} FROM opengeni_app`);
    }
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([role, role, "missing_collector_role"])}, false)`;
    const source = await Bun.file(
      new URL("../drizzle/1361_session_content_collection_runtime_grant.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    await owner.unsafe(source);
    await owner.unsafe(source);
    for (const signature of signatures) {
      for (const grantee of [role, "opengeni_app"]) {
        const [row] = await owned.admin`
          select has_function_privilege(${grantee}, p.oid, 'EXECUTE') as granted,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
          from pg_proc p where p.oid = ${signature}::regprocedure`;
        expect(row).toEqual({ granted: true, public_execute: false });
      }
    }
  } finally {
    await owner.end();
    if (created) {
      for (const signature of signatures) {
        await owned.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${signature} FROM "${role}"`);
      }
      await owned.admin.unsafe(`DROP ROLE "${role}"`);
    }
    await owned.release();
  }
}, 180_000);
