import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, type DbClient } from "../src/database";
import { inspectRuntimeDatabasePosture } from "../src/runtime-posture";

// The readiness table inventory reports, per table, which of SELECT, INSERT,
// UPDATE and REFERENCES the runtime role holds on the table or on any column.
// These tests pin that answer to PostgreSQL's own has_any_column_privilege.

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let driver: postgres.Sql;
let tableQuery: { text: string; params: unknown[] } | null = null;
const options = { rlsStrategy: "force" as const, targetSchema: "og_data" };
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");
const schemas = [options.targetSchema, "opengeni_private"];

// Each probe table has columns a, b and c, and the runtime role starts with no
// table-level privilege on it.
const cases: { name: string; grants: string[]; expected: string[] }[] = [
  { name: "none", grants: [], expected: [] },
  { name: "col_select", grants: ["grant select (a) on {t} to opengeni_app"], expected: ["SELECT"] },
  {
    name: "col_update_refs",
    grants: [
      "grant update (b) on {t} to opengeni_app",
      "grant references (a) on {t} to opengeni_app",
    ],
    expected: ["UPDATE", "REFERENCES"],
  },
  { name: "col_public", grants: ["grant insert (c) on {t} to public"], expected: ["INSERT"] },
  {
    name: "col_grant_option",
    grants: ["grant select (b) on {t} to opengeni_app with grant option"],
    expected: ["SELECT"],
  },
  {
    name: "col_other_role",
    grants: ["grant select (a), update (b) on {t} to pg_read_all_stats"],
    expected: [],
  },
  {
    name: "col_dropped",
    grants: ["grant select (c) on {t} to opengeni_app", "alter table {t} drop column c"],
    expected: [],
  },
  {
    name: "col_revoked",
    grants: [
      "grant update (a) on {t} to opengeni_app",
      "revoke update (a) on {t} from opengeni_app",
    ],
    expected: [],
  },
  {
    name: "table_refs",
    grants: ["grant references on {t} to opengeni_app"],
    expected: ["REFERENCES"],
  },
  {
    name: "table_and_col",
    grants: [
      "grant select on {t} to opengeni_app",
      "grant select (a), update (a) on {t} to opengeni_app",
    ],
    expected: ["SELECT", "UPDATE"],
  },
];

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  fixture = await acquireRestrictedRuntimeTestDatabase("posture-column-privileges", options.targetSchema);
  if (!fixture) throw new Error("Real PostgreSQL required");
  for (const schema of schemas) {
    for (const item of cases) {
      const table = `${schema}.col_probe_${item.name}`;
      await fixture.admin.unsafe(
        `create table ${table} (a int, b int, c int); alter table ${table} owner to "${fixture.ownerRole}"; revoke all on ${table} from opengeni_app, public`,
      );
      for (const grant of item.grants) await fixture.admin.unsafe(grant.replaceAll("{t}", table));
    }
  }
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  driver.options.debug = (_connection, text, params) => {
    if (text.includes("row_security_active(c.oid)")) tableQuery = { text, params: [...params] };
  };
  await inspectRuntimeDatabasePosture(client.db, options);
  driver.options.debug = false;
  expect(tableQuery).not.toBeNull();
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

const columnAclJoin =
  /left join \(\s+select attrelid, array_agg\(attnum\) as attnums\s+from pg_attribute\s+where attnum > 0 and not attisdropped and attacl is not null\s+group by attrelid\s+\) column_acls on column_acls\.attrelid = c\.oid/;
const columnCheck =
  /WHERE has_table_privilege\(current_user, c\.oid, privilege\)\s+OR EXISTS \(SELECT 1 FROM unnest\(column_acls\.attnums\) attnum\s+WHERE has_column_privilege\(current_user, c\.oid, attnum, privilege\)\)\)/;

/** The inventory query with PostgreSQL's built-in column check restored. */
function referenceSql(text: string): string {
  expect(columnAclJoin.test(text)).toBe(true);
  expect(columnCheck.test(text)).toBe(true);
  return text
    .replace(columnAclJoin, "")
    .replace(columnCheck, "WHERE has_any_column_privilege(current_user, c.oid, privilege))");
}

