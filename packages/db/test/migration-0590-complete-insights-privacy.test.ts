import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("complete-insights-private-helper-acl");
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

test("0590 scrubs polluted owner defaults for every non-owner private-helper grantee", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const signature =
    "opengeni_private.organization_private_chat_usage(uuid,timestamptz,timestamptz)";
  const migration = await Bun.file(
    new URL("../drizzle/0590_complete_insights_usage_amounts.sql", import.meta.url),
  ).text();
  const blocks = migration.match(
    /DO \$private_chat_usage_acl\$[\s\S]*?\$private_chat_usage_acl\$;/g,
  );
  expect(blocks).toHaveLength(1);
  const rollback = new Error("Rollback fixture role, defaults and recreated helper");
  try {
    await shared.admin.begin(async (tx) => {
      const [routine] = await tx<Array<{ definition: string; owner: string }>>`
        select pg_get_functiondef(${signature}::regprocedure) as definition,
          pg_get_userbyid(proowner) as owner from pg_proc where oid = ${signature}::regprocedure`;
      if (!routine) throw new Error("Private helper is missing");
      const reporter = `insights_reporter_${crypto.randomUUID().replaceAll("-", "")}`;
      await tx`create role ${tx(reporter)}`;
      await tx`grant usage on schema opengeni_private to ${tx(reporter)}`;
      await tx`alter default privileges for role ${tx(routine.owner)} in schema opengeni_private
        grant execute on functions to ${tx(reporter)}`;
      await tx`drop function opengeni_private.organization_private_chat_usage(uuid,timestamptz,timestamptz)`;
      await tx`set local role ${tx(routine.owner)}`;
      await tx.unsafe(routine.definition);
      await tx`reset role`;
      const [polluted] = await tx<Array<{ execute: boolean }>>`
        select has_function_privilege(${reporter}, ${signature}, 'EXECUTE') as execute`;
      expect(polluted?.execute).toBe(true);
      // Execute the actual migration's owner-only ACL boundary, not a test copy.
      await tx.unsafe(blocks![0]!);
      const [clean] = await tx<Array<{ execute: boolean; ownerExecute: boolean; extra: string }>>`
        select has_function_privilege(${reporter}, ${signature}, 'EXECUTE') as execute,
          has_function_privilege(${routine.owner}, ${signature}, 'EXECUTE') as "ownerExecute",
          (select count(*)::text from pg_proc procedure
            cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
            where procedure.oid = ${signature}::regprocedure and acl.grantee <> procedure.proowner
              and acl.privilege_type = 'EXECUTE') as extra`;
      expect(clean).toEqual({ execute: false, ownerExecute: true, extra: "0" });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});
