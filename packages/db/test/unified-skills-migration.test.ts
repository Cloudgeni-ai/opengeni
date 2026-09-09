import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FORCE_RLS_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

describe("unified Skill migration boundary", () => {
  test("canonical folder aggregation is independent of database collation", async () => {
    for (const path of [
      "../src/skill-metadata-migration.ts",
      "../drizzle/0431_unified_skill_lifecycle.sql",
    ]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      // Both maintenance backfill and ordinary install must store the same
      // byte-ordered folder on C and locale-aware PostgreSQL databases.
      expect(source).toContain('ORDER BY ff.path COLLATE "C"');
      expect(source).not.toMatch(/ORDER BY ff\.path\s*\)/u);
    }
  });
  test("keeps one head and leaves historical hashes/snapshots untouched", async () => {
    const migration = await readFile(
      new URL("../drizzle/0431_unified_skill_lifecycle.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("-- deployment-mode: maintenance");
    expect(migration).not.toMatch(/CREATE TABLE (?:skill_heads|skill_revisions)/u);
    expect(migration).not.toMatch(/UPDATE preference_registry_(?:revisions|snapshots)/u);
    expect(migration).not.toMatch(/set_config\('opengeni.principal_kind'/u);
    expect(migration).toContain("service:skill-attempt:");
    expect(migration).toContain("Skill operation key reused with different input");
    expect(migration).toContain("Skill head changed");
    expect(migration).toContain("Learning is Off");
    expect(migration).toContain("skill_guard_legacy_revision");
    expect(migration).toContain("guard_workspace_owned_skill_head_delete");
    expect(migration).toContain("guard_workspace_owned_skill_history_delete");
    expect(migration).toContain("company_brain_pref_receipts_workspace_fk");
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION preference_registry_reject_history_mutation/u,
    );
  });
  test("registers read-only tables and exact runtime capability", () => {
    for (const table of ["skill_source_bindings", "skill_write_receipts"]) {
      expect(FORCE_RLS_TABLES as readonly string[]).toContain(table);
      expect(RUNTIME_READ_ONLY_TABLES as readonly string[]).toContain(table);
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "skill_apply_lifecycle(uuid, uuid, jsonb, jsonb)",
    );
  });
});
