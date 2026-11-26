import { expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

test("account deletion migration replays under the non-superuser owner and withholds both grants", async () => {
  const fixture = await acquireOwnerMigratedTestDatabase("account-deletion-migration");
  if (!fixture) return;
  try {
    await migrate(fixture.ownerUrl);
    const [row] = await fixture.admin`
      select c.relrowsecurity and c.relforcerowsecurity as protected,
       has_function_privilege('opengeni_app', 'opengeni_private.account_deletion_user_v1(text,jsonb)', 'EXECUTE') as user_granted,
       has_function_privilege('opengeni_app', 'opengeni_private.account_deletion_work_v1(text,jsonb)', 'EXECUTE') as worker_granted
      from pg_class c where c.oid = 'account_deletion_requests'::regclass`;
    expect(row).toEqual({ protected: true, user_granted: false, worker_granted: false });
  } finally {
    await fixture.release();
  }
}, 180_000);
