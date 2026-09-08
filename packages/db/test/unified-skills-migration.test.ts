import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  FORCE_RLS_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

describe("unified Skill migration boundary", () => {
  test("keeps one head and leaves historical hashes/snapshots untouched", async () => {
    const migration = await readFile(
      new URL("../drizzle/0426_unified_skill_lifecycle.sql", import.meta.url),
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
