import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb } from "../src/database";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

// A hardened managed PostgreSQL may revoke the default PUBLIC CONNECT on the
// database. Every login role db:provision-roles sets up must then still be
// able to connect, so provisioning grants CONNECT to each one explicitly.
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");
const schema = "og_data";
const appRole = "opengeni_app";
const hostExportRole = "opengeni_host_exporter";
const hostExportPassword = "host-export-connect-test-password";
const outboxRole = "opengeni_artifact_outbox_dispatcher";
const outboxPassword = "artifact-outbox-test-password";
const materializerRole = "opengeni_artifact_materializer";
const materializerPassword = "artifact-materializer-test-password";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let appPassword = "";

function roleUrl(role: string, password: string): string {
  const url = new URL(fixture!.adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function directDatabasePrivileges(role: string): Promise<string[]> {
  const rows = await fixture!.admin<{ privilege: string }[]>`
    select acl.privilege_type as privilege
    from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
    join pg_roles r on r.oid = acl.grantee
    where d.datname = current_database() and r.rolname = ${role}
    order by 1
  `;
  return rows.map((row) => row.privilege);
}

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  fixture = await acquireRestrictedRuntimeTestDatabase("provision-connect", schema);
  if (!fixture) throw new Error("Real PostgreSQL required");
  appPassword = new URL(fixture.appUrl).password;
  const [database] = await fixture.admin<{ name: string }[]>`select current_database() as name`;
  await fixture.admin.unsafe(`REVOKE CONNECT ON DATABASE "${database!.name}" FROM PUBLIC`);
  await provisionRoles(fixture.adminUrl, {
    targetSchema: schema,
    rlsStrategy: "force",
    appRole,
    appPassword,
    hostExportRole,
    hostExportPassword,
    artifactOutboxDispatcherRole: outboxRole,
    artifactOutboxDispatcherPassword: outboxPassword,
    artifactMaterializerRole: materializerRole,
    artifactMaterializerPassword: materializerPassword,
    // Temporal databases are created and fully granted by the provisioner;
    // this test covers the Opengeni database itself.
    temporalPassword: "",
  });
}, 180_000);

afterAll(async () => {
  await fixture?.release();
}, 180_000);

realTest("the database no longer grants CONNECT to PUBLIC", async () => {
  const [row] = await fixture!.admin<{ public_connect: boolean }[]>`
    select exists (
      select 1 from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) acl
      where d.datname = current_database() and acl.grantee = 0 and acl.privilege_type = 'CONNECT'
    ) as public_connect
  `;
  expect(row!.public_connect).toBe(false);
});

realTest(
  "the runtime app role is granted exactly CONNECT and passes the posture gate",
  async () => {
    expect(await directDatabasePrivileges(appRole)).toEqual(["CONNECT"]);
    const client = createDb(fixture!.appUrl, { searchPath: schema, max: 1 });
    try {
      await assertRuntimeDatabasePosture(client.db, {
        rlsStrategy: "force",
        targetSchema: schema,
        expectedRole: appRole,
      });
    } finally {
      await client.close();
    }
  },
);

realTest(
  "every other provisioned login role can connect, with nothing beyond CONNECT",
  async () => {
    for (const [role, password] of [
      [hostExportRole, hostExportPassword],
      [outboxRole, outboxPassword],
      [materializerRole, materializerPassword],
    ] as const) {
      expect(await directDatabasePrivileges(role)).toEqual(["CONNECT"]);
      const connection = postgres(roleUrl(role, password), { max: 1 });
      try {
        const [row] = await connection<{ role: string }[]>`select current_user::text as role`;
        expect(row!.role).toBe(role);
      } finally {
        await connection.end();
      }
    }
  },
);
