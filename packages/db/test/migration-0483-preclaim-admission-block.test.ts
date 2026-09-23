import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { nestedPostgresSqlState } from "../src/persistence-errors";
import { migrate } from "../src/migrate";

const migration = await Bun.file(
  new URL("../drizzle/0483_preclaim_admission_block.sql", import.meta.url),
).text();
const membershipSelection = migration.split("$selection$")[1]!;
const grantRejection = migration.split("$rejection$")[1]!;
const installer = migration.slice(
  migration.indexOf("CREATE FUNCTION pg_temp.install_typed_admission_causes()"),
);
const wrappedMembership =
  "      BEGIN\n" +
  membershipSelection +
  "\n" +
  "      EXCEPTION WHEN no_data_found THEN\n" +
  "        RAISE EXCEPTION 'personal-resource initiating membership required' USING ERRCODE = 'OG001';\n" +
  "      END;";

test("0483 is an additive gate with narrow source-asserted causes, never authority repair", async () => {
  expect(migration).toStartWith("-- deployment-mode: rolling");
  expect(migration).toContain("(admission_block->'fence') - ARRAY");
  const original = await Bun.file(
    new URL("../drizzle/0253_common_user_resource_authority_lifecycle.sql", import.meta.url),
  ).text();
  expect(original).toContain(membershipSelection);
  expect(original).toContain(grantRejection);
  expect(migration).not.toContain("UPDATE organization_memberships");
  expect(migration).not.toContain("INSERT INTO organization_user_resource_grants");
  expect(migration).not.toContain("NO FORCE ROW LEVEL SECURITY");
});

describe("0483 production-owner guard installation", () => {
  let owned: OwnerMigratedTestDatabase;
  let owner: postgres.Sql;
  beforeAll(async () => {
    const acquired = await acquireOwnerMigratedTestDatabase("migration-0483-owner");
    if (!acquired) throw new Error("Real PostgreSQL required for admission migration tests");
    owned = acquired;
    await migrate(owned.ownerUrl);
    owner = postgres(owned.ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
  }, 900_000);
  afterAll(async () => {
    await owner?.end({ timeout: 5 });
    await owned?.release();
  }, 180_000);

  const inspect = () => owner`
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig,
      pg_get_functiondef(p.oid) as definition
    from pg_proc p where p.oid = 'admit_session_attempt_personal_resources()'::regprocedure`;

  test("changes only the two reviewed guards and preserves function posture", async () => {
    const [role] =
      await owned.admin`select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [after] = await inspect();
    expect(after!.prosecdef).toBe(true);
    expect(after!.definition).toContain(wrappedMembership);
    expect(after!.definition).toContain(grantRejection.replace("'42501'", "'OG002'"));
    const priorDefinition = after!.definition
      .replace(wrappedMembership, membershipSelection)
      .replace(grantRejection.replace("'42501'", "'OG002'"), grantRejection);
    const rollback = new Error("rollback isolated guard reinstall test");
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(priorDefinition);
        await tx.unsafe(installer);
        const [installed] = await tx`select p.oid, p.proowner, p.proacl, p.prosecdef, p.proconfig,
          pg_get_functiondef(p.oid) as definition from pg_proc p
          where p.oid = 'admit_session_attempt_personal_resources()'::regprocedure`;
        expect(installed).toEqual(after);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect((await inspect())[0]).toEqual(after);
  });

  test("unexpected guard source fails closed without changing function or privileges", async () => {
    const [before] = await inspect();
    let failure: unknown;
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(installer);
      });
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    expect((await inspect())[0]).toEqual(before);
    const [guard] =
      await owner`select p.prosecdef, p.proconfig, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid='session_turn_attempts'::regclass and t.tgname='session_attempt_admission_block'`;
    expect(guard!.prosecdef).toBe(false);
    expect(guard!.definition).toContain("BEFORE INSERT ON");
    expect(guard!.definition).toContain("guard_session_admission_block()");
  });
});
