import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { measureJsonObjectText } from "../src/json-object-text-measurement";

// The approval RunState envelope used to be measured by PostgreSQL itself.
// The in-process measurement must accept exactly the objects jsonb accepts and
// count what `jsonb_path_query(value, 'strict $.**')` returns.

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("json-object-text-measurement");
  if (!acquired) throw new Error("PostgreSQL is required");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

const documents = [
  "{}",
  ' \n{"a":[1,-0.5e+10,2E-3,true,false,null,"x\\n\\"\\u00e9\\ud83d\\ude00/"],"b":{},"c":[]}\t',
  JSON.stringify({ nested: { list: [{ a: 1 }, [2, [3, { b: null }]]], text: "\u0001\u2028" } }),
  // A raw unpaired surrogate is sent as U+FFFD, like any stored text.
  '{"a":"raw \ud800 surrogate"}',
  `{"history":[${"0,".repeat(999)}0]}`,
  `{${Array.from({ length: 300 }, (_, index) => `"property_${index}":${index}`).join(",")}}`,
  "",
  "[]",
  '"text"',
  "{} {}",
  '{"a":1,}',
  '{"a":01}',
  '{"a":1.}',
  '{"a":truex}',
  "{'a':1}",
  '{"a":"\\x"}',
  '{"a":"\\u0000"}',
  '{"a":"\\ud800"}',
  '{"a":"\\udc00"}',
  '{"a":"\\ud800\\u0041"}',
];

test("in-process measurement agrees with PostgreSQL jsonb", async () => {
  for (const text of documents) {
    const [database] = await shared.admin<
      { valid_json_object: boolean; nodes: number | null; properties: number | null }[]
    >`
      with candidate as (
        select ${text}::text as value,
               pg_input_is_valid(${text}::text, 'jsonb') as valid_jsonb
      ), decoded as (
        select case
                 when valid_jsonb and jsonb_typeof(value::jsonb) = 'object' then value::jsonb
               end as state
        from candidate
      )
      select state is not null as valid_json_object,
             (select count(*)::integer from jsonb_path_query(state, 'strict $.**')) as nodes,
             (select count(*)::integer
                from jsonb_path_query(state, 'strict $.** ? (@.type() == "object")') as object_value
                cross join lateral jsonb_object_keys(object_value)) as properties
      from decoded
    `;
    const measured = measureJsonObjectText(text);
    expect({ text, ...measured }).toEqual({
      text,
      validJsonObject: database!.valid_json_object,
      nodes: database!.valid_json_object ? database!.nodes! : 0,
      properties: database!.valid_json_object ? database!.properties! : 0,
    });
  }
});
