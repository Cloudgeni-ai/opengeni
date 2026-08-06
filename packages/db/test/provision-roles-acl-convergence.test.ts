import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  assertRuntimeDatabasePosture,
  createDb,
  ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES,
  ENABLED_V2_PROTECTED_TABLES,
  ENABLED_V2_TABLE_PRIVILEGES,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalRootUrl = process.env.OPENGENI_TEST_THROWAWAY_POSTGRES_ROOT_URL?.trim();
const roleSuffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const appRole = `og_acl_convergence_${roleSuffix}`;
const appPassword = `og-acl-convergence-${roleSuffix}`;
const existingProbe = "opengeni_private.acl_convergence_existing_probe()";
const newProbe = "opengeni_private.acl_convergence_new_probe()";
const exactRuntimeFunction = "opengeni_private.claim_session_workflow_wakes(integer)";
const operatorOnlyFunction = "opengeni_private.activate_organization_governance_target(text)";
const triggerOnlyFunction = "opengeni_private.require_organization_governance_target_trigger()";

let blank: BlankTestDatabase | null = null;
let externalRoot: postgres.Sql | null = null;
let available = true;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const roleIdentifier = quoteIdentifier(appRole);

beforeAll(async () => {
  if (externalRootUrl) {
    const rootUrl = new URL(externalRootUrl);
    rootUrl.pathname = "/postgres";
    externalRoot = postgres(rootUrl.toString(), { max: 1, prepare: false });
    const databaseName = `og_acl_${roleSuffix}`;
    await externalRoot.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const databaseUrl = new URL(externalRootUrl);
    databaseUrl.pathname = `/${databaseName}`;
    blank = {
      databaseUrl: databaseUrl.toString(),
      release: async () => {
        await externalRoot?.unsafe(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
        );
        await externalRoot?.end();
        externalRoot = null;
      },
    };
  } else {
    blank = await acquireBlankTestDatabase("provision-roles-acl-convergence");
  }
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[provision-roles-acl-convergence] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
  await externalRoot?.end();
  externalRoot = null;
}, 180_000);