/** A weakened inventory that ignores column-level grants. */
function tableOnlySql(text: string): string {
  return text
    .replace(columnAclJoin, "")
    .replace(columnCheck, "WHERE has_table_privilege(current_user, c.oid, privilege))");
}

const canonical = (rows: postgres.Row[]) =>
  [...rows].sort((a, b) =>
    `${a.private_schema}.${a.name}`.localeCompare(`${b.private_schema}.${b.name}`),
  );

async function run(tx: postgres.TransactionSql, text: string) {
  return canonical(await tx.unsafe(text, tableQuery!.params as never[]));
}

realTest("every table row matches has_any_column_privilege with either planner mode", async () => {
  await driver.begin("isolation level repeatable read read only", async (tx) => {
    const reference = await run(tx, referenceSql(tableQuery!.text));
    expect(reference.length).toBeGreaterThan(cases.length * schemas.length);
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await tx.unsafe(`set local plan_cache_mode=${mode}`);
      for (const hashagg of ["on", "off"]) {
        await tx.unsafe(`set local enable_hashagg=${hashagg}`);
        expect(await run(tx, tableQuery!.text)).toEqual(reference);
      }
    }
  });
});

realTest("column-level grants are reported exactly as PostgreSQL resolves them", async () => {
  const posture = await inspectRuntimeDatabasePosture(client!.db, options);
  for (const tables of [posture.tables, posture.privateTables]) {
    for (const item of cases) {
      const matches = tables.filter((table) => table.name === `col_probe_${item.name}`);
      expect(matches).toHaveLength(1);
      expect({ name: item.name, columns: matches[0]!.columnPrivileges }).toEqual({
        name: item.name,
        columns: item.expected,
      });
    }
  }
  // These cases would pass unnoticed if the inventory only read table-level
  // privileges, so they prove the column branch is still checked.
  await driver.begin("isolation level repeatable read read only", async (tx) => {
    const weakened = await run(tx, tableOnlySql(tableQuery!.text));
    const current = await run(tx, tableQuery!.text);
    const differs = (name: string) => {
      const pick = (rows: postgres.Row[]) =>
        rows.filter((row) => row.name === name).map((row) => row.column_privileges);
      return JSON.stringify(pick(weakened)) !== JSON.stringify(pick(current));
    };
    for (const name of [
      "col_probe_col_select",
      "col_probe_col_update_refs",
      "col_probe_col_public",
      "col_probe_col_grant_option",
      "col_probe_table_and_col",
    ]) {
      expect({ name, differs: differs(name) }).toEqual({ name, differs: true });
    }
  });
});

realTest("a later column grant or revoke is seen by the next inspection", async () => {
  for (const schema of schemas) {
    await fixture!.admin.unsafe(
      `create table ${schema}.col_probe_later (a int, b int); alter table ${schema}.col_probe_later owner to "${fixture!.ownerRole}"; revoke all on ${schema}.col_probe_later from opengeni_app, public`,
    );
  }
  const later = async () => {
    const posture = await inspectRuntimeDatabasePosture(client!.db, options);
    return [posture.tables, posture.privateTables].map(
      (tables) => tables.find((table) => table.name === "col_probe_later")!.columnPrivileges,
    );
  };
  expect(await later()).toEqual([[], []]);
  for (const schema of schemas) {
    await fixture!.admin.unsafe(`grant references (b) on ${schema}.col_probe_later to opengeni_app`);
  }
  expect(await later()).toEqual([["REFERENCES"], ["REFERENCES"]]);
  for (const schema of schemas) {
    await fixture!.admin.unsafe(`revoke references (b) on ${schema}.col_probe_later from opengeni_app`);
  }
  expect(await later()).toEqual([[], []]);
  await driver.begin("isolation level repeatable read read only", async (tx) => {
    expect(await run(tx, tableQuery!.text)).toEqual(await run(tx, referenceSql(tableQuery!.text)));
  });
});
