import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0395_scheduled_task_unclaimed_occurrence_invalidation.sql",
  import.meta.url,
);

describe("migration 0395 scheduled task unclaimed occurrence invalidation", () => {
  test("installs a rolling first-claim cutoff without mutating claimed turns", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain(
      "CREATE FUNCTION invalidate_unclaimed_scheduled_agent_runs_on_task_inactive()",
    );
    expect(migration).toContain("AFTER UPDATE OF status, deleted_at ON scheduled_tasks");
    expect(migration).toContain("OLD.status = 'active' AND NEW.status = 'paused'");
    expect(migration).toContain("OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL");
    expect(migration).toContain("AND run.status IN ('queued', 'dispatched')");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("FROM session_turns turn_value");
    expect(migration).toContain("scheduled_task_paused_before_claim");
    expect(migration).toContain("scheduled_task_deleted_before_claim");
    expect(migration).not.toContain("UPDATE session_turns");
    expect(migration).not.toContain("UPDATE session_system_updates");
  });
});