describe("provisionRoles private-function ACL convergence", () => {
  test("removes stale defaults/direct grants and preserves exact runtime functions", async () => {
    if (!available || !blank) return;

    const admin = postgres(blank.databaseUrl, { max: 4, prepare: false });
    try {
      // The blank harness starts with the cluster-global opengeni_app role, so
      // migration 0001's historical schema-wide grant is exercised by the
      // shared template, while this test uses a unique role so parallel files
      // cannot race on credentials or role attributes.
      await migrate(blank.databaseUrl);
      await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "force",
        appRole,
        appPassword,
      });

      const [ownerRow] = await admin<{ owner: string }[]>`
        SELECT current_user AS owner`;
      const owner = ownerRow!.owner;
      const ownerIdentifier = quoteIdentifier(owner);
      await admin.unsafe(`
        CREATE OR REPLACE FUNCTION ${existingProbe}
        RETURNS integer
        LANGUAGE sql
        AS 'SELECT 1';
        REVOKE ALL ON FUNCTION ${existingProbe} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION ${existingProbe} TO ${roleIdentifier};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA opengeni_private
          GRANT EXECUTE ON FUNCTIONS TO ${roleIdentifier};
      `);

      const [seeded] = await admin<Array<{ existingExecute: boolean; defaultExecute: boolean }>>`
        SELECT
          has_function_privilege(
            ${appRole}, ${existingProbe}::regprocedure, 'EXECUTE'
          ) AS "existingExecute",
          EXISTS (
            SELECT 1
            FROM pg_default_acl defaults
            JOIN pg_namespace namespace
              ON namespace.oid = defaults.defaclnamespace
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
            WHERE defaults.defaclrole = ${owner}::regrole
              AND namespace.nspname = 'opengeni_private'
              AND acl.grantee = ${appRole}::regrole
              AND acl.privilege_type = 'EXECUTE'
          ) AS "defaultExecute"`;
      expect(seeded).toEqual({ existingExecute: true, defaultExecute: true });

      await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "force",
        appRole,
        appPassword,
      });

      // A function created after provisioning must not inherit the stale
      // schema-local default. Revoke PUBLIC so this proves the role-specific
      // default was removed rather than relying on PostgreSQL's PUBLIC default.
      await admin.unsafe(`
        CREATE OR REPLACE FUNCTION ${newProbe}
        RETURNS integer
        LANGUAGE sql
        AS 'SELECT 2';
        REVOKE ALL ON FUNCTION ${newProbe} FROM PUBLIC;
      `);

      const [converged] = await admin<
        Array<{
          defaultExecute: boolean;
          existingExecute: boolean;
          newExecute: boolean;
          exactRuntimeExecute: boolean;
          operatorOnlyExecute: boolean;
          triggerOnlyExecute: boolean;
        }>
      >`
        SELECT
          EXISTS (
            SELECT 1
            FROM pg_default_acl defaults
            JOIN pg_namespace namespace
              ON namespace.oid = defaults.defaclnamespace
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
            WHERE defaults.defaclrole = ${owner}::regrole
              AND namespace.nspname = 'opengeni_private'
              AND acl.grantee = ${appRole}::regrole
              AND acl.privilege_type = 'EXECUTE'
          ) AS "defaultExecute",
          has_function_privilege(
            ${appRole}, ${existingProbe}::regprocedure, 'EXECUTE'
          ) AS "existingExecute",
          has_function_privilege(
            ${appRole}, ${newProbe}::regprocedure, 'EXECUTE'
          ) AS "newExecute",
          has_function_privilege(
            ${appRole}, ${exactRuntimeFunction}::regprocedure, 'EXECUTE'
          ) AS "exactRuntimeExecute",
          has_function_privilege(
            ${appRole}, ${operatorOnlyFunction}::regprocedure, 'EXECUTE'
          ) AS "operatorOnlyExecute",
          has_function_privilege(
            ${appRole}, ${triggerOnlyFunction}::regprocedure, 'EXECUTE'
          ) AS "triggerOnlyExecute"`;
      expect(converged).toEqual({
        defaultExecute: false,
        existingExecute: false,
        newExecute: false,
        exactRuntimeExecute: true,
        operatorOnlyExecute: false,
        triggerOnlyExecute: false,
      });

      const [afterCreate] = await admin<{ newExecute: boolean }[]>`
        SELECT has_function_privilege(
          ${appRole}, ${newProbe}::regprocedure, 'EXECUTE'
        ) AS "newExecute"`;
      expect(afterCreate).toEqual({ newExecute: false });

      // Exercise the exact regrant as the restricted runtime role, not only
      // through pg_catalog's privilege predicate. A max:1 direct client keeps
      // every query on the authenticated runtime connection.
      const runtimeUrl = new URL(blank.databaseUrl);
      runtimeUrl.username = appRole;
      runtimeUrl.password = appPassword;
      const runtime = postgres(runtimeUrl.toString(), { max: 1, prepare: false });
      try {
        const rows = await runtime.unsafe(
          "SELECT * FROM opengeni_private.claim_session_workflow_wakes(1)",
        );
        expect(rows).toHaveLength(0);

        let denied: unknown;
        try {
          await runtime.unsafe(`SELECT * FROM ${existingProbe}`);
        } catch (error) {
          denied = error;
        }
        expect(denied).toBeInstanceOf(Error);
        expect((denied as Error).message).toMatch(
          /permission denied for function acl_convergence_existing_probe/,
        );

        const allowed = await runtime.unsafe(
          "SELECT * FROM opengeni_private.claim_session_workflow_wakes(1)",
        );
        expect(allowed).toHaveLength(0);
      } finally {
        await runtime.end();
      }
    } finally {
      await admin
        .unsafe(`DROP OWNED BY ${roleIdentifier}; DROP ROLE IF EXISTS ${roleIdentifier}`)
        .catch(() => undefined);
      await admin.end();
    }
  }, 300_000);

  test("provisions the enabled v2 role for the complete serving posture", async () => {
    if (!available || !blank) return;

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const legacyRole = `og_v2_legacy_${suffix}`;
    const governanceRole = `og_v2_${suffix}`;
    const governancePassword = `og-v2-${suffix}`;
    const legacyIdentifier = quoteIdentifier(legacyRole);
    const governanceIdentifier = quoteIdentifier(governanceRole);
    await provisionRoles(blank.databaseUrl, {
      rlsStrategy: "force",
      appRole: legacyRole,
      appPassword: `${appPassword}-legacy`,
      organizationGovernanceRole: governanceRole,
      organizationGovernancePassword: governancePassword,
    });

    const governanceUrl = new URL(blank.databaseUrl);
    governanceUrl.username = governanceRole;
    governanceUrl.password = governancePassword;
    const governanceDb = createDb(governanceUrl.toString());
    try {
      const posture = await assertRuntimeDatabasePosture(governanceDb.db, {
        rlsStrategy: "force",
        expectedRole: governanceRole,
        targetSchema: "public",
        protectedTables: ENABLED_V2_PROTECTED_TABLES,
        tablePrivileges: ENABLED_V2_TABLE_PRIVILEGES,
        protectedNoDirectDmlTables: ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES,
      });
      expect(posture.tables.find((table) => table.name === "sessions")).toMatchObject({
        select: true,
        insert: true,
        update: true,
        delete: true,
        rlsEnabled: true,
        rlsForced: true,
        rlsActive: true,
      });
    } finally {
      await governanceDb.close();
      const admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
      try {
        await admin.unsafe(
          `DROP OWNED BY ${governanceIdentifier}; DROP ROLE IF EXISTS ${governanceIdentifier}; DROP OWNED BY ${legacyIdentifier}; DROP ROLE IF EXISTS ${legacyIdentifier}`,
        );
      } finally {
        await admin.end();
      }
    }
  }, 300_000);
});
