import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../drizzle/0423_organization_scoped_external_workspaces.sql", import.meta.url),
  "utf8",
);

// Source-contract checks supplement, never replace, the real PostgreSQL
// provisioning/concurrency suite.
describe("organization-scoped workspace cutover source contract", () => {
  test("requires maintenance and drains runtime roles before and after the lock", () => {
    expect(migration.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    const lock = migration.indexOf("LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE");
    expect(lock).toBeGreaterThan(0);
    expect(migration.slice(0, lock)).toContain("FROM pg_stat_activity");
    expect(migration.slice(lock)).toContain("FROM pg_stat_activity");
    expect(migration).toContain("opengeni.migration_application_roles");
  });

  test("preserves workspace rows and updates both conflict arbiters", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX workspaces_external_idx ON workspaces (account_id, external_source, external_id)",
    );
    expect(migration).toContain("ON CONFLICT (account_id, external_source, external_id) DO UPDATE");
    expect(migration).toContain("organization_membership_command(jsonb)");
    expect(migration).toContain("organization_membership_command_0263(jsonb)");
    expect(migration).toContain("organization membership wrapper drifted");
    expect(migration).not.toMatch(/(?:DELETE FROM|UPDATE|TRUNCATE) workspaces/i);
    expect(migration).toContain("conflict target drifted");
  });
});
