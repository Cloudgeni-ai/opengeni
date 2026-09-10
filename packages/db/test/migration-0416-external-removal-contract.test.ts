import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("external service removal retains the deployed teardown and records service attribution", async () => {
  const source = await readFile(
    new URL("../drizzle/0440_external_workspace_member_removal.sql", import.meta.url),
    "utf8",
  );
  expect(source).toStartWith("-- deployment-mode: rolling\n");
  expect(source).toContain("pg_get_functiondef");
  expect(source).toContain("service_can_administer OR EXISTS");
  expect(source).toContain("credential.credential_kind = 'organization'");
  expect(source).toContain("credential.revoked_at IS NULL");
  expect(source).toContain("FOR SHARE");
  expect(source).toContain("acquire_session_tenancy_fence");
  expect(source).toContain("THEN ''service'' ELSE ''human''");
  expect(source).not.toMatch(
    /DELETE FROM|INSERT INTO organization_memberships|CREATE OR REPLACE FUNCTION/i,
  );
});
