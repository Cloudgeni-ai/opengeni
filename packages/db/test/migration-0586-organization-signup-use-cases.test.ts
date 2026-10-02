import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb } from "../src/database";
import { recordOrganizationSignupUseCase } from "../src/organization-signup-use-cases";

const migration = new URL("../drizzle/0586_organization_signup_use_cases.sql", import.meta.url);

test("signup use cases are a rolling, private relation behind one capability", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("CREATE TABLE opengeni_private.organization_signup_use_cases");
  expect(source).toContain("FORCE ROW LEVEL SECURITY");
  expect(source).toContain("p_account IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(source).toContain("CHECK (use_case IN ('embed', 'cloud'))");
  expect(source).not.toContain("SET search_path FROM CURRENT");
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
  "the runtime role records one person's first answer, only in its own organization",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("organization-signup-use-cases");
    if (!owned) throw new Error("PostgreSQL verification requires the Docker fixture");
    let client: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const db = client.db;
      const organizationId = crypto.randomUUID();
      const otherOrganizationId = crypto.randomUUID();
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${organizationId},'Signup')`;
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${otherOrganizationId},'Other')`;
      const subjectId = "user:signup_owner_1";

      expect(
        await recordOrganizationSignupUseCase(db, { organizationId, subjectId, useCase: "embed" }),
      ).toBe("embed");
      // The first answer wins; a repeat returns it unchanged.
      expect(
        await recordOrganizationSignupUseCase(db, { organizationId, subjectId, useCase: "cloud" }),
      ).toBe("embed");
      expect(
        await recordOrganizationSignupUseCase(db, {
          organizationId: otherOrganizationId,
          subjectId,
          useCase: "cloud",
        }),
      ).toBe("cloud");
      await expect(
        recordOrganizationSignupUseCase(db, {
          organizationId,
          subjectId: "api_key:not-a-person",
          useCase: "embed",
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(
        await owned.admin<Array<{ account_id: string; subject_id: string; use_case: string }>>`
          SELECT account_id, subject_id, use_case FROM opengeni_private.organization_signup_use_cases
          ORDER BY use_case`,
      ).toEqual([
        { account_id: otherOrganizationId, subject_id: subjectId, use_case: "cloud" },
        { account_id: organizationId, subject_id: subjectId, use_case: "embed" },
      ]);

      const raw = postgres(appUrl.toString(), {
        max: 1,
        connection: { statement_timeout: 30_000 },
      });
      try {
        // Without the caller's tenant scope the capability refuses, and the
        // runtime role never reads or writes the table directly.
        await expect(
          raw`SELECT opengeni_private.record_organization_signup_use_case(${organizationId}, ${subjectId}, 'cloud')`.execute(),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          raw`SELECT use_case FROM opengeni_private.organization_signup_use_cases`.execute(),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id', ${otherOrganizationId}, true)`;
            await tx`SELECT opengeni_private.record_organization_signup_use_case(${organizationId}, ${subjectId}, 'cloud')`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await raw.end({ timeout: 5 });
      }
    } finally {
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
