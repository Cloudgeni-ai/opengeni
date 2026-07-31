import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

describe("workspace artifacts migration", () => {
  test("is maintenance-gated, FORCE-RLS protected, immutable, and least privilege", async () => {
    const sql = await readFile(join(migrationsDir, "0144_workspace_artifacts.sql"), "utf8");
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(sql).toContain('CREATE TABLE "workspace_artifacts"');
    expect(sql).toContain('CREATE TABLE "workspace_artifact_versions"');
    expect(sql).toContain('CREATE TABLE "workspace_artifact_events"');
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(sql.match(/CREATE POLICY workspace_isolation/g)).toHaveLength(3);
    expect(sql.match(/opengeni_private\.workspace_rls_visible/g)).toHaveLength(6);
    expect(sql).toContain("workspace_artifact_versions_immutable");
    expect(sql).toContain("workspace_artifact_events_immutable");
    expect(sql).toContain("pg_trigger_depth() > 1");
    expect(sql).toContain("GRANT SELECT, INSERT ON TABLE");
    expect(sql).toContain('"source_attempt_id" uuid');
    expect(sql).toContain('"source_execution_generation" integer');
    expect(sql).toContain("workspace_artifact_versions_provenance_chk");
    expect(sql).toContain("workspace_artifact_events_source_attempt_fk");
    expect(sql).not.toContain('UPDATE "sessions"');
    expect(sql).not.toContain('SET "first_party_mcp_tools"');
    expect(sql).not.toContain('SET "first_party_mcp_permissions"');
  });
});
