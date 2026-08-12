import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../drizzle/0223_integration_definition_identity_cutover.sql", import.meta.url),
).text();

describe("Integration Definition identity maintenance cutover", () => {
  test("is a one-way maintenance migration with exact immutable authority", () => {
    expect(migration.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migration).toContain("all opengeni_app sessions to be stopped");
    for (const table of [
      "capability_plugin_versions",
      "integration_spec_revisions",
      "connections",
    ]) {
      expect(migration).toContain(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;`);
    }
    expect(migration).toContain(
      "ALTER TABLE integration_spec_revisions DISABLE TRIGGER integration_spec_revisions_immutable;",
    );
    expect(migration).toContain(
      "ALTER TABLE capability_plugin_versions DISABLE TRIGGER capability_plugin_versions_restrict_update;",
    );
    expect(migration).toContain(
      "ALTER TABLE capability_plugin_versions ENABLE TRIGGER capability_plugin_versions_restrict_update;",
    );
    expect(migration).toContain(
      "ALTER TABLE integration_spec_revisions ENABLE TRIGGER integration_spec_revisions_immutable;",
    );
  });

  test("removes every old identity and verifies the new domain invariant", () => {
    expect(migration).toContain("version.manifest - 'presetId'");
    expect(migration).toContain("revision.spec - 'integrationId'");
    expect(migration).toContain("metadata - 'authorizedPresetIds'");
    expect(migration).toContain("'definitionId'");
    expect(migration).toContain("'definitionProvenance'");
    expect(migration).toContain("'authorizedDefinitionIds'");
    expect(migration).toContain("Integration Definition manifest migration did not converge");
    expect(migration).toContain("Integration Definition revision migration did not converge");
    expect(migration).toContain(
      "Integration Definition Connection metadata migration did not converge",
    );
  });

  test("recomputes the published manifest digest with a temporary canonical JSON helper", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION opengeni_private.integration_definition_canonical_json(value jsonb)",
    );
    expect(migration).toContain('ORDER BY entry.key COLLATE "C"');
    expect(migration).toContain("digest(");
    expect(migration).toContain("'sha256'");
    expect(migration).toContain(
      "DROP FUNCTION opengeni_private.integration_definition_canonical_json(jsonb);",
    );
  });
});
