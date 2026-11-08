import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

// A composite tenant foreign key such as (workspace_id, turn_id) declared
// ON DELETE SET NULL without a column list nulls every key column, including
// the NOT NULL workspace_id, so every delete of a referenced row fails with
// 23502. That stalled archived-session purges in production for weeks. Name
// the nullable column instead: ON DELETE SET NULL (turn_id).
let shared: SharedTestDatabase;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("foreign-key-set-null-columns");
  if (!acquired) throw new Error("foreign key catalog checks require real PostgreSQL");
  shared = acquired;
}, 180_000);
afterAll(async () => {
  await shared?.release();
});

test("no ON DELETE SET NULL foreign key clears a NOT NULL column", async () => {
  const offenders = await shared.admin`
    select c.conrelid::regclass::text as "table", c.conname as "constraint"
    from pg_constraint c
    where c.contype = 'f'
      and c.confdeltype = 'n'
      and exists (
        select 1
        from unnest(coalesce(c.confdelsetcols, c.conkey)) as cols(attnum)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = cols.attnum
        where a.attnotnull
      )
    order by 1, 2`;
  expect([...offenders]).toEqual([]);
});
