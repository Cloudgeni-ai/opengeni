import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let fixture: OwnerMigratedTestDatabase;
const suffix = crypto.randomUUID().replaceAll("-", "");
const roles = [
  `recovery_existing_${suffix}`,
  `recovery_fresh_${suffix}`,
  `recovery_late_${suffix}`,
];
const password = crypto.randomUUID();

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("recovery-provisioning");
  if (!acquired) throw new Error("Real PostgreSQL required");
  fixture = acquired;
}, 180_000);

afterAll(async () => {
  if (!fixture) return;
  // These random roles belong only to this fixture. Remove their local grants
  // before releasing the database; never change the shared opengeni_app role.
  try {
    for (const role of roles) {
      if ((await fixture.admin`select 1 from pg_roles where rolname = ${role}`).length) {
        await fixture.admin.unsafe(`DROP OWNED BY "${role}"`);
        await fixture.admin.unsafe(`DROP ROLE "${role}"`);
      }
    }
  } finally {
    await fixture.release();
  }
}, 60_000);

test("owner migration before runtime creation and late provisioning preserve read-only default-off activation", async () => {
  const [existing, fresh, late] = roles as [string, string, string];
  await fixture.admin.unsafe(`CREATE ROLE "${existing}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  expect(
    (await fixture.admin`select 1 from pg_roles where rolname in (${fresh}, ${late})`).length,
  ).toBe(0);
  // Exactly the supported startup order: migrate under a non-superuser owner,
  // then create the configured runtime login. One already-existing rolling
  // role checks that the migration still grants its read permission.
  await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: [existing, fresh] });
  expect((await fixture.admin`select 1 from pg_roles where rolname = ${fresh}`).length).toBe(0);
  expect(
    (await fixture.admin`select consent_enabled from opengeni_private.sandbox_recovery_rollout`)[0]!
      .consent_enabled,
  ).toBe(false);
  expect(
    (
      await fixture.admin`select has_table_privilege(${existing}, 'opengeni_private.sandbox_recovery_rollout', 'SELECT') as allowed`
    )[0]!.allowed,
  ).toBe(true);

  for (const role of [fresh, late]) {
    // The late role was not named in the migration's runtime-role list.
    await provisionRoles(fixture.adminUrl, {
      appRole: role,
      appPassword: password,
      temporalDatabases: [],
    });
    const url = new URL(fixture.adminUrl);
    url.username = role;
    url.password = password;
    const app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      expect(
        (await app`select consent_enabled from opengeni_private.sandbox_recovery_rollout`)[0]!
          .consent_enabled,
      ).toBe(false);
      const [posture] =
        await app`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(posture).toMatchObject({ rolsuper: false, rolbypassrls: false });
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect(
          (
            await app`select has_table_privilege(current_user, 'opengeni_private.sandbox_recovery_rollout', ${privilege}) as allowed`
          )[0]!.allowed,
        ).toBe(false);
      }
      await expect(
        Promise.resolve(
          app`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true, release_evidence = 'forbidden runtime activation'`,
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Reprovisioning repairs an accidental direct ACL instead of preserving
      // activation writes. It also removes PUBLIC grants, without enabling.
      await fixture.admin.unsafe(
        `GRANT ALL ON opengeni_private.sandbox_recovery_rollout TO "${role}"`,
      );
      await fixture.admin`GRANT UPDATE ON opengeni_private.sandbox_recovery_rollout TO PUBLIC`;
      await fixture.admin.unsafe(
        `GRANT UPDATE (consent_enabled, release_evidence) ON opengeni_private.sandbox_recovery_rollout TO "${role}", PUBLIC`,
      );
      await provisionRoles(fixture.adminUrl, {
        appRole: role,
        appPassword: password,
        temporalDatabases: [],
      });
      await expect(
        Promise.resolve(
          app`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true, release_evidence = 'still forbidden'`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await app`select consent_enabled from opengeni_private.sandbox_recovery_rollout`)[0]!
          .consent_enabled,
      ).toBe(false);
    } finally {
      await app.end();
    }
  }
  const owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true, release_evidence = 'isolated test fixture only'`;
    expect(
      (await owner`select consent_enabled from opengeni_private.sandbox_recovery_rollout`)[0]!
        .consent_enabled,
    ).toBe(true);
  } finally {
    await owner.end();
  }
}, 180_000);
