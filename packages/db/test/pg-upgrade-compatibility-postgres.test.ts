import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";

// pg_upgrade refuses a cluster whose user tables store any of these types,
// directly or through an array, domain or composite type: they hold catalog
// OIDs that a new major version assigns afresh. regclass, regrole and regtype
// are allowed because pg_upgrade preserves those OIDs. Keep this list in step
// with pg_upgrade's "reg* data types in user tables" check.
const OID_BOUND_TYPES = [
  "regcollation",
  "regconfig",
  "regdictionary",
  "regnamespace",
  "regoper",
  "regoperator",
  "regproc",
  "regprocedure",
];

let shared: RestrictedRuntimeTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("pg-upgrade-compatibility");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("PostgreSQL required");
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

test("the migrated schema stores no type that blocks pg_upgrade", async () => {
  if (!shared) return;
  const columns = await shared.admin<Array<{ column: string; type: string }>>`
    with recursive blocked(oid) as (
      select type.oid
      from pg_catalog.pg_type type
      where type.typnamespace = 'pg_catalog'::pg_catalog.regnamespace
        and type.typname = any(${OID_BOUND_TYPES})
      union
      select type.oid
      from blocked
      join pg_catalog.pg_type type on
        (type.typtype = 'd' and type.typbasetype = blocked.oid)
        or (type.typcategory = 'A' and type.typelem = blocked.oid)
        or (type.typtype = 'c' and exists (
          select 1 from pg_catalog.pg_attribute member
          where member.attrelid = type.typrelid
            and member.attnum > 0
            and not member.attisdropped
            and member.atttypid = blocked.oid
        ))
    )
    select pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname)
        as "column",
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind in ('r', 'm', 'p')
      and namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_toast'
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.atttypid in (select oid from blocked)
    order by 1`;
  expect(Array.from(columns)).toEqual([]);
});

test("the session tenancy fence registry names its bound schema", async () => {
  if (!shared) return;
  const [registry] = await shared.admin<Array<{ target: string; type: string }>>`
    select registry.target_schema::text as target,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type
    from opengeni_private.session_tenancy_fence_target_registry registry
    join pg_catalog.pg_attribute attribute on
      attribute.attrelid = 'opengeni_private.session_tenancy_fence_target_registry'::regclass
      and attribute.attname = 'target_schema'
    where registry.singleton`;
  expect(registry).toEqual({ target: shared.schema, type: "name" });

  // The registered schema still admits the fence's capability routines and an
  // unregistered one is still refused.
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${shared!.ownerRole}"`);
    const [opened] = await tx<Array<{ id: string }>>`
      select opengeni_private.open_session_tenancy_fence_inventory(
        ${shared!.schema}::pg_catalog.regnamespace::pg_catalog.oid
      )::text as id`;
    expect(opened?.id).toMatch(/^[0-9a-f-]{36}$/);
    await tx`select opengeni_private.close_session_tenancy_fence_inventory(${opened!.id}::uuid)`;
    const [access] = await tx<Array<{ id: string }>>`
      select opengeni_private.open_session_tenancy_fenced_access(
        ${shared!.schema}::pg_catalog.regnamespace::pg_catalog.oid
      )::text as id`;
    expect(access?.id).toMatch(/^[0-9a-f-]{36}$/);
    await tx`select opengeni_private.close_session_tenancy_fenced_access(${access!.id}::uuid)`;
    const refused = await tx
      .savepoint(
        (savepoint) => savepoint`
          select opengeni_private.open_session_tenancy_fence_inventory(
            'pg_catalog'::pg_catalog.regnamespace::pg_catalog.oid
          )`,
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "22023" });
  });
});
