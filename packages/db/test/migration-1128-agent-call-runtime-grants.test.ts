import { expect, test } from "bun:test";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase, recordTestRoleOwner } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const signatures = [
  "native_push_device_v2(text)",
  "register_native_push_device_v2(text, text, text, text, text, text[], text)",
  "claim_native_push_deliveries_v2(uuid, integer, integer)",
  "agent_call_device_count_v1(text, boolean)",
  "agent_call_ringing_v1(text)",
  "ring_agent_call_v1(uuid, boolean)",
];

test("1128 grants every configured role without provisioning and preserves v1 access", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("agent-call-grants");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  const owner = postgres(owned.ownerUrl, { max: 1 });
  const roles: string[] = [];
  try {
    await migrate(owned.ownerUrl);
    for (let index = 0; index < 2; index++) {
      const role = `migration_1128_${crypto.randomUUID().replaceAll("-", "")}`;
      await owned.admin.unsafe(`CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS`);
      roles.push(role);
      await recordTestRoleOwner(owned.admin, role);
    }
    const source = await Bun.file(
      new URL("../drizzle/1128_agent_call_runtime_grants.sql", import.meta.url),
    ).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\b(DROP|REVOKE)\b/i);
    for (const signature of signatures) {
      await owner.unsafe(
        `REVOKE EXECUTE ON FUNCTION opengeni_private.${signature} FROM opengeni_app`,
      );
    }
    // Replay as the non-superuser migration owner, not the provisioning admin.
    // Missing configured roles are ignored and duplicate roles are harmless.
    await owner`select set_config('opengeni.migration_application_roles', ${JSON.stringify([
      ...roles,
      roles[0],
      "missing_agent_call_role",
    ])}, false)`;
    await owner.unsafe(source);
    await owner.unsafe(source);
    for (const role of ["opengeni_app", ...roles]) {
      for (const signature of signatures) {
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
    for (const signature of [
      "native_push_device_v1(text)",
      "register_native_push_device_v1(text, text, text, text, text, text[])",
      "claim_native_push_deliveries_v1(uuid, integer, integer)",
    ]) {
      const [row] = await owned.admin`
        select has_function_privilege('opengeni_app', ${`opengeni_private.${signature}`}, 'EXECUTE') as granted`;
      expect(row?.granted).toBe(true);
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
