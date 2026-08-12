import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0225_session_visibility_fork_activation.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase(
    "migration-0225-session-visibility-fork-activation",
  );
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0225-session-visibility-fork-activation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0225 session visibility and fork activation", () => {
  test("installs one bounded server-authoritative transition capability", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const transition = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility",
      ),
      migration.indexOf("DO $session_fork_activation$"),
    );
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
    expect(transition).not.toContain("created_by_subject_id");
    expect(transition).not.toContain("initial_message");
    expect(transition).not.toContain(
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

  test("forks only an explicit durable-content allowlist with fresh authority", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION %1$I.fork_session_content",
    );
    expect(migration).toContain(
      "session fork destination workspace access is unavailable",
    );
    expect(migration).toContain("session fork source session is private");
    expect(migration).toContain("source_session.initial_message");
    expect(migration).toContain("source_session.title");
    expect(migration).toContain("source_session.instructions");
    expect(migration).toContain(
      "jsonb_array_elements(source_session.resources)",
    );
    expect(migration).toContain("- 'credentialBindingId'");
    expect(migration).toContain("- 'connectionId'");
    expect(migration).toContain(
      "destination_resources, '[]'::jsonb, '[]'::jsonb",
    );
    expect(migration).toContain("'subject', p_actor_subject_id");
    expect(migration).toContain(
      "CREATE TEMP TABLE opengeni_session_fork_history_spool",
    );
    expect(migration).toContain("FROM session_history_items source_item");
    expect(migration).toContain(
      "FROM opengeni_session_fork_history_spool source_item",
    );
    expect(migration).toContain(
      "SELECT source_item.position, source_item.item,",
    );
    expect(migration).not.toContain("source_item.item - 'providerData'");
    expect(migration).toContain("p_destination_visibility, 1");
    expect(migration).toContain(
      "destination_session_id, 0, NULL, destination_depth",
    );
    expect(migration).toContain("NULL, '[]'::jsonb, '[]'::jsonb");
    expect(migration).toContain(
      "NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL",
    );
    expect(migration).not.toContain("source_session.variable_set_id");
    expect(migration).not.toContain("source_session.rig_id");
    expect(migration).not.toContain("source_session.active_sandbox_id");
    expect(migration).not.toContain(
      "source_session.codex_pinned_credential_id",
    );
    expect(migration).not.toContain("INSERT INTO session_turns");
    expect(migration).not.toContain("INSERT INTO session_goals");
    expect(migration).not.toContain(
      "INSERT INTO organization_user_resource_grants",
    );
    expect(migration).not.toContain("INSERT INTO session_pins");
  });

  test("installs both lifecycle capabilities and authority-change constraint", async () => {
    if (!shared) return;
    const functions = await shared.admin<
      Array<{ name: string; securityDefiner: boolean }>
    >`
      select routine_name as name, security_type = 'DEFINER' as "securityDefiner"
      from information_schema.routines
      where routine_schema = current_schema()
        and routine_name in ('transition_session_visibility', 'fork_session_content')
      order by routine_name
    `;
    expect(Array.from(functions)).toEqual([
      { name: "fork_session_content", securityDefiner: true },
      { name: "transition_session_visibility", securityDefiner: true },
    ]);
    const [constraint] = await shared.admin<Array<{ definition: string }>>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'session_attempt_interruptions'::regclass
        and conname = 'session_attempt_interruptions_kind_check'
    `;
    expect(constraint?.definition).toContain("authority_change");
  });
});
