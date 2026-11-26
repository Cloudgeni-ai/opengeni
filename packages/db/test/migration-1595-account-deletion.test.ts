import { expect, test } from "bun:test";
import { acquireRestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";

test("account deletion activation grants the runtime only routine access", async () => {
  const fixture = await acquireRestrictedRuntimeTestDatabase("account-deletion-migration");
  if (!fixture) return;
  try {
    const [row] = await fixture.admin`
      select c.relrowsecurity and c.relforcerowsecurity as protected,
       has_function_privilege('opengeni_app', 'opengeni_private.account_deletion_user_v1(text,jsonb)', 'EXECUTE') as user_granted,
       has_function_privilege('opengeni_app', 'opengeni_private.account_deletion_work_v1(text,jsonb)', 'EXECUTE') as worker_granted,
       has_table_privilege('opengeni_app', 'account_deletion_requests', 'SELECT,INSERT,UPDATE,DELETE') as direct_access
      from pg_class c where c.oid = 'account_deletion_requests'::regclass`;
    expect(row).toEqual({
      protected: true,
      user_granted: true,
      worker_granted: true,
      direct_access: false,
    });
  } finally {
    await fixture.release();
  }
}, 180_000);
