import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  GRANDFATHERED_MIGRATIONS,
  GRANDFATHERED_VACUOUS_GUARDS,
  MIGRATIONS_DIR,
  analyzeMigrationRlsBackfills,
  readsTable,
  splitStatements,
  staleAllowlistEntries,
  unreviewedFindings,
  writesTable,
} from "./migration-rls-backfills";

const temporaryDirectories: string[] = [];

function fixture(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "og-rls-backfill-"));
  temporaryDirectories.push(directory);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(directory, name), body, "utf8");
  }
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const FORCED_TABLE = `
CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "workspace_id" uuid, "origin_workspace_id" uuid);
ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "widgets"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
`;

describe("splitStatements", () => {
  test("keeps a dollar-quoted body as one statement", () => {
    const statements = splitStatements(
      `SELECT 1;\nDO $tag$ BEGIN UPDATE x SET y = 1; END $tag$;\nSELECT 2;`,
    );
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("END $tag$");
  });

  test("does not split on a semicolon inside a string or comment", () => {
    const statements = splitStatements(`SELECT ';'; -- trailing ; comment\nSELECT 2;`);
    expect(statements).toHaveLength(2);
  });
});

describe("writesTable", () => {
  test("matches quoted and bare targets but not a same-named string literal", () => {
    expect(writesTable(`UPDATE "widgets" SET a = 1`, "widgets")).toBe(true);
    expect(writesTable(`INSERT INTO widgets (a) SELECT 1`, "widgets")).toBe(true);
    expect(writesTable(`DELETE FROM ONLY widgets`, "widgets")).toBe(true);
    expect(writesTable(`SELECT 1 WHERE tablename = 'widgets'`, "widgets")).toBe(false);
    expect(writesTable(`UPDATE widgets_archive SET a = 1`, "widgets")).toBe(false);
  });

  test("readsTable matches query positions only", () => {
    expect(readsTable(`SELECT 1 FROM "widgets"`, "widgets")).toBe(true);
    expect(readsTable(`SELECT 1 FROM x JOIN widgets ON true`, "widgets")).toBe(true);
    expect(readsTable(`SELECT 1 FROM pg_policies WHERE tablename = 'widgets'`, "widgets")).toBe(
      false,
    );
  });
});

describe("analyzeMigrationRlsBackfills", () => {
  test("flags a bare backfill over a FORCE-RLS table", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `UPDATE "widgets" SET "origin_workspace_id" = "workspace_id" WHERE "origin_workspace_id" IS NULL;`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "0002_backfill.sql",
      kind: "write",
      tables: ["widgets"],
    });
  });

  test("flags a preflight guard that can only ever see zero rows", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM "widgets" WHERE "origin_workspace_id" IS NULL) THEN
    RAISE EXCEPTION 'undrained widgets at cutover';
  END IF;
END $guard$;
`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "vacuous-guard", tables: ["widgets"] });
  });

  test("a preflight guard inside the NO FORCE window is effective", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM "widgets") THEN RAISE EXCEPTION 'undrained'; END IF;
END $guard$;
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a catalog-only drain guard is not flagged", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_guard.sql": `
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = 'opengeni_app') THEN
    RAISE EXCEPTION 'stop every application writer first';
  END IF;
END $guard$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("accepts the owner-only NO FORCE window", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("re-arms once the window closes inside the same file", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;
UPDATE "widgets" SET "origin_workspace_id" = NULL;
`,
    });
    const findings = analyzeMigrationRlsBackfills(directory);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.snippet).toContain("= NULL");
  });

  test("the window does not leak into the next migration file", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_window.sql": `ALTER TABLE "widgets" NO FORCE ROW LEVEL SECURITY;\nALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;`,
      "0003_backfill.sql": `UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("accepts a backfill that sets the tenant GUC first", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
SELECT set_config('opengeni.account_id', '00000000-0000-0000-0000-000000000000', true);
UPDATE "widgets" SET "origin_workspace_id" = "workspace_id";
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("accepts a transaction-local capability pinned to the exact table owner", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("does not trust a custom capability without an exact owner-pinned policy", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a capability policy that is not pinned to the table owner", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_repair ON widgets
USING (pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1');
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust owner-capability policy arms joined with OR", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  OR pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  OR pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a negated owner-capability policy arm", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_repair ON widgets
FOR ALL
USING (NOT (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
))
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("does not trust a read-only owner capability for a write backfill", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_capability.sql": `
CREATE POLICY widgets_owner_read ON widgets
FOR SELECT
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'widgets'::regclass
  )
  AND pg_catalog.current_setting('opengeni.widgets_owner_repair', true) = '1'
);
`,
      "0003_backfill.sql": `
WITH capability AS MATERIALIZED (
  SELECT set_config('opengeni.widgets_owner_repair', '1', true) AS enabled
)
UPDATE widgets
SET origin_workspace_id = workspace_id
FROM capability
WHERE capability.enabled = '1';
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });

  test("ignores a table that only ENABLEd RLS without FORCE", () => {
    const directory = fixture({
      "0001_base.sql": `CREATE TABLE "widgets" ("id" uuid);\nALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;`,
      "0002_backfill.sql": `UPDATE "widgets" SET "id" = "id";`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a DO block that only defines a trigger function is not a migration-time write", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_define.sql": `
DO $session_visibility_cache_stripping$
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.strip_private_session_list_snapshots()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      UPDATE widgets SET id = id;
      RETURN NULL;
    END;
    $body$;
  $ddl$, current_schema());
END
$session_visibility_cache_stripping$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(0);
  });

  test("a DO block that executes DML still counts as a write", () => {
    const directory = fixture({
      "0001_base.sql": FORCED_TABLE,
      "0002_backfill.sql": `
DO $backfill$
BEGIN
  UPDATE widgets SET id = id;
END
$backfill$;
`,
    });
    expect(analyzeMigrationRlsBackfills(directory)).toHaveLength(1);
  });
});

describe("the shipped migration ledger", () => {
  const migrationsDir = join(import.meta.dir, "..", MIGRATIONS_DIR);

  test("has no unreviewed FORCE-RLS backfill", () => {
    const violations = unreviewedFindings(analyzeMigrationRlsBackfills(migrationsDir));
    expect(violations.map((violation) => `${violation.file}:${violation.statement}`)).toEqual([]);
  });

  test("carries no stale grandfathered entry", () => {
    expect(staleAllowlistEntries(migrationsDir)).toEqual([]);
  });

  test("still recognises the three statements 0296 repairs", () => {
    const findings = analyzeMigrationRlsBackfills(migrationsDir).filter(
      (finding) => finding.kind === "write",
    );
    const tablesFor = (file: string) =>
      findings.filter((finding) => finding.file === file).flatMap((finding) => finding.tables);
    expect(tablesFor("0256_connection_authority_delegation.sql")).toContain("connections");
    expect(tablesFor("0262_scoped_connected_machines_and_rigs.sql")).toContain("enrollments");
    expect(tablesFor("0263_organization_membership_lifecycle.sql")).toContain(
      "organization_memberships",
    );
  });

  test("the repair migration itself is protected, not grandfathered", () => {
    const repair = "0296_force_rls_backfill_noop_repair.sql";
    expect(GRANDFATHERED_MIGRATIONS).not.toContain(repair);
    expect(GRANDFATHERED_VACUOUS_GUARDS).not.toContain(repair);
    expect(
      analyzeMigrationRlsBackfills(migrationsDir).filter((finding) => finding.file === repair),
    ).toEqual([]);
  });
});
