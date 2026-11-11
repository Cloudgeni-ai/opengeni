import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

let shared: SharedTestDatabase;
const sites: Array<{ name: string; column: string; expression: string; normalized: boolean }> = [];
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("indexed-inbox-lineage");
  if (!acquired) throw new Error("PostgreSQL fixture unavailable");
  shared = acquired;
  for (const [name, columns] of [
    ["opengeni_private.fence_mcp_account_bindings()", ["origin.id", "origin.session_id"]],
    ["opengeni_private.fence_inbox_execution_context()", ["t.id", "t.session_id"]],
    [
      "opengeni_subscription_internal.subscription_compat_delivery_sources(uuid,uuid,uuid,uuid,text)",
      ["causal.id"],
    ],
    [
      "opengeni_subscription_internal.subscription_compat_carrier_sources(text,uuid,uuid,bigint)",
      ["edited.id", "caller.id", "caller.session_id"],
    ],
  ] as const) {
    const [row] =
      await shared.admin`select pg_get_functiondef(${name}::regprocedure) as definition`;
    const definition = row!.definition as string;
    for (const column of columns) {
      const start = `${column} = CASE WHEN pg_catalog.octet_length((`;
      expect(definition.split(start)).toHaveLength(2);
      const tail = definition.split(start)[1]!;
      const value = tail.split(")) = 36 AND (")[0]!;
      const end = "::pg_catalog.uuid END";
      const expression = `CASE WHEN pg_catalog.octet_length((${tail.slice(0, tail.indexOf(end) + end.length)}`;
      // Exercise the exact installed guard with arbitrary lineage values, not
      // a separately implemented parser. All three occurrences must agree.
      expect(expression.split(value)).toHaveLength(4);
      sites.push({
        name,
        column,
        expression: expression.replaceAll(value, "value"),
        normalized: value.startsWith("lower("),
      });
    }
  }
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);

test("all installed guards preserve their previous text equality and normalization", async () => {
  const id = "abcdefab-1234-0000-ffff-0123456789ab";
  const values: unknown[] = [
    id,
    crypto.randomUUID(),
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    id.toUpperCase(),
    id.replaceAll("-", ""),
    `{${id}}`,
    ` ${id}`,
    `${id} `,
    `${id}\n`,
    `${id.slice(0, 35)}g`,
    id.replaceAll("-", "–"),
    "not-a-uuid",
    "",
    null,
    123,
    {},
    [],
    "g".repeat(36),
  ];
  for (let i = 0; i < 100; i++) {
    const random = crypto.randomUUID();
    values.push(random, random.toUpperCase(), random.replaceAll("-", ""));
  }
  for (const site of sites) {
    const rows = await shared.admin.unsafe(
      `
      select value, (${site.expression})::text as parsed,
        ($1::uuid::text = value) is true as old_match,
        ($1::uuid = (${site.expression})) is true as new_match
      from (select ${site.normalized ? "lower(document->>'id')" : "document->>'id'"} as value
        from jsonb_array_elements($2::text::jsonb) document) inputs`,
      [id, JSON.stringify([...values.map((value) => ({ id: value })), {}])],
    );
    expect(rows).toHaveLength(values.length + 1);
    for (const row of rows) {
      expect(row.new_match).toBe(row.old_match);
      const canonical =
        typeof row.value === "string" &&
        row.value.length === 36 &&
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.value);
      expect(row.parsed).toBe(canonical ? row.value : null);
    }
    expect(rows[4]!.new_match).toBe(site.normalized);
  }
});

test("installed fences retain later authority checks without adding routines", async () => {
  const rows = await shared.admin`select name, pg_get_functiondef(name::regprocedure) as definition
    from unnest(array['opengeni_private.fence_mcp_account_bindings()', 'opengeni_private.fence_inbox_execution_context()']) name`;
  const mcp = rows[0]!.definition as string;
  const inbox = rows[1]!.definition as string;
  for (const check of [
    "validate_mcp_account_bindings",
    "read_sender_connection",
    "connectionAuthorityGeneration",
  ])
    expect(mcp).toContain(check);
  for (const check of [
    "subscription_compat_delivery_sources",
    "external_link_turn_authorities",
    "credentialRestriction",
    "control input cannot borrow receiving execution context",
  ])
    expect(inbox).toContain(check);
  expect(sites).toHaveLength(8);
  const [row] =
    await shared.admin`select to_regprocedure('opengeni_private.canonical_uuid(text)') as helper`;
  expect(row!.helper).toBeNull();
});

test("every installed guard supports an indexed join and preserves tenant/session nonmatches", async () => {
  await shared.admin.begin(async (tx) => {
    await tx`create temporary table lineage_lookup_fixture (id uuid primary key, workspace_id uuid not null, session_id uuid not null) on commit drop`;
    const workspace = crypto.randomUUID(),
      session = crypto.randomUUID(),
      id = crypto.randomUUID();
    await tx`insert into lineage_lookup_fixture select gen_random_uuid(), ${workspace}, ${session} from generate_series(1,6000)`;
    await tx`insert into lineage_lookup_fixture values (${id},${workspace},${session})`;
    await tx`create temporary table lineage_source_fixture (lineage jsonb) on commit drop`;
    await tx`insert into lineage_source_fixture values (jsonb_build_object('turnId',${id}::text))`;
    await tx`analyze lineage_lookup_fixture`;
    await tx`analyze lineage_source_fixture`;
    for (const site of sites) {
      const value = site.normalized
        ? "lower(source.lineage->>'turnId')"
        : "source.lineage->>'turnId'";
      const expression = site.expression.replaceAll("value", value);
      const query = `select target.id from lineage_source_fixture source join lineage_lookup_fixture target on target.id=(${expression}) where target.workspace_id=$1::uuid and target.session_id=$2::uuid`;
      const rows = await tx.unsafe(query, [workspace, session]);
      expect(rows.map((row) => row.id)).toEqual([id]);
      expect(await tx.unsafe(query, [crypto.randomUUID(), session])).toHaveLength(0);
      expect(await tx.unsafe(query, [workspace, crypto.randomUUID()])).toHaveLength(0);
      const plan = await tx.unsafe(`explain (format json) ${query}`, [workspace, session]);
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
      };
      visit(plan[0]!["QUERY PLAN"][0].Plan);
      expect(
        nodes.some(
          (node) =>
            node["Node Type"] === "Index Scan" &&
            String(node["Index Cond"]).includes("source.lineage"),
        ),
      ).toBe(true);
    }
  });
});
