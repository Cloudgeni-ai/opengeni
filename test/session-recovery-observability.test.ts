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

  test("measures overdue age from the exact attempt's recorded backoff, content-free", async () => {
    const migration = await readFile(
      join(repo, "packages/db/drizzle/0633_session_recovery_overdue_age.sql"),
      "utf8",
    );

    expect(migration.split("\n")[0]).toBe("-- deployment-mode: rolling");
    // Candidate selection is unchanged from 0375/0519.
    expect(migration).toContain("turn.id = session.active_turn_id");
    expect(migration).toContain("turn.active_attempt_id IS NULL");
    expect(migration).toContain("attempt.outcome = 'interrupted_recoverable'");
    expect(migration).toContain("interruption.state IN ('settled', 'rejected_stale')");
    // Due time is the exact attempt's recorded recovery backoff.
    expect(migration).toContain("event.turn_attempt_id = attempt.id");
    expect(migration).toContain("event.type = 'turn.recovery.requested'");
    expect(migration).toContain("jsonb_typeof(event.payload -> 'continueDelayMs') = 'number'");
    expect(migration).toContain("WHEN candidate.quiesced_at IS NULL THEN candidate.closed_at");
    // Legacy readers project the same summary.
    expect(migration).toContain(
      "FROM opengeni_private.summarize_session_recovery_backlog() summary",
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.summarize_session_recovery_backlog() FROM PUBLIC",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.summarize_session_recovery_backlog() TO opengeni_app",
    );
    expect(migration).not.toMatch(/RETURNS TABLE \([^)]*(session|workspace|attempt)_id/i);
  });
});
