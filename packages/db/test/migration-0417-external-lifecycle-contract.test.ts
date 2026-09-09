import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("external lifecycle extends native guarded routines and keeps service attribution distinct", async () => {
  const source = await readFile(
    new URL("../drizzle/0436_external_identity_membership_lifecycle.sql", import.meta.url),
    "utf8",
  );
  expect(source).toStartWith("-- deployment-mode: rolling\n");
  expect(source).toContain("actor_service_subject");
  expect(source).toContain("permissions_value ? 'account:admin'");
  expect(source).toContain("membership.role = 'member'");
  expect(source).toContain("'suspend', 'reactivate', 'offboard'");
  expect(source).toContain("acquire_organization_session_tenancy_fences");
  expect(source).toContain("authorization_revision = authorization_revision + 1");
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION opengeni_private.external_membership_service_authority(jsonb) FROM PUBLIC",
  );
  expect(source).not.toMatch(
    /INSERT INTO organization_memberships|DELETE FROM sessions|UPDATE session_turns/i,
  );
});
