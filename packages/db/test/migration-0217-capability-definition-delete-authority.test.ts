import { describe, expect, test } from "bun:test";
import { RUNTIME_FULL_DML_TABLES, RUNTIME_READ_INSERT_UPDATE_TABLES } from "../src/runtime-posture";

const migration = await Bun.file(
  new URL("../drizzle/0217_capability_definition_delete_authority.sql", import.meta.url),
).text();

const historicalDefinitionTables = [
  "capability_plugins",
  "capability_plugin_versions",
  "capability_facets",
  "capability_integration_facets",
  "capability_mcp_facets",
  "capability_api_facets",
  "capability_skill_facets",
  "capability_skill_files",
  "integration_spec_revisions",
  "integration_tools",
  "integration_feature_facets",
] as const;

const historicalLifecycleTables = [
  "capability_plugin_installations",
  "capability_facet_installations",
  "capability_component_owners",
  "integration_feature_bindings",
  "integration_feature_binding_owners",
  "capability_operations",
] as const;

const currentDefinitionTables = [
  "capability_plugins",
  "capability_plugin_versions",
  "capability_facets",
  "capability_integration_facets",
  "capability_mcp_facets",
  "capability_api_facets",
  "capability_skill_facets",
  "capability_skill_files",
  "integration_spec_revisions",
  "integration_tools",
  "integration_facet_definitions",
] as const;

const currentLifecycleTables = [
  "capability_plugin_installations",
  "capability_facet_installations",
  "capability_component_owners",
  "integration_facet_bindings",
  "integration_facet_binding_owners",
  "capability_operations",
] as const;

describe("capability definition delete authority repair migration", () => {
  test("is rolling and revokes ordinary deletion authority from shared definitions", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    expect(migration).toContain("REVOKE DELETE ON");
    expect(migration).toContain("FROM opengeni_app;");
    for (const table of historicalDefinitionTables) {
      expect(migration).toContain(`"${table}"`);
    }
  });

  test("preserves tenant lifecycle deletion authority", () => {
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON");
    expect(migration).toContain("TO opengeni_app;");
    for (const table of historicalLifecycleTables) {
      expect(migration).toContain(`"${table}"`);
    }
  });

  test("keeps role provisioning aligned with the forward repair", () => {
    for (const table of currentDefinitionTables) {
      expect(RUNTIME_FULL_DML_TABLES).not.toContain(table);
      expect(RUNTIME_READ_INSERT_UPDATE_TABLES).toContain(table);
    }
    for (const table of currentLifecycleTables) {
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });
});
