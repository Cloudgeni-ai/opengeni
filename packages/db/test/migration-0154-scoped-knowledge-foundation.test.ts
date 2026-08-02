import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

const tables = [
  "knowledge_providers",
  "knowledge_sources",
  "knowledge_source_acl_versions",
  "knowledge_sync_runs",
  "knowledge_source_objects",
  "knowledge_document_versions",
  "knowledge_lifecycle_events",
  "knowledge_entities",
  "knowledge_entity_aliases",
  "knowledge_facts",
  "knowledge_claims",
  "knowledge_claim_relations",
  "knowledge_claim_evidence",
  "knowledge_claim_reviews",
  "knowledge_change_proposals",
] as const;

describe("scoped-knowledge foundation migration", () => {
  test("is additive, rolling, FORCE-RLS protected, and uses the current free ordinal", async () => {
    const sql = await readFile(join(migrationsDir, "0154_scoped_knowledge_foundation.sql"), "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of tables) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("ALTER TABLE %I ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("opengeni_private.scoped_knowledge_scope_visible");
    expect(sql).toContain("opengeni_private.scoped_knowledge_actor_authorized");
    expect(sql).toContain("CREATE POLICY scoped_knowledge_select");
    expect(sql).toContain("CREATE POLICY scoped_knowledge_insert");
    expect(sql).toContain("CREATE POLICY scoped_knowledge_update");
    expect(sql).toContain("FOREIGN KEY (scope_workspace_id, account_id)");
    expect(sql).toContain("REFERENCES workspaces(id, account_id)");
    expect(sql).toContain("knowledge_lifecycle_events_target_operation_uq");
    expect(sql).toContain("NULLS NOT DISTINCT");
    expect(sql).toContain("scoped_knowledge_apply_lifecycle");
    expect(sql).toContain("scoped_knowledge_advance_source_acl");
    expect(sql).toContain("scoped_knowledge_complete_sync");
    expect(sql).toContain("scoped_knowledge_advance_object_version");
  });

  test("keeps provenance immutable and lifecycle restoration explicit", async () => {
    const sql = await readFile(join(migrationsDir, "0154_scoped_knowledge_foundation.sql"), "utf8");
    expect(sql).toContain("scoped_knowledge_reject_immutable_mutation");
    expect(sql).toContain("scoped_knowledge_guard_head_insert");
    expect(sql).toContain("scoped_knowledge_guard_acl_insert");
    expect(sql).toContain("scoped_knowledge_guard_sync_insert");
    expect(sql).toContain("scoped_knowledge_guard_version_insert");
    expect(sql).toContain("ordinary lifecycle mutation cannot resurrect a knowledge tombstone");
    expect(sql).toContain("only a tombstoned knowledge target can be restored");
    expect(sql).toContain("knowledge claim supersession cannot create a cycle");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(sql).toContain(
      "knowledge source object document bridge is outside its exact account/workspace",
    );
    expect(sql).toContain("knowledge_source_objects_source_identity_uq");
    expect(sql).toContain('FOREIGN KEY ("account_id", "object_id", "source_id", "scope_key")');
    expect(sql).toContain("knowledge claim evidence chunk bridge is not exact");
  });

  test("creates proposals only and does not duplicate or activate existing authorities", async () => {
    const sql = await readFile(join(migrationsDir, "0154_scoped_knowledge_foundation.sql"), "utf8");
    expect(sql).toContain("\"status\" text NOT NULL DEFAULT 'proposed'");
    expect(sql).not.toContain("workspace_charters");
    expect(sql).not.toContain("knowledge_bank_state");
    expect(sql).not.toContain("workspace_instruction_policy_heads");
    expect(sql).not.toContain("preference_registry_preferences");
    expect(sql).not.toContain("knowledge_memories");
    expect(sql).not.toContain("acl_tags");
    const executableSql = sql.replace(/^--.*$/gm, "");
    expect(executableSql).not.toMatch(/prompt|mcp|http|sdk|route|slack|google_drive/i);
  });
});
