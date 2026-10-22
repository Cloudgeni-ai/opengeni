import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

const file = "0822_session_pin_owner_short_circuit.sql";
const source = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
let shared: SharedTestDatabase;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("pin-owner-short-circuit");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 60_000);

test("only USING short-circuits the existing owner disjunct; writes stay visibility-bound", async () => {
  const [policy] = await shared.admin`
    select polpermissive, polcmd, pg_get_expr(polqual,polrelid) as qual,
      pg_get_expr(polwithcheck,polrelid) as check_expr
    from pg_policy where polrelid='session_pins'::regclass
      and polname='session_visibility_isolation'`;
  expect(policy!.polpermissive).toBe(false);
  expect(policy!.polcmd).toBe("*");
  expect(policy!.qual).toContain("CASE");
  expect(policy!.qual).toContain("THEN true");
  expect(policy!.qual).toContain("ELSE");
  expect(policy!.check_expr).not.toContain("current_subject_id");
  expect(policy!.check_expr).toContain("session_row.account_id = session_pins.account_id");
  expect(policy!.check_expr).toContain("session_row.workspace_id = session_pins.workspace_id");
  expect(policy!.check_expr).toContain("session_row.id = session_pins.session_id");
});

test("unexpected policy drift fails closed and rolls back", async () => {
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`alter policy session_visibility_isolation on session_pins using (false)`;
      await tx.unsafe(source);
    }),
  ).rejects.toThrow("Unexpected session pin visibility policy");
  const [policy] = await shared.admin`
    select pg_get_expr(polqual,polrelid) as qual from pg_policy
    where polrelid='session_pins'::regclass and polname='session_visibility_isolation'`;
  expect(policy!.qual).toContain("CASE");
});
