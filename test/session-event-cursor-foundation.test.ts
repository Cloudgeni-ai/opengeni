import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

describe("session event cursor foundation", () => {
  test("backfills only after exact legacy parity and restores FORCE RLS", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0374_session_event_cursors.sql"),
      "utf8",
    );

    const parity = migration.indexOf("session_event_cursor_parity");
    const backfill = migration.indexOf("INSERT INTO session_event_cursors", parity);
    const restoreEvents = migration.indexOf(
      "ALTER TABLE session_events FORCE ROW LEVEL SECURITY",
      backfill,
    );
    const restoreSessions = migration.indexOf(
      "ALTER TABLE sessions FORCE ROW LEVEL SECURITY",
      backfill,
    );

    expect(parity).toBeGreaterThanOrEqual(0);
    expect(migration.slice(parity, backfill)).toContain(
      "sessions.last_sequence <> COALESCE(MAX(session_events.sequence), 0)::integer",
    );
    expect(backfill).toBeGreaterThan(parity);
    expect(restoreEvents).toBeGreaterThan(backfill);
    expect(restoreSessions).toBeGreaterThan(backfill);
  });

  test("advances once per inserted statement and rejects gaps", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0374_session_event_cursors.sql"),
      "utf8",
    );

    expect(migration).toContain("REFERENCING NEW TABLE AS inserted_session_events");
    expect(migration).toContain("FOR EACH STATEMENT");
    expect(migration).toContain("ORDER BY workspace_id, session_id");
    expect(migration).toContain("inserted_group.first_sequence <> current_sequence + 1");
    expect(migration).toContain(
      "inserted_group.last_sequence <> current_sequence + inserted_group.sequence_count",
    );
    expect(migration).toContain("COUNT(DISTINCT sequence)::integer");
    expect(migration).not.toContain("UPDATE sessions\n    SET last_sequence");
  });

  test("starts newly inserted sessions before their first durable event", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0374_session_event_cursors.sql"),
      "utf8",
    );
    const initializer = migration.slice(
      migration.indexOf("CREATE FUNCTION initialize_session_event_cursors_for_inserted_sessions"),
      migration.indexOf("CREATE TRIGGER sessions_initialize_event_cursors"),
    );

    expect(initializer).toContain("SELECT id, account_id, workspace_id, 0");
    expect(initializer).not.toContain("SELECT id, account_id, workspace_id, last_sequence");
  });

  test("keeps the cursor protected and available to rolling runtime writers", async () => {
    const [migration, posture] = await Promise.all([
      readFile(join(repo, "packages/db/drizzle/0374_session_event_cursors.sql"), "utf8"),
      readFile(join(repo, "packages/db/src/runtime-posture.ts"), "utf8"),
    ]);

    expect(migration).toContain("ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY workspace_isolation ON session_event_cursors");
    expect(migration).toContain(
      "CREATE POLICY session_visibility_isolation ON session_event_cursors AS RESTRICTIVE",
    );
    expect(migration).toContain("session_reference_visible(account_id, workspace_id, session_id)");
    expect(migration).toContain("session_tenancy_fence_inventory_read");
    expect(migration).toContain("session_tenancy_fenced_owner_write");
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON session_event_cursors TO opengeni_app",
    );
    expect(posture).toContain('"session_event_cursors"');
  });
});
