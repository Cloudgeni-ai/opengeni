import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0372_ordered_variable_set_runtime_authority.sql",
  import.meta.url,
);

describe("migration 0372 ordered Variable Set runtime authority", () => {
  test("repairs ordered runtime checks and revalidates direct personal attachment", async () => {
    const source = await Bun.file(migrationUrl).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).toContain("pg_catalog.pg_get_functiondef");
    expect(source).toContain(
      "materialize_scoped_variable_set_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid)",
    );
    expect(source).toContain(
      "read_scoped_variable_set_secret(uuid,uuid,uuid,text,text,text,uuid,uuid,uuid,integer)",
    );
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_session(",
    );
    expect(source).toContain("authorize_session_attempt_personal_resource_reads(uuid,uuid,uuid)");
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set_row.id::text",
    );
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, '[]'::jsonb) ? p_variable_set_id::text",
    );
    expect(source).toContain(
      "coalesce(session_value.variable_set_ids, ''[]''::jsonb) ? variable_set.id::text",
    );
    expect(source).toContain("occurrences <> 1");
    expect(source).toContain("USING ERRCODE = '55000'");
    expect(source).toContain("opengeni_private.personal_resource_delegation_capabilities");
    expect(source).toContain("membership.subject_id = causal_human");
    expect(source).toContain("authority.resource_kind = 'variable_set'");
    expect(source).toContain("authority.generation = variable_set_row.generation");
    expect(source).toContain("grant_value.action = 'variable_set.use'");
    expect(source).toContain("grant_value.context = session_authority_visibility");
    expect(source).toContain("grant_value.mode = 'session'");
    expect(source).toContain("grant_value.mode = 'always'");
    expect(source).toContain("grant_value.authority_epoch = session_authority_epoch");
    expect(source).toContain("FOR SHARE OF membership, authority, grant_value");
    expect(source).toContain("personal variable-set session grant is not exact or current");
    expect(source).not.toMatch(/\bDROP\s+FUNCTION\b/u);
    expect(source).not.toMatch(/\bGRANT\b/u);
  });
});
