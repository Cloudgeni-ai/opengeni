import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { nestedPostgresSqlState } from "../src";
import { migrate } from "../src/migrate";

const migration = await Bun.file(
  new URL("../drizzle/0430_session_personal_variable_set_continuations.sql", import.meta.url),
).text();
const oldSelection = "variable_set.id = session_row.variable_set_id";
const newSelection = migration.split("$selection$")[1]!;

test("0430 replaces only the two protocol-0 selected Variable Set predicates", () => {
  expect(migration).toStartWith("-- deployment-mode: rolling");
  expect(migration).toContain("<> 2 THEN");
  expect(migration).toContain("EXECUTE replace(function_definition, old_selection, new_selection)");
  expect(newSelection).toBe(
    "coalesce(session_row.variable_set_ids, '[]'::jsonb) ? variable_set.id::text",
  );
  expect(migration).not.toContain("CREATE TRIGGER");
  expect(migration).not.toContain("GRANT ");
  expect(migration).not.toContain("UPDATE organization_user_resource_grants");
});

describe("0430 production-owner function posture", () => {
  let owned: OwnerMigratedTestDatabase | null = null;
  let owner: postgres.Sql | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("migration-0430-owner");
    if (!owned) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
        throw new Error("[migration-0430] Docker PostgreSQL is required but unavailable");
      }
      return;
    }
    await migrate(owned.ownerUrl);
    owner = postgres(owned.ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await owner?.end({ timeout: 5 });
    await owned?.release();
  }, 180_000);

  test("preserves exact owner, ACL, search path, trigger and every non-selection byte", async () => {
    if (!owned || !owner) return;
    const [identity] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${owned.ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });
    const inspect = () => owner!`
      select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig,
        pg_get_functiondef(p.oid) as definition,
        (select jsonb_agg(pg_get_triggerdef(t.oid) order by t.oid)
          from pg_trigger t where t.tgfoid = p.oid) as triggers
      from pg_proc p
      where p.oid = 'admit_session_attempt_personal_resources()'::regprocedure`;
    const [after] = await inspect();
    expect(after!.prosecdef).toBe(true);
    expect(after!.definition.split(newSelection)).toHaveLength(3);
    const legacyDefinition = after!.definition.replaceAll(newSelection, oldSelection);
    // Roll back even if an assertion fails; this only exercises a disposable DB.
    const rollback = new Error("rollback test function replacement");
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(legacyDefinition);
        const [before] = await tx`
          select pg_get_functiondef('admit_session_attempt_personal_resources()'::regprocedure)
            as definition`;
        expect(before!.definition).toBe(legacyDefinition);
        await tx.unsafe(migration);
        const [updated] = await tx`
          select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig,
            pg_get_functiondef(p.oid) as definition,
            (select jsonb_agg(pg_get_triggerdef(t.oid) order by t.oid)
              from pg_trigger t where t.tgfoid = p.oid) as triggers
          from pg_proc p
          where p.oid = 'admit_session_attempt_personal_resources()'::regprocedure`;
        expect(updated).toEqual(after);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect((await inspect())[0]).toEqual(after);
  });

  test("refuses unexpected function source drift without changing the installed function", async () => {
    if (!owner) return;
    // The installed function has zero old predicates. Reapplying SQL directly
    // must fail closed; ordinary migrate() uses the ledger and never does this.
    let captured: unknown;
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(migration);
      });
    } catch (error) {
      captured = error;
    }
    expect(nestedPostgresSqlState(captured)).toBe("55000");
    const [current] = await owner`
      select pg_get_functiondef('admit_session_attempt_personal_resources()'::regprocedure)
        as definition`;
    expect(current!.definition.split(newSelection)).toHaveLength(3);
  });
});
