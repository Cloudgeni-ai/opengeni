import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, type DbClient } from "../src/database";
import { inspectRuntimeDatabasePosture } from "../src/runtime-posture";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let driver: postgres.Sql;
const queries = new Map<string, { text: string; params: unknown[] }>();
const options = { rlsStrategy: "force" as const, targetSchema: "og_data" };
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  fixture = await acquireRestrictedRuntimeTestDatabase("posture-public-acl", options.targetSchema);
  if (!fixture) throw new Error("Real PostgreSQL required");
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  driver.options.debug = (_connection, text, params) => {
    if (text.includes("as trigger_callable"))
      queries.set("routines", { text, params: [...params] });
    if (text.includes("where n.nspname = 'opengeni_subscription_internal'")) {
      queries.set("subscription", { text, params: [...params] });
    }
  };
  await inspectRuntimeDatabasePosture(client.db, options);
  driver.options.debug = false;
  expect([...queries.keys()].sort()).toEqual(["routines", "subscription"]);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

function referenceSql(text: string): string {
  const join =
    /left join lateral \(\s+select true as public_execute\s+from aclexplode\(coalesce\(p.proacl, acldefault\('f', p.proowner\)\)\) acl\s+where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'\s+limit 1\s+\) public_acl on true/;
  expect(join.test(text)).toBe(true);
  expect(text).toContain("coalesce(public_acl.public_execute, false)");
  // The former correlated EXISTS reads the same pg_proc tuple. In particular,
  // has_function_privilege('public', ...) is NOT a snapshot-equivalent oracle.
  return text
    .replace(join, "")
    .replace(
      "coalesce(public_acl.public_execute, false)",
      "exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE')",
    );
}

const canonical = (rows: postgres.Row[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name));

async function assertParity(tx: postgres.TransactionSql) {
  for (const query of queries.values()) {
    const actual = await tx.unsafe(query.text, query.params as never[]);
    const reference = await tx.unsafe(referenceSql(query.text), query.params as never[]);
    expect(canonical(actual)).toEqual(canonical(reference));
  }
}

realTest(
  "complete routine projections match the original ACL subquery with either planner mode",
  async () => {
    await driver.begin("isolation level repeatable read read only", async (tx) => {
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        await tx.unsafe(`set local plan_cache_mode=${mode}`);
        for (const enabled of ["on", "off"]) {
          await tx.unsafe(`set local enable_memoize=${enabled}`);
          await assertParity(tx);
        }
      }
    });
  },
);

realTest(
  "PUBLIC remains distinct from owner/runtime grants, empty/default ACLs, and overloads",
  async () => {
    const schemas = [options.targetSchema, "opengeni_private", "opengeni_subscription_internal"];
    const cases = [
      { name: "default", expected: true, grant: "" },
      { name: "revoked", expected: false, grant: "" },
      { name: "empty", expected: false, grant: "empty" },
      { name: "public", expected: true, grant: "public" },
      { name: "runtime", expected: false, grant: "opengeni_app" },
      { name: "grant_option", expected: false, grant: "opengeni_app with grant option" },
    ];
    for (const schema of schemas) {
      for (const item of cases) {
        const signature = `${schema}.acl_probe_${item.name}()`;
        await fixture!.admin.unsafe(
          `create function ${signature} returns int language sql as 'select 1'; alter function ${signature} owner to "${fixture!.ownerRole}"`,
        );
        if (item.name !== "default")
          await fixture!.admin.unsafe(`revoke all on function ${signature} from public`);
        if (item.grant === "empty")
          await fixture!.admin.unsafe(
            `revoke all on function ${signature} from "${fixture!.ownerRole}"`,
          );
        else if (item.grant)
          await fixture!.admin.unsafe(`grant execute on function ${signature} to ${item.grant}`);
      }
      await fixture!.admin.unsafe(
        `create function ${schema}.acl_probe_public(integer) returns int language sql as 'select 1'; revoke all on function ${schema}.acl_probe_public(integer) from public`,
      );
      if (schema !== "opengeni_subscription_internal") {
        await fixture!.admin.unsafe(
          `create procedure ${schema}.acl_probe_procedure() language sql as 'select 1'; revoke all on procedure ${schema}.acl_probe_procedure() from public`,
        );
      }
    }
    const aclShapes = await fixture!.admin<
      { schema: string; name: string; is_null: boolean; entries: number | null }[]
    >`
      select n.nspname as schema, p.proname as name, p.proacl is null as is_null,
        cardinality(p.proacl) as entries
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=any(${schemas}) and p.proname in ('acl_probe_default','acl_probe_empty')
    `;
    expect(aclShapes).toHaveLength(6);
    for (const row of aclShapes) {
      expect(row.is_null).toBe(row.name === "acl_probe_default");
      expect(row.entries).toBe(row.name === "acl_probe_default" ? null : 0);
    }
    const posture = await inspectRuntimeDatabasePosture(client!.db, options);
    for (const routines of [
      posture.targetRoutines,
      posture.privateRoutines,
      posture.subscriptionOwnerRoutines!,
    ]) {
      for (const item of cases) {
        const matches = routines.filter((r) => r.name === `acl_probe_${item.name}()`);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.publicExecute).toBe(item.expected);
      }
      expect(routines.find((r) => r.name === "acl_probe_public(integer)")!.publicExecute).toBe(
        false,
      );
    }
    for (const routines of [posture.targetRoutines, posture.privateRoutines]) {
      expect(routines.find((r) => r.name === "acl_probe_procedure()")!.publicExecute).toBe(false);
    }
    await driver.begin("isolation level repeatable read read only", assertParity);
  },
);

realTest(
  "concurrent grants and revokes preserve the catalog snapshot, then refresh on the next inspection",
  async () => {
    for (const schema of [
      options.targetSchema,
      "opengeni_private",
      "opengeni_subscription_internal",
    ]) {
      const signature = `${schema}.acl_probe_snapshot()`;
      await fixture!.admin.unsafe(
        `create function ${signature} returns int language sql as 'select 1'; revoke all on function ${signature} from public`,
      );
    }
    const snapshotPublic = async (tx: postgres.TransactionSql) => {
      const results: boolean[] = [];
      for (const query of queries.values()) {
        const rows = await tx.unsafe(query.text, query.params as never[]);
        results.push(
          ...rows
            .filter((r) => r.name === "acl_probe_snapshot()")
            .map((r) => r.public_execute ?? r.publicExecute),
        );
      }
      return results;
    };
    for (const grant of [true, false]) {
      await driver.begin("isolation level repeatable read read only", async (tx) => {
        expect(await snapshotPublic(tx)).toEqual([!grant, !grant, !grant]);
        for (const schema of [
          options.targetSchema,
          "opengeni_private",
          "opengeni_subscription_internal",
        ]) {
          await fixture!.admin.unsafe(
            `${grant ? "grant execute" : "revoke execute"} on function ${schema}.acl_probe_snapshot() ${grant ? "to" : "from"} public`,
          );
        }
        expect(await snapshotPublic(tx)).toEqual([!grant, !grant, !grant]);
        await assertParity(tx);
      });
      const posture = await inspectRuntimeDatabasePosture(client!.db, options);
      for (const routines of [
        posture.targetRoutines,
        posture.privateRoutines,
        posture.subscriptionOwnerRoutines!,
      ]) {
        expect(routines.find((r) => r.name === "acl_probe_snapshot()")!.publicExecute).toBe(grant);
      }
    }
  },
);
