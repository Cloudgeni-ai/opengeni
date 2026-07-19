import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const claimFunction = "opengeni_private.claim_session_workflow_wakes(integer)";
const unrelatedFunction = "opengeni_private.ope75_unrelated_acl_probe()";

let blank: BlankTestDatabase | null = null;
let available = true;

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0067-workflow-wake-acl");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0067-workflow-wake-acl] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0067 (workflow-wake claimer ACL)", () => {
  test("a clean chain grants only the exact function to a pre-existing restricted runtime role", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const [role] = await admin<
        Array<{ rolsuper: boolean; rolbypassrls: boolean; membershipCount: number }>
      >`
        select role.rolsuper, role.rolbypassrls,
          count(membership.roleid)::integer as "membershipCount"
        from pg_roles role
        left join pg_auth_members membership on membership.member = role.oid
        where role.rolname = 'opengeni_app'
        group by role.oid, role.rolsuper, role.rolbypassrls`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, membershipCount: 0 });

      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql") && file <= "0067_session_workflow_wake_acl.sql")
        .sort();
      expect(files.at(-1)).toBe("0067_session_workflow_wake_acl.sql");

      for (const file of files) {
        await applyFile(admin, file);
        if (file === "0001_workspace_auth_billing.sql") {
          // The shared migrated template and provisionRoles intentionally grant
          // every private function, so this pristine database uses neither.
          // Create a denied sentinel after 0001's historical blanket grant;
          // later migrations must not accidentally grant it to the app role.
          await admin.unsafe(`
            CREATE FUNCTION opengeni_private.ope75_unrelated_acl_probe()
            RETURNS integer LANGUAGE sql AS 'SELECT 1';
            REVOKE ALL ON FUNCTION opengeni_private.ope75_unrelated_acl_probe() FROM PUBLIC;
          `);
        }
      }

      const [privileges] = await admin<
        Array<{
          claimExecute: boolean;
          unrelatedExecute: boolean;
          publicClaimExecute: boolean;
        }>
      >`
        select
          has_function_privilege(
            'opengeni_app', ${claimFunction}::regprocedure, 'EXECUTE'
          ) as "claimExecute",
          has_function_privilege(
            'opengeni_app', ${unrelatedFunction}::regprocedure, 'EXECUTE'
          ) as "unrelatedExecute",
          coalesce(bool_or(
            acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ), false) as "publicClaimExecute"
        from pg_proc proc
        cross join lateral aclexplode(
          coalesce(proc.proacl, acldefault('f', proc.proowner))
        ) acl
        where proc.oid = ${claimFunction}::regprocedure
        group by proc.oid`;
      expect(privileges).toEqual({
        claimExecute: true,
        unrelatedExecute: false,
        publicClaimExecute: false,
      });

      await admin.unsafe("SET ROLE opengeni_app");
      try {
        const claimed = await admin.unsafe(
          "SELECT * FROM opengeni_private.claim_session_workflow_wakes(1)",
        );
        expect(claimed).toHaveLength(0);
        await expect(admin.unsafe(`SELECT ${unrelatedFunction}`)).rejects.toThrow(
          /permission denied for function ope75_unrelated_acl_probe/,
        );
      } finally {
        await admin.unsafe("RESET ROLE");
      }
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
