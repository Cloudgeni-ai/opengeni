import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, dbSql, type DbClient } from "../src";
import {
  createRuntimeDatabaseCatalogPostureCache,
  inspectRuntimeDatabasePosture,
  type RuntimeDatabaseCatalogPostureCache,
  type RuntimeDatabasePosture,
} from "../src/runtime-posture";

// Readiness probes run the posture inspection every few seconds. With a
// catalog cache, the catalog queries run again only when the catalogs they
// read changed; every answer must equal a fresh uncached inspection.

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let driver: postgres.Sql;
const options = { rlsStrategy: "force" as const, targetSchema: "og_data" };
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  fixture = await acquireRestrictedRuntimeTestDatabase(
    "posture-catalog-cache",
    options.targetSchema,
  );
  if (!fixture) throw new Error("Real PostgreSQL is required for the posture catalog cache");
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function probe(cache: RuntimeDatabaseCatalogPostureCache) {
  const statements: string[] = [];
  const originalDebug = driver.options.debug;
  driver.options.debug = (_connection, query) => statements.push(query);
  try {
    const posture = await inspectRuntimeDatabasePosture(client!.db, options, cache);
    return {
      posture,
      catalogQueries: statements.filter((query) =>
        CATALOG_QUERY_MARKERS.some((marker) => query.includes(marker)),
      ).length,
      readCatalogs: statements.some((query) => query.includes("row_security_active(c.oid)")),
    };
  } finally {
    driver.options.debug = originalDebug;
  }
}

// One distinctive fragment of each standalone catalog query.
const CATALOG_QUERY_MARKERS = [
  "inherited_roles",
  "has_schema_privilege(current_user, n.oid, 'CREATE') as create",
  "join pg_roles r on r.oid = n.nspowner",
  "join pg_roles r on r.oid = c.relowner",
  "row_security_active(c.oid)",
  "as trigger_callable",
  "opengeni_subscription_internal",
];

async function uncached(): Promise<RuntimeDatabasePosture> {
  return await inspectRuntimeDatabasePosture(client!.db, options);
}

realTest(
  "an unchanged catalog is read once and every probe answers like a fresh inspection",
  async () => {
    const cache = createRuntimeDatabaseCatalogPostureCache();
    const first = await probe(cache);
    expect(first.readCatalogs).toBe(true);
    expect(first.catalogQueries).toBe(CATALOG_QUERY_MARKERS.length);
    expect(first.posture.tables.length).toBeGreaterThan(0);
    expect(first.posture.privateRoutines.length).toBeGreaterThan(0);
    expect(first.posture).toEqual(await uncached());

    const second = await probe(cache);
    expect(second.readCatalogs).toBe(false);
    expect(second.catalogQueries).toBe(0);
    expect(second.posture).toEqual(await uncached());

    // A caller changing its answer does not change the next one.
    second.posture.tables.length = 0;
    second.posture.privateRoutines[0]!.execute = !second.posture.privateRoutines[0]!.execute;
    const third = await probe(cache);
    expect(third.readCatalogs).toBe(false);
    expect(third.posture).toEqual(await uncached());
  },
);

