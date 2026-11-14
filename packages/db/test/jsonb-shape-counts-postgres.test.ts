import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { createDb, type DbClient } from "../src";
import { rawRows } from "../src/database";
import { jsonbNodeCountSql, jsonbPropertyCountSql } from "../src/jsonb-shape-counts";

// History items used to be measured by counting `jsonb_path_query` rows, which
// is quadratic in the item's node count. The linear expressions must return
// exactly the same counts.

let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("jsonb-shape-counts");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.adminUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

function randomDocuments(count: number): unknown[] {
  let seed = 11;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const build = (depth: number): unknown => {
    const pick = random();
    if (depth > 5 || pick < 0.3) {
      return [0, -1.5e300, "text \u2028 \ud83d\ude00", true, false, null, "", {}, []][
        Math.floor(random() * 9)
      ];
    }
    if (pick < 0.65) {
      return Array.from({ length: Math.floor(random() * 6) }, () => build(depth + 1));
    }
    return Object.fromEntries(
      Array.from({ length: Math.floor(random() * 6) }, (_, index) => [
        `key ${index}`,
        build(depth + 1),
      ]),
    );
  };
  return Array.from({ length: count }, () => build(0));
}

test("linear shape counts equal the jsonb_path_query row counts", async () => {
  const documents: unknown[] = [
    null,
    0,
    "text",
    true,
    {},
    [],
    [[[]]],
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { a: { b: { c: { d: [1, { e: null }] } } }, f: [{}, [], '{"g":1}'] },
    { history: Array.from({ length: 5_000 }, (_, index) => index) },
    Object.fromEntries(
      Array.from({ length: 3_000 }, (_, index) => [`property_${index}`, { index }]),
    ),
    JSON.parse(`${"[".repeat(500)}1${"]".repeat(500)}`),
    ...randomDocuments(300),
  ];
  const rows = await rawRows<{
    ordinal: number;
    nodes: string;
    properties: string;
    reference_nodes: string;
    reference_properties: string;
  }>(
    client.db,
    sql`
      select ordinal::integer,
             ${jsonbNodeCountSql(sql`document`)}::text as nodes,
             ${jsonbPropertyCountSql(sql`document`)}::text as properties,
             (select count(*) from jsonb_path_query(document, 'strict $.**'))::text
               as reference_nodes,
             (
               select count(*)
               from jsonb_path_query(document, 'strict $.** ? (@.type() == "object")')
                 as object_value
               cross join lateral jsonb_object_keys(object_value)
             )::text as reference_properties
      from jsonb_array_elements(${JSON.stringify(documents)}::jsonb)
        with ordinality as documents(document, ordinal)
      order by ordinal
    `,
  );
  expect(rows).toHaveLength(documents.length);
  for (const row of rows) {
    expect({ ordinal: row.ordinal, nodes: row.nodes, properties: row.properties }).toEqual({
      ordinal: row.ordinal,
      nodes: row.reference_nodes,
      properties: row.reference_properties,
    });
  }
});
