import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("external owning-user database consistency checks require a persisted live mapping", async () => {
  const source = await readFile(
    new URL("../drizzle/0430_external_owning_user_authority.sql", import.meta.url),
    "utf8",
  );
  expect(source).toStartWith("-- deployment-mode: rolling\n");
  expect(source).toContain("identity_row.status = 'active' AND membership.status = 'active'");
  expect(source).toContain("membership.personal_workspace_id = identity_row.personal_workspace_id");
  expect(source).toContain("p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()");
  expect(source).toContain("p_account_id IS DISTINCT FROM opengeni_private.current_account_id()");
  expect(source).toContain("organization_private_sessions_enabled");
  expect(source).toContain(
    "REVOKE ALL ON FUNCTION opengeni_private.active_external_owning_subject(uuid,text) FROM PUBLIC",
  );
  expect(source).not.toMatch(/GRANT |UPDATE sessions|INSERT INTO workspace_memberships/i);
});
