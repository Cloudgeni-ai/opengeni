import { describe, expect, test } from "bun:test";
import {
  GRANDFATHERED_LOCK_ORDER_MIGRATIONS,
  MIGRATIONS_DIR,
  analyzeMigrationLockOrder,
  analyzeMigrationSql,
  staleLockOrderAllowlistEntries,
  tableLockOf,
  takesAdvisoryLock,
  unreviewedLockOrderFindings,
} from "./migration-lock-order";

const FENCES = `DO $fences$
DECLARE workspace_value uuid;
BEGIN
  FOR workspace_value IN SELECT DISTINCT workspace_id FROM widgets LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('session-tenancy:' || workspace_value::text, 0));
  END LOOP;
END
$fences$;`;

describe("migration lock order", () => {
  test("an advisory fence after ALTER TABLE is an inversion", () => {
    const finding = analyzeMigrationSql(
      "9999_inverted.sql",
      `SET LOCAL lock_timeout = '5s';
ALTER TABLE widgets NO FORCE ROW LEVEL SECURITY;
${FENCES}
UPDATE widgets SET visibility = 'user_private';
ALTER TABLE widgets FORCE ROW LEVEL SECURITY;`,
    );
    expect(finding).toEqual({
      file: "9999_inverted.sql",
      tableLockStatement: 2,
      tableLock: "ALTER TABLE",
      advisoryStatement: 3,
    });
  });

  test("fences taken before the first table lock are in application order", () => {
    expect(
      analyzeMigrationSql(
        "9999_ordered.sql",
        `${FENCES}
ALTER TABLE widgets ADD COLUMN visibility text;`,
      ),
    ).toBeNull();
  });

  test("a shared or session-level advisory lock after LOCK TABLE is also an inversion", () => {
    for (const call of ["pg_advisory_lock_shared(7)", "pg_catalog.pg_advisory_lock(7)"]) {
      expect(
        analyzeMigrationSql("9999.sql", `LOCK TABLE widgets IN EXCLUSIVE MODE;\nSELECT ${call};`),
      ).not.toBeNull();
    }
  });

  test("non-blocking, deferred and quoted advisory text is not flagged", () => {
    const migration = `ALTER TABLE widgets ADD COLUMN visibility text;
SELECT pg_try_advisory_xact_lock(7);
CREATE OR REPLACE FUNCTION fence_widget() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  PERFORM pg_advisory_xact_lock(7);
  RETURN NEW;
END
$body$;
DO $patch$
BEGIN
  PERFORM replace('x', 'y', 'PERFORM pg_advisory_xact_lock(7);');
END
$patch$;`;
    expect(analyzeMigrationSql("9999.sql", migration)).toBeNull();
  });

  test("classifies table locks and advisory acquisitions", () => {
    expect(tableLockOf("ALTER TABLE widgets FORCE ROW LEVEL SECURITY")).toBe("ALTER TABLE");
    expect(tableLockOf("CREATE UNIQUE INDEX widgets_key ON widgets (id)")).toBe(
      "CREATE UNIQUE INDEX",
    );
    expect(tableLockOf("CREATE INDEX CONCURRENTLY widgets_key ON widgets (id)")).toBeNull();
    expect(tableLockOf("DO $$ BEGIN EXECUTE 'x'; ALTER TABLE widgets ADD c int; END $$")).toBe(
      "ALTER TABLE",
    );
    expect(tableLockOf("UPDATE widgets SET c = 1")).toBeNull();
    expect(takesAdvisoryLock("-- pg_advisory_xact_lock(7)\nSELECT 1")).toBe(false);
    expect(takesAdvisoryLock("SELECT pg_advisory_xact_lock(7)")).toBe(true);
  });

  test("shipped migrations add no new inversion and the frozen list is exact", () => {
    const findings = analyzeMigrationLockOrder(MIGRATIONS_DIR);
    expect(unreviewedLockOrderFindings(findings)).toEqual([]);
    expect(staleLockOrderAllowlistEntries(MIGRATIONS_DIR)).toEqual([]);
    // Every frozen entry is still a real finding, so the list cannot hide a new file.
    expect(findings.map((finding) => finding.file)).toEqual([
      ...GRANDFATHERED_LOCK_ORDER_MIGRATIONS,
    ]);
  });
});
