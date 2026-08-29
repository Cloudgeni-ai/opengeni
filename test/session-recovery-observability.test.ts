import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");

describe("durable session recovery observability", () => {
  test("counts only exact latest closed recoverable attempts without active ownership", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0375_session_recovery_observability.sql"),
      "utf8",
    );

    expect(migration).toContain("turn.id = session.active_turn_id");
    expect(migration).toContain("turn.active_attempt_id IS NULL");
    expect(migration).toContain("ORDER BY candidate.execution_generation DESC");
    expect(migration).toContain("attempt.state = 'closed'");
    expect(migration).toContain("attempt.outcome = 'interrupted_recoverable'");
    expect(migration).toContain("interruption.state IN ('settled', 'rejected_stale')");
    expect(migration).toContain("event.type = 'turn.recovery.requested'");
  });

  test("returns fixed content-free states through a least-privilege capability", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0375_session_recovery_observability.sql"),
      "utf8",
    );

    expect(migration).toContain("VALUES ('quiescence_missing'::text), ('projection_stale'::text)");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path FROM CURRENT");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.count_session_recovery_backlog() FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.count_session_recovery_backlog() TO opengeni_app",
    );
    expect(migration).not.toMatch(/RETURNS TABLE \([^)]*(session|workspace|attempt)_id/i);
  });
});
