import { expect, test } from "bun:test";

test("pins expand private metadata through fixed-path scoped capabilities without altering old publication APIs", async () => {
  const source = await Bun.file(
    new URL("../drizzle/0609_artifact_catalog_pins.sql", import.meta.url),
  ).text();
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  expect(source).toContain("PRIMARY KEY (account_id, workspace_id, kind, artifact_id)");
  expect(source).toContain("FORCE ROW LEVEL SECURITY");
  expect(source).toContain("workspace_rls_visible(account_id, workspace_id)");
  expect(source).toContain("ON CONFLICT DO NOTHING");
  expect(source).toContain("pg_advisory_xact_lock");
  expect(source).toContain("f.private_owner_subject_ids");
  expect(source).toContain("a.modality=p_kind");
  expect(source).toContain("ORDER BY c.pinned DESC");
  expect(source).toContain("c.pinned<v_after_pinned");
  expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
  expect(source).not.toContain("CREATE OR REPLACE");
  expect(source).not.toMatch(
    /CREATE (?:OR REPLACE )?FUNCTION opengeni_private\.list_sandbox_file_publications\(/,
  );
  expect(source).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL)\b/);
});
