import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0272_scheduled_variable_set_materialization.sql",
  import.meta.url,
);

describe("migration 0272 scheduled Variable Set materialization", () => {
  test("separates exact service materialization from human-only personal authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain("assert_scoped_variable_set_materialization_attempt");
    expect(source).toContain("turn_value.initiator_kind");
    expect(source).toContain("turn_value.initiator_subject_id");
    expect(source).toContain("caller_human_subject IS DISTINCT FROM stored_human_subject");
    expect(source).toContain("variable_set_row.authority_scope = 'user'");
    expect(source).toContain("IF causal_human IS NULL THEN");
    expect(source).toContain("resolve_session_attempt_personal_resources");
    expect(source).toContain("variable_set.materialized");
    expect(source).not.toContain("CREATE OR REPLACE FUNCTION read_scoped_variable_set_secret");
  });
});
