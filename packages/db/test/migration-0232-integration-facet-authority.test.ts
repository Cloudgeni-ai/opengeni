import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../drizzle/0232_integration_facet_authority_cutover.sql", import.meta.url),
).text();

describe("Integration Facet authority maintenance cutover", () => {
  test("is a drained one-way cutover with settled Pack and Facet operations", () => {
    expect(migration.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migration).toContain("all opengeni_app sessions to be stopped");
    expect(migration).toContain("Pack and Facet operations to be settled");
    expect(migration).toContain("LOCK TABLE %I IN ACCESS EXCLUSIVE MODE");
  });

  test("renames physical authority and rejects every surviving Feature-era identity", () => {
    expect(migration).toContain(
      "ALTER TABLE integration_feature_facets RENAME TO integration_facet_definitions",
    );
    expect(migration).toContain(
      "ALTER TABLE integration_feature_bindings RENAME TO integration_facet_bindings",
    );
    expect(migration).toContain(
      "ALTER TABLE integration_feature_binding_owners RENAME TO integration_facet_binding_owners",
    );
    expect(migration).toContain(
      "ALTER TABLE integration_facet_definitions RENAME COLUMN feature_key TO facet_key",
    );
    expect(migration).toContain(
      "ALTER TABLE integration_facet_bindings RENAME COLUMN feature_facet_id TO facet_definition_id",
    );
    expect(migration).toContain("Integration Facet catalog names retain legacy Feature identity");
    expect(migration).toContain("Integration Facet physical authority migration did not converge");
  });

  test("rewrites Pack and owner identity while retiring incompatible receipts", () => {
    expect(migration).toContain("opengeni_private.integration_facet_rewrite_pack");
    expect(migration).toContain("'kind', 'facet'");
    expect(migration).toContain("'facetKey', component.value -> 'featureKey'");
    expect(migration).toContain("SET kind = CASE WHEN kind = 'feature' THEN 'facet' ELSE kind END");
    expect(migration).toContain("SET owner_id = 'facet:' || substr(owner_id");
    expect(migration).toContain("DELETE FROM capability_operations operation");
    expect(migration).toContain(
      "DELETE FROM capability_operations\nWHERE target_kind = 'facet_binding'",
    );
    expect(migration).toContain("Integration Facet persisted identity migration did not converge");
  });

  test("recomputes immutable Pack digests with canonical JSON", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.integration_facet_canonical_json(value jsonb)",
    );
    expect(migration).toContain('ORDER BY entry.key COLLATE "C"');
    expect(migration).toContain("digest(");
    expect(migration).toContain("'sha256'");
    expect(migration).toContain("Integration Facet Pack digest migration did not converge");
    expect(migration).toContain(
      "DROP FUNCTION opengeni_private.integration_facet_canonical_json(jsonb);",
    );
  });
});
