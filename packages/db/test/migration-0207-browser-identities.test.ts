import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationName = "0207_browser_identities.sql";
const migrationUrl = new URL(`../drizzle/${migrationName}`, import.meta.url);

describe("migration 0207 browser identities", () => {
  test("installs immutable identity lineage and encrypted-artifact authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain('CREATE TABLE "browser_identities"');
    expect(source).toContain('CREATE TABLE "browser_revisions"');
    expect(source).toContain('CREATE TABLE "browser_state_artifacts"');
    expect(source).toContain('CREATE TABLE "browser_revision_components"');
    expect(source).toContain('"browser_revisions_parent_fk"');
    expect(source).toContain('"browser_identities_default_revision_fk"');
    expect(source).toContain("'publish'");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).toContain('CREATE TRIGGER "browser_identities_update_guard_trg"');
    expect(source).toContain('CREATE TRIGGER "browser_state_artifacts_update_guard_trg"');
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.browser_state_artifacts_update_guard()",
    );

    const blank = await acquireBlankTestDatabase("migration-0207");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<Array<{ name: string; rlsEnabled: boolean; rlsForced: boolean }>>`
        select c.relname as name, c.relrowsecurity as "rlsEnabled",
          c.relforcerowsecurity as "rlsForced"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname in (
            'browser_identities', 'browser_revisions',
            'browser_state_artifacts', 'browser_revision_components'
          )
        order by c.relname`;
      expect(tables).toHaveLength(4);
      for (const table of tables) {
        expect(table).toMatchObject({ rlsEnabled: true, rlsForced: true });
      }

      const grants = await sql<
        Array<{
          name: string;
          select: boolean;
          insert: boolean;
          update: boolean;
          delete: boolean;
        }>
      >`
        select name,
          has_table_privilege('opengeni_app', name, 'select') as select,
          has_table_privilege('opengeni_app', name, 'insert') as insert,
          has_table_privilege('opengeni_app', name, 'update') as update,
          has_table_privilege('opengeni_app', name, 'delete') as delete
        from unnest(array[
          'browser_identities', 'browser_revisions',
          'browser_state_artifacts', 'browser_revision_components'
        ]) as name
        order by name`;
      expect([...grants]).toEqual([
        {
          name: "browser_identities",
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
        {
          name: "browser_revision_components",
          select: true,
          insert: true,
          update: false,
          delete: false,
        },
        {
          name: "browser_revisions",
          select: true,
          insert: true,
          update: false,
          delete: false,
        },
        {
          name: "browser_state_artifacts",
          select: true,
          insert: true,
          update: true,
          delete: false,
        },
      ]);

      const constraints = await sql<Array<{ name: string; definition: string }>>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conname in (
          'browser_revisions_parent_fk',
          'browser_revisions_publication_operation_fk',
          'browser_revision_components_revision_fk',
          'browser_revision_components_artifact_fk',
          'browser_identities_default_revision_fk',
          'browser_sessions_base_revision_fk',
          'browser_sessions_private_checkpoint_fk',
          'interaction_operations_kind_check'
        )
        order by conname`;
      expect(constraints).toHaveLength(8);
      expect(
        constraints.find((constraint) => constraint.name === "browser_revisions_parent_fk")
          ?.definition,
      ).toContain("FOREIGN KEY (identity_id, parent_revision_id)");
      expect(
        constraints.find((constraint) => constraint.name === "interaction_operations_kind_check")
          ?.definition,
      ).toContain("'publish'::text");
      expect(
        constraints.find(
          (constraint) => constraint.name === "browser_revision_components_revision_fk",
        )?.definition,
      ).toContain(
        "FOREIGN KEY (workspace_id, identity_id, revision_id, source_browser_session_id)",
      );
      expect(
        constraints.find(
          (constraint) => constraint.name === "browser_revision_components_artifact_fk",
        )?.definition,
      ).toContain(
        "FOREIGN KEY (workspace_id, artifact_id, artifact_purpose, source_browser_session_id, kind)",
      );
      expect(
        constraints.find(
          (constraint) => constraint.name === "browser_revisions_publication_operation_fk",
        )?.definition,
      ).toContain("FOREIGN KEY (workspace_id, publication_operation_id)");

      const triggers = await sql<Array<{ name: string }>>`
        select tgname as name
        from pg_trigger
        where not tgisinternal
          and tgname in (
            'browser_identities_update_guard_trg',
            'browser_state_artifacts_update_guard_trg'
          )
        order by tgname`;
      expect(triggers.map((trigger) => trigger.name)).toEqual([
        "browser_identities_update_guard_trg",
        "browser_state_artifacts_update_guard_trg",
      ]);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
