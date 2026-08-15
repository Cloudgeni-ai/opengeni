import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0253_common_user_resource_authority_lifecycle.sql",
  import.meta.url,
);

describe("migration 0253 common user-resource authority lifecycle", () => {
  test("is one rolling forward migration with fixed-path owner-only capabilities", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const routine of [
      "list_self_user_resource_authorities",
      "issue_self_user_resource_grant",
      "revoke_self_user_resource_grant",
      "authorize_session_attempt_personal_resource_reads",
    ]) {
      expect(source).toContain(`CREATE OR REPLACE FUNCTION ${routine}`);
    }
    expect(source).toContain("SET search_path = pg_catalog, pg_temp");
    expect(source).toContain("workspace_shared requires durable shared-output acknowledgement");
    expect(source).toContain("current_setting('opengeni.subject_id', true)");
    expect(source).not.toMatch(/p_owner|owner_subject|membership_id\s+uuid\s*DEFAULT/iu);
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app",
    );
    expect(source).not.toContain("authority.origin_workspace_id = snapshot.origin_workspace_id");
    expect(source).not.toContain("variable_set.workspace_id = snapshot.origin_workspace_id");
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[0-9a-f]{64}$/u);
  });
});
