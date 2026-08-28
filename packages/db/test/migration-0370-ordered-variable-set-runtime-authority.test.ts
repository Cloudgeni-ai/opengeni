import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0370_ordered_variable_set_runtime_authority.sql",
  import.meta.url,
);

describe("migration 0370 ordered Variable Set runtime authority", () => {
  test("repairs every legacy final-alias runtime check without changing signatures", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("pg_catalog.pg_get_functiondef");
    expect(source).toContain(
      "materialize_scoped_variable_set_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)",
    );
    expect(source).toContain(
      "read_scoped_variable_set_secret(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,integer)",
    );
    expect(source).toContain("materialize_scoped_variable_set_for_session(uuid,uuid,uuid,uuid)");
    expect(source).toContain("authorize_session_attempt_personal_resource_reads(uuid,uuid,uuid)");
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text",
    );
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? p_variable_set_id::text",
    );
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set.id::text",
    );
    expect(source).toContain("occurrences <> 1");
    expect(source).toContain("USING ERRCODE = '55000'");
    expect(source).not.toMatch(/\bDROP\s+FUNCTION\b/u);
    expect(source).not.toMatch(/\bGRANT\b/u);
  });
});
