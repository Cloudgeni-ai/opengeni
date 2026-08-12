import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0225_session_visibility_fork_activation.sql",
);

describe("migration 0225 session visibility and fork activation", () => {
  test("installs one bounded server-authoritative transition capability", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("opengeni_private.current_account_id()");
    expect(migration).toContain("opengeni_private.current_workspace_id()");
    expect(migration).toContain("opengeni_private.current_subject_id()");
    expect(migration).toContain("membership.status = 'active'");
    expect(migration).toContain(
      "session_row.owner_organization_membership_id <> actor_membership.id",
    );
    expect(migration).toContain(
      "session_row.authority_epoch <> p_expected_authority_epoch",
    );
    expect(migration).toContain("authority_epoch = new_epoch");
    expect(migration).toContain("'authority_change'");
    expect(migration).toContain("cancel_reason = 'authority_changed'");
    expect(migration).toContain("UPDATE organization_user_resource_grants");
    expect(migration).toContain("'session.visibility.changed'");
    expect(migration).toContain("receipt_row.result ->> 'status' = 'applied'");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).not.toContain("created_by_subject_id");
    expect(migration).not.toContain("initial_message");
    expect(migration).not.toContain(
      "'ownerOrganizationMembershipId', new_owner_id",
    );
  });

  test("keeps lock and receipt order deterministic", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const workspaceLock = migration.indexOf("FROM workspaces workspace_row");
    const membershipLock = migration.indexOf(
      "FROM organization_memberships membership",
    );
    const sessionLock = migration.indexOf("FROM sessions session");
    const receipt = migration.indexOf("INSERT INTO session_command_receipts");
    const mutation = migration.indexOf(
      "UPDATE sessions\n        SET visibility",
    );
    expect(workspaceLock).toBeGreaterThan(0);
    expect(membershipLock).toBeGreaterThan(workspaceLock);
    expect(sessionLock).toBeGreaterThan(membershipLock);
    expect(receipt).toBeGreaterThan(sessionLock);
    expect(mutation).toBeGreaterThan(receipt);
  });
});
