import { describe, expect, test } from "bun:test";

const migrationUrl = new URL(
  "../drizzle/0360_organization_identity_confirmation_prompt.sql",
  import.meta.url,
);
const migration = await Bun.file(migrationUrl).text();

describe("migration 0360 organization identity confirmation prompt", () => {
  test("narrows new confirmations while disclosing rolling legacy content", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION company_profile_agent_confirmation_summary",
    );
    expect(migration).toContain("Activate this organization identity and mission?");
    expect(migration).toContain("Activate this organization identity and retained legacy details?");
    expect(migration).toContain("'label', 'Organization identity'");
    expect(migration).toContain("FOREACH list_name");
    expect(migration).toContain("products', 'customers', 'goals', 'constraints");
    expect(migration).toContain("retained compatibility context");
    expect(migration).not.toMatch(/UPDATE\s+company_profile_agent_proposal_receipts/iu);
    expect(migration).toContain(
      "ALTER FUNCTION %I.company_profile_agent_confirmation_summary(text)",
    );
    expect(migration).toContain(
      "ALTER FUNCTION %I.company_profile_agent_confirmation_prompt(uuid,bigint,text,text)",
    );
    expect(migration).toContain("SET search_path = pg_catalog, %I, pg_temp");
  });
});
