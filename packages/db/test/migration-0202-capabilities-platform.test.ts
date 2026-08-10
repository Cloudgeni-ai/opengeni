import { describe, expect, test } from "bun:test";

const migration = await Bun.file(
  new URL("../drizzle/0202_capabilities_platform.sql", import.meta.url),
).text();

const tables = [
  "capability_plugins",
  "capability_plugin_versions",
  "capability_facets",
  "capability_integration_facets",
  "capability_mcp_facets",
  "capability_api_facets",
  "capability_skill_facets",
  "capability_skill_files",
  "capability_plugin_installations",
  "capability_facet_installations",
  "capability_component_owners",
  "integration_spec_revisions",
  "integration_tools",
  "integration_feature_facets",
  "integration_feature_bindings",
  "capability_operations",
] as const;

describe("capabilities platform expand migration", () => {
  test("is rolling, additive, FORCE-RLS covered, and runtime-granted", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/iu);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\s+"?(capability_catalog_items|capability_installations|workspace_packs|pack_installations)"?\s+(?:DROP|RENAME)\b/iu,
    );
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`"${table}"`);
    }
    expect(migration).toContain("TO opengeni_app;");
  });

  test("pins immutable definitions and validates every tenant-bearing reference", () => {
    expect(migration).toContain("capability_plugin_versions_restrict_update");
    expect(migration).toContain("capability_facets_immutable");
    expect(migration).toContain("capability_skill_files_immutable");
    expect(migration).toContain("integration_spec_revisions_immutable");
    expect(migration).toContain("capability_plugin_installations_validate");
    expect(migration).toContain("capability_facet_installations_validate");
    expect(migration).toContain("capability_component_owners_validate");
    expect(migration).toContain("integration_feature_bindings_validate");
    expect(migration).toContain('p."workspace_id" IS NOT NULL');
    expect(migration).toContain('"capability_id" text NOT NULL');
  });

  test("represents every universal Integration facet without provider-specific tables", () => {
    for (const kind of [
      "tools",
      "knowledge_source",
      "inbound_trigger",
      "delivery_destination",
      "identity_link",
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).not.toMatch(/CREATE TABLE "(?:slack|google|microsoft|drive)_/u);
  });
});