realTest(
  "each kind of catalog change the posture depends on is seen by the next probe",
  async () => {
    const admin = fixture!.admin;
    // Roles are cluster-wide: name this run's role uniquely.
    const role = `cache_probe_${crypto.randomUUID().replaceAll("-", "")}`;
    const cache = createRuntimeDatabaseCatalogPostureCache();
    const baseline = (await probe(cache)).posture;
    // Each step changes the posture through a different catalog: the cached
    // probe must notice it and answer exactly like a fresh inspection.
    const steps: { name: string; sql: string }[] = [
      {
        name: "new relation, routine, domain and role",
        sql: `create table og_data.cache_probe (a int, b int);
          create function og_data.cache_probe_fn() returns int language sql as 'select 1';
          create domain og_data.cache_probe_d as int;
          create function og_data.cache_probe_typed(og_data.cache_probe_d) returns int language sql as 'select 1';
          create role ${role} nologin`,
      },
      { name: "table grant", sql: "grant select on og_data.cache_probe to opengeni_app" },
      { name: "column grant", sql: "grant update (b) on og_data.cache_probe to opengeni_app" },
      {
        name: "row level security",
        sql: "alter table og_data.cache_probe enable row level security",
      },
      {
        name: "policy",
        sql: "create policy cache_probe_policy on og_data.cache_probe using (true)",
      },
      {
        name: "routine grant",
        sql: "revoke execute on function og_data.cache_probe_fn() from public",
      },
      {
        name: "routine dependent",
        sql: "create view og_data.cache_probe_view as select og_data.cache_probe_fn() as one",
      },
      {
        name: "inheritance",
        sql: "create table og_data.cache_probe_child () inherits (og_data.cache_probe)",
      },
      { name: "role membership", sql: `grant ${role} to opengeni_app` },
      {
        name: "routine owner",
        sql: `alter function og_data.cache_probe_fn() owner to ${role}`,
      },
      { name: "role rename", sql: `alter role ${role} rename to ${role}_renamed` },
      { name: "schema grant", sql: "grant create on schema og_data to opengeni_app" },
      {
        name: "type rename",
        sql: "alter domain og_data.cache_probe_d rename to cache_probe_renamed",
      },
      { name: "schema revoke", sql: "revoke create on schema og_data from opengeni_app" },
    ];
    let previous = baseline;
    try {
      for (const step of steps) {
        await admin.unsafe(step.sql);
        const next = await probe(cache);
        expect({ step: step.name, readCatalogs: next.readCatalogs }).toEqual({
          step: step.name,
          readCatalogs: true,
        });
        expect(next.posture).not.toEqual(previous);
        expect(next.posture).toEqual(await uncached());
        const unchanged = await probe(cache);
        expect(unchanged.readCatalogs).toBe(false);
        expect(unchanged.posture).toEqual(next.posture);
        previous = next.posture;
      }

      // The row security setting decides which tables RLS is active on.
      await client!.db.execute(dbSql`set row_security = off`);
      const rowSecurityOff = await probe(cache);
      expect(rowSecurityOff.readCatalogs).toBe(true);
      expect(rowSecurityOff.posture).toEqual(await uncached());
      await client!.db.execute(dbSql`reset row_security`);
      expect((await probe(cache)).readCatalogs).toBe(true);
    } finally {
      await client!.db.execute(dbSql`reset row_security`);
      await admin.unsafe(`
        drop view if exists og_data.cache_probe_view;
        drop table if exists og_data.cache_probe_child;
        drop table if exists og_data.cache_probe;
        drop function if exists og_data.cache_probe_typed(og_data.cache_probe_renamed);
        drop function if exists og_data.cache_probe_fn();
        drop domain if exists og_data.cache_probe_renamed;
        revoke create on schema og_data from opengeni_app;
        drop role if exists ${role};
        drop role if exists ${role}_renamed;
      `);
    }
    const restored = await probe(cache);
    expect(restored.readCatalogs).toBe(true);
    expect(restored.posture).toEqual(baseline);
    expect(restored.posture).toEqual(await uncached());
  },
  180_000,
);

realTest(
  "objects of another schema that come into scope are seen by the next probe",
  async () => {
    const admin = fixture!.admin;
    await admin.unsafe("create schema cache_probe_other");
    const cache = createRuntimeDatabaseCatalogPostureCache();
    expect((await probe(cache)).readCatalogs).toBe(true);
    try {
      await admin.unsafe(`
        create table cache_probe_other.cache_probe_moved (a int primary key, b text);
        create index on cache_probe_other.cache_probe_moved (b);
        create table cache_probe_other.cache_probe_child () inherits (cache_probe_other.cache_probe_moved);
        grant select, update (b) on cache_probe_other.cache_probe_moved to opengeni_app;
        create function cache_probe_other.cache_probe_fn() returns int language sql as 'select 1';
        create policy cache_probe_policy on cache_probe_other.cache_probe_moved using (true);
      `);
      const unrelated = await probe(cache);
      expect(unrelated.posture).toEqual(await uncached());
      expect((await probe(cache)).readCatalogs).toBe(false);

      // A relation given to the runtime role is in scope through its owner.
      await admin.unsafe("alter table cache_probe_other.cache_probe_moved owner to opengeni_app");
      const owned = await probe(cache);
      expect(owned.readCatalogs).toBe(true);
      expect(owned.posture.ownedRelations).toContain("cache_probe_other.cache_probe_moved");
      expect(owned.posture).toEqual(await uncached());

      // A relation moved into the data schema is in scope through its schema.
      await admin.unsafe(`
        alter table cache_probe_other.cache_probe_moved owner to current_user;
        alter table cache_probe_other.cache_probe_moved set schema og_data;
      `);
      const moved = await probe(cache);
      expect(moved.readCatalogs).toBe(true);
      expect(moved.posture.tables.map((table) => table.name)).toContain("cache_probe_moved");
      expect(moved.posture).toEqual(await uncached());
      expect((await probe(cache)).readCatalogs).toBe(false);
    } finally {
      await admin.unsafe(`
        drop schema cache_probe_other cascade;
        drop table if exists og_data.cache_probe_moved cascade;
      `);
    }
  },
  180_000,
);
