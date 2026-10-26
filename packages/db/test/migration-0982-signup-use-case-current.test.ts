import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb } from "../src/database";
import {
  readOrganizationSignupUseCase,
  recordOrganizationSignupUseCase,
  setOrganizationSignupUseCase,
} from "../src/organization-signup-use-cases";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

const migration = new URL("../drizzle/0982_signup_use_case_current.sql", import.meta.url);
const TABLE = "organization_signup_current_use_cases";

test("the current answer is a securely shaped tenant table with row grants only", async () => {
  const source = await readFile(migration, "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain(`ALTER TABLE opengeni_private.${TABLE} FORCE ROW LEVEL SECURITY;`);
  expect(source).toContain("USING (account_id = opengeni_private.current_account_id())");
  expect(source).toContain("CHECK (use_case IN ('everyday', 'embed', 'cloud'))");
  expect(source).not.toMatch(/SECURITY DEFINER/);
  expect(source).not.toMatch(/GRANT[^;]*\bDELETE\b/);
});

// Reported as skipped when the real PostgreSQL fixture cannot start; the static
// test above is not a substitute for it.
const postgresTest =
  process.env.CI || process.env.OPENGENI_REQUIRE_REAL_DB === "1" || Bun.which("docker")
    ? test
    : test.skip;

postgresTest(
  "a person changes their current answer, the first answer stays, and the previous release stays ready",
  async () => {
    const owned = await acquireOwnerMigratedTestDatabase("signup-use-case-current");
    if (!owned) throw new Error("PostgreSQL verification requires the Docker fixture");
    let client: ReturnType<typeof createDb> | undefined;
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    const oldRoot = await mkdtemp(`${repoRoot}/.signup-current-old-runtime-`);
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      const organizationId = crypto.randomUUID();
      const person = "user:current_answer_person";
      await owned.admin`INSERT INTO managed_accounts(id,name) VALUES(${organizationId},'Current answer')`;

      expect(
        await readOrganizationSignupUseCase(client.db, { organizationId, subjectId: person }),
      ).toBeNull();
      const answer = { organizationId, subjectId: person };
      expect(
        await recordOrganizationSignupUseCase(client.db, { ...answer, useCase: "cloud" }),
      ).toBe("cloud");
      expect(await setOrganizationSignupUseCase(client.db, { ...answer, useCase: "cloud" })).toBe(
        "cloud",
      );
      // Back, then everyday: the current answer changes, the first one stays.
      expect(
        await setOrganizationSignupUseCase(client.db, { ...answer, useCase: "everyday" }),
      ).toBe("everyday");
      expect(await readOrganizationSignupUseCase(client.db, answer)).toBe("everyday");
      expect(
        await recordOrganizationSignupUseCase(client.db, { ...answer, useCase: "embed" }),
      ).toBe("cloud");
      expect(await readOrganizationSignupUseCase(client.db, answer)).toBe("everyday");
      await expect(
        setOrganizationSignupUseCase(client.db, {
          organizationId,
          subjectId: "api_key:not-a-person",
          useCase: "embed",
        }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });

      const raw = postgres(appUrl.toString(), {
        max: 1,
        connection: { statement_timeout: 30_000 },
      });
      try {
        // Another tenant sees nothing and cannot write here; nobody deletes.
        const otherTenant = crypto.randomUUID();
        expect(
          await raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id', ${otherTenant}, true)`;
            return await tx`SELECT use_case FROM opengeni_private.${tx(TABLE)}`;
          }),
        ).toHaveLength(0);
        await expect(
          raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id', ${otherTenant}, true)`;
            await tx`INSERT INTO opengeni_private.${tx(TABLE)} (account_id, subject_id, use_case)
              VALUES (${organizationId}, 'user:intruder', 'embed')`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          raw.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id', ${organizationId}, true)`;
            await tx`DELETE FROM opengeni_private.${tx(TABLE)}`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await raw.end({ timeout: 5 });
      }

      const options = {
        expectedRole: "opengeni_app",
        rlsStrategy: "force" as const,
        targetSchema: "public",
      };
      const mentionsTable = (violations: string[]) =>
        violations.filter((violation) => violation.includes(TABLE));
      expect(
        mentionsTable(
          evaluateRuntimeDatabasePosture(
            await inspectRuntimeDatabasePosture(client.db, options),
            options,
          ),
        ),
      ).toEqual([]);
      // The release before this one inspects the same catalog and does not
      // know the table: its forward-compatible readiness must accept it.
      for (const name of ["runtime-posture.ts", "role-relationships.ts", "provision-roles.ts"]) {
        await writeFile(
          `${oldRoot}/${name}`,
          execFileSync("git", ["show", `origin/main:packages/db/src/${name}`], { cwd: repoRoot }),
        );
      }
      await writeFile(
        `${oldRoot}/runtime-posture-legacy-routines.json`,
        execFileSync(
          "git",
          ["show", "origin/main:packages/db/src/runtime-posture-legacy-routines.json"],
          { cwd: repoRoot },
        ),
      );
      const old = await import(pathToFileURL(`${oldRoot}/runtime-posture.ts`).href);
      expect(
        mentionsTable(
          old.evaluateRuntimeDatabasePosture(
            await old.inspectRuntimeDatabasePosture(client.db, options),
            options,
          ),
        ),
      ).toEqual([]);
    } finally {
      await rm(oldRoot, { recursive: true, force: true });
      await client?.close();
      await owned.release();
    }
  },
  180_000,
);
