import { describe, expect, test } from "bun:test";

import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migration = await Bun.file(
  new URL("../drizzle/0216_pack_component_ownership.sql", import.meta.url),
).text();

describe("Pack component ownership expand migration", () => {
  test("is rolling, additive, online-validated, and runtime-postured", () => {
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/iu);
    for (const column of [
      "version",
      "manifest_snapshot",
      "manifest_digest",
      "selected_rig_id",
      "installed_by_subject_id",
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}"`);
    }
    expect(migration).toContain("NOT VALID");
    expect(migration).toContain("VALIDATE CONSTRAINT");
    expect(FORCE_RLS_TABLES).toContain("pack_installation_components");
    expect(RUNTIME_FULL_DML_TABLES).toContain("pack_installation_components");
  });

  test("creates a normalized FORCE-RLS component ledger", () => {
    expect(migration).toContain('CREATE TABLE "pack_installation_components"');
    expect(migration).toContain(
      'ALTER TABLE "pack_installation_components" ENABLE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain(
      'ALTER TABLE "pack_installation_components" FORCE ROW LEVEL SECURITY;',
    );
    expect(migration).toContain("opengeni_private.workspace_rls_visible(account_id, workspace_id)");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
    for (const kind of ["plugin", "skill", "integration", "feature", "inline_skill"]) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  test("validates frozen Pack identity and every tenant-bearing reference", () => {
    expect(migration).toContain("pack_installations_v2_validate");
    expect(migration).toContain("pack_installation_components_validate");
    expect(migration).toContain("snapshot id does not match pack_id");
    expect(migration).toContain('r."account_id" = NEW."account_id"');
    expect(migration).toContain('r."workspace_id" = NEW."workspace_id"');
    expect(migration).toContain('i."account_id" = NEW."account_id"');
    expect(migration).toContain('i."workspace_id" = NEW."workspace_id"');
    expect(migration).toContain("capability_v2_validate_component_owner");
    expect(migration).toContain("capability_v2_validate_feature_binding_owner");
    expect(migration).toContain(
      "plugin component owner belongs to another tenant or does not exist",
    );
    expect(migration).toContain("Pack component owner belongs to another tenant or does not exist");
    expect(migration).toContain(
      "plugin feature binding owner belongs to another tenant or does not exist",
    );
    expect(migration).toContain(
      "Pack feature binding owner belongs to another tenant or does not exist",
    );
  });
});
