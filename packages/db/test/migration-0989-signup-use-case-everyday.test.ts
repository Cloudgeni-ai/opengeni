import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb } from "../src/database";
import { recordOrganizationSignupUseCase } from "../src/organization-signup-use-cases";

const migration = new URL("../drizzle/0989_signup_use_case_everyday.sql", import.meta.url);

test("everyday widens the signup answers and keeps the capability's search path", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("CHECK (use_case IN ('everyday', 'embed', 'cloud')) NOT VALID");
  expect(source).toContain("IF p_use_case NOT IN ('everyday', 'embed', 'cloud') THEN");
  expect(source).toContain("p_account IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(
    source.match(
      /ALTER FUNCTION opengeni_private\.record_organization_signup_use_case\(uuid,text,text\) SET search_path = pg_catalog, %I, pg_temp/g,
    ),
  ).toHaveLength(1);
  expect(source).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE)\b/);
});

// Reported as skipped when the real PostgreSQL fixture cannot start; the static
// test above is not a substitute for it.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "the runtime role records everyday as itself and still refuses other values",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("signup-use-case-everyday");
    if (!owned) throw new Error("PostgreSQL verification requires the Docker fixture");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const organizationId = crypto.randomUUID();
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${organizationId},'Everyday')`;
      const subjectId = "user:everyday_owner_1";

      expect(
        await recordOrganizationSignupUseCase(client.db, {
          organizationId,
          subjectId,
          useCase: "everyday",
        }),
      ).toBe("everyday");
      // The first answer still wins.
      expect(
        await recordOrganizationSignupUseCase(client.db, {
          organizationId,
          subjectId,
          useCase: "cloud",
        }),
      ).toBe("everyday");

      const raw = postgres(appUrl.toString(), {
        max: 1,
        connection: { statement_timeout: 30_000 },
      });
      try {
        await expect(
          raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id', ${organizationId}, true)`;
            await tx`SELECT opengeni_private.record_organization_signup_use_case(${organizationId}, 'user:everyday_owner_2', 'hobby')`;
          }),
        ).rejects.toMatchObject({ code: "22023" });
        // The replaced capability is still the runtime role's only way in.
        await expect(
          raw`SELECT use_case FROM opengeni_private.organization_signup_use_cases`.execute(),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await raw.end({ timeout: 5 });
      }
      const [routine] = await owned.admin<Array<{ securityDefiner: boolean; config: string[] }>>`
        SELECT p.prosecdef AS "securityDefiner", p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'opengeni_private' AND p.proname = 'record_organization_signup_use_case'`;
      expect(routine?.securityDefiner).toBe(true);
      expect(
        routine?.config.some((entry) => /^search_path=pg_catalog, .+, pg_temp$/.test(entry)),
      ).toBe(true);
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
