import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MIGRATIONS_DIR,
  analyzeMigrationRlsBackfills,
  readsTable,
  splitStatements,
  stripComments,
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

const CATALOG_WINDOW = `
CREATE TEMP TABLE saved_forced_tables ON COMMIT DROP AS
SELECT class.oid::regclass AS relation FROM pg_class class
WHERE class.oid IN ('widgets'::regclass) AND class.relforcerowsecurity;
DO $open_window$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM saved_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $open_window$;
UPDATE widgets SET origin_workspace_id = workspace_id;
DO $close_window$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM saved_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $close_window$;
`;

describe("catalog-filtered owner posture window", () => {
  const analyze = (window: string, extra: Record<string, string> = {}) =>
    analyzeMigrationRlsBackfills(
      fixture({
        "0001_base.sql": FORCED_TABLE,
        "0002_window.sql": window,
        ...extra,
      }),
    );

  test("accepts the exact closed regclass window", () => {
    expect(analyze(CATALOG_WINDOW)).toEqual([]);
  });
  test.each([
    ["missing restore", CATALOG_WINDOW.slice(0, CATALOG_WINDOW.indexOf("DO $close_window$"))],
    ["unfiltered snapshot", CATALOG_WINDOW.replace(" AND class.relforcerowsecurity", "")],
    ["unbounded catalog", CATALOG_WINDOW.replace("class.oid IN ('widgets'::regclass) AND ", "")],
    [
      "policy bypass",
      CATALOG_WINDOW.replace(
        "UPDATE widgets",
        "CREATE POLICY bypass ON widgets USING (true); UPDATE widgets",
      ),
    ],
    [
      "extra open-loop policy",
      CATALOG_WINDOW.replace(
        "END $open_window$",
        "CREATE POLICY bypass ON widgets USING (true); END $open_window$",
      ),
    ],
    [
      "snapshot tampering",
      CATALOG_WINDOW.replace("UPDATE widgets", "DELETE FROM saved_forced_tables; UPDATE widgets"),
    ],
    [
      "different restore snapshot",
      CATALOG_WINDOW.replace(
        "FROM saved_forced_tables ORDER BY relation::text LOOP\n    EXECUTE format('ALTER TABLE %s FORCE",
        "FROM other_tables ORDER BY relation::text LOOP\n    EXECUTE format('ALTER TABLE %s FORCE",
      ),
    ],
  ])("rejects %s", (_label, window) => {
    expect(analyze(window)).toContainEqual(
      expect.objectContaining({ kind: "write", tables: ["widgets"] }),
    );
  });
  test("only listed tables receive owner visibility", () => {
    expect(
      analyze(CATALOG_WINDOW.replace("'widgets'::regclass", "'other_table'::regclass")),
    ).toHaveLength(1);
  });
  test("re-arms after close and in the next file", () => {
    const findings = analyze(`${CATALOG_WINDOW}\nUPDATE widgets SET origin_workspace_id = NULL;`, {
      "0003_after.sql": "UPDATE widgets SET origin_workspace_id = NULL;",
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.file)).toEqual(["0002_window.sql", "0003_after.sql"]);
  });
});

describe("the shipped migrations", () => {
  test("have no FORCE-RLS backfill without an owner-visible window", () => {
    const violations = analyzeMigrationRlsBackfills(join(import.meta.dir, "..", MIGRATIONS_DIR));
    expect(violations.map((violation) => `${violation.file}:${violation.statement}`)).toEqual([]);
  });
});

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
  test("0995 catalog definition classification requires exact statement bytes", () => {
    const patch = readFileSync(
      new URL(
        "../packages/db/drizzle/0995_membership_same_role_keeps_authority.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE.replaceAll("widgets", "organization_memberships"),
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toEqual([]);
    // Even comment-only drift loses the exact source classification.
    expect(
      analyze(patch.replace("-- Resolve in this deployment", "-- Resolve in the deployment")),
    ).toMatchObject([{ kind: "write", tables: ["organization_memberships"] }]);
    expect(
      analyze(patch.replace("END\n$patch$", "DELETE FROM organization_memberships; END\n$patch$")),
    ).toMatchObject([{ kind: "write", tables: ["organization_memberships"] }]);
    expect(analyze(`${patch}\nDELETE FROM organization_memberships;`)).toMatchObject([
      { kind: "write", statement: 4, tables: ["organization_memberships"] },
    ]);
    expect(
      analyze(
        `${patch}\nDO $guard$ BEGIN IF EXISTS (SELECT 1 FROM organization_memberships) THEN RAISE EXCEPTION 'actual guard'; END IF; END $guard$;`,
      ),
    ).toMatchObject([
      { kind: "vacuous-guard", statement: 4, tables: ["organization_memberships"] },
    ]);
    const changedDynamicSql = patch
      .replace(/anchor := \$old\$[\s\S]*?\$old\$;/, "anchor := $old$OR REPLACE FUNCTION$old$;")
      .replace(
        /\$new\$[\s\S]*?\$new\$/,
        "$new$TABLE scratch (id int); DELETE FROM organization_memberships; CREATE OR REPLACE FUNCTION$new$",
      );
    expect(analyze(changedDynamicSql)).toMatchObject([
      { kind: "write", tables: ["organization_memberships"] },
    ]);
  });

  test("distinguishes catalog routine patches from executed dynamic SQL and real guards", () => {
    const patch = `DO $patch$ DECLARE definition text; replacement text; anchor text;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
replacement := $body$ IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'runtime only'; END IF; $body$;
IF definition IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace(
          "END $patch$",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; END $patch$",
        ),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE replace(definition, anchor, replacement);", "EXECUTE replacement;"),
      ),
    ).toHaveLength(1);
    expect(
      analyze(patch.replace("EXECUTE replace", "definition := 'SELECT 1'; EXECUTE replace")),
    ).toHaveLength(1);
  });
  test("treats a replacement initialised in DECLARE as the same catalog routine patch", () => {
    const patch = `DO $patch$ DECLARE definition text;
  anchor text := $old$ RETURN NULL; $old$;
  replacement text := $new$ SELECT id INTO v_row FROM widgets WHERE id = NEW.id; RETURN NULL; $new$;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'anchor drifted'; END IF;
EXECUTE replace(definition, anchor, replacement);
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace(
          "END $patch$",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; END $patch$",
        ),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE replace(definition, anchor, replacement);", "EXECUTE replacement;"),
      ),
    ).toHaveLength(1);
  });
  test("ignores chained pg_get_functiondef replacements but still sees independent writes", () => {
    const patch = `DO $patch$ DECLARE definition text;
BEGIN
definition := pg_get_functiondef('example()'::regprocedure);
IF definition IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
definition := replace(definition, 'anchor one', 'DELETE FROM widgets;');
definition := replace(definition, 'anchor two', 'UPDATE widgets SET id = id;');
EXECUTE definition;
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    expect(
      analyze(
        patch.replace("EXECUTE definition;", "EXECUTE definition; UPDATE widgets SET id = id;"),
      ),
    ).toHaveLength(1);
    expect(
      analyze(
        patch.replace("EXECUTE definition;", "EXECUTE 'DELETE FROM widgets'; EXECUTE definition;"),
      ),
    ).toHaveLength(1);
    // Dollar-quoted fragments may hold unbalanced parentheses and semicolons.
    const fragments = patch
      .replace(
        "'anchor one', 'DELETE FROM widgets;'",
        "$a$f(x$a$, $b$f(g(x, (SELECT 1 FROM widgets);$b$",
      )
      .replace("'anchor two', 'UPDATE widgets SET id = id;'", "$c$) y$c$, $c$) z FROM widgets$c$");
    expect(analyze(fragments)).toHaveLength(0);
    expect(
      analyze(fragments.replace("EXECUTE definition;", "EXECUTE definition; DELETE FROM widgets;")),
    ).toHaveLength(1);
  });
  test("treats pg_catalog-qualified routine patch built-ins like their bare forms", () => {
    // Comment stripping keeps literals whole but still strips code comments.
    expect(stripComments("SELECT '-- kept' -- don't keep\nFROM t")).toBe(
      "SELECT '-- kept'  \nFROM t",
    );
    expect(stripComments("x := E'it\\'s -- kept\\n'; /* it's gone */ y")).toBe(
      "x := E'it\\'s -- kept\\n';   y",
    );
    expect(stripComments("x := 'a''b -- kept'; z")).toBe("x := 'a''b -- kept'; z");
    expect(stripComments("DO $b$ BEGIN -- gone\nUPDATE widgets SET id = id; END $b$")).toBe(
      "DO $b$ BEGIN  \nUPDATE widgets SET id = id; END $b$",
    );
    // Comment text can never suppress a finding, even after an apostrophe in a
    // nested dollar-quoted string keeps that comment visible to the lexer.
    const analyzeOne = (sql: string) =>
      analyzeMigrationRlsBackfills(fixture({ "0001_base.sql": FORCED_TABLE, "0002_x.sql": sql }));
    const nested = `DO $b$ BEGIN
RAISE NOTICE '%', $m$it's a backfill$m$;
-- SUPPRESSOR
UPDATE widgets SET id = id;
END $b$;`;
    for (const suppressor of [
      "TODO: ALTER TABLE widgets NO FORCE ROW LEVEL SECURITY first",
      "TODO: ALTER TABLE widgets DISABLE ROW LEVEL SECURITY first",
      "PERFORM set_config('opengeni.workspace_id', 'x', true);",
    ]) {
      expect(analyzeOne(nested.replace("SUPPRESSOR", suppressor))).toMatchObject([
        { kind: "write", tables: ["widgets"] },
      ]);
    }
    expect(
      analyzeOne("DO $b$ BEGIN PERFORM '--'; UPDATE widgets SET id = id; END $b$;"),
    ).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
    const patch = `DO $patch$ DECLARE target regprocedure; definition text;
BEGIN
target := pg_catalog.to_regprocedure('example()');
IF target IS NULL THEN RAISE EXCEPTION 'missing catalog routine'; END IF;
definition := pg_catalog.pg_get_functiondef(target);
definition := pg_catalog.replace(definition, 'anchor one', E'  -- runtime note\\n' || E'IF NOT EXISTS (SELECT 1 FROM widgets)\\n');
definition := pg_catalog.replace(definition, 'anchor two', 'DELETE FROM widgets;');
EXECUTE definition;
END $patch$;`;
    const analyze = (sql: string) =>
      analyzeMigrationRlsBackfills(
        fixture({
          "0001_base.sql": FORCED_TABLE,
          "0002_patch.sql": sql,
        }),
      );
    expect(analyze(patch)).toHaveLength(0);
    // Only pg_catalog is equivalent; any other schema stays opaque.
    expect(
      analyze(patch.replace("pg_catalog.pg_get_functiondef", "other.pg_get_functiondef")),
    ).toHaveLength(1);
    expect(
      analyze(patch.replaceAll("pg_catalog.replace(definition", "other.replace(definition")),
    ).toHaveLength(1);
    // A real guard or write outside the replacements is still visible.
    expect(
      analyze(
        patch.replace(
          "EXECUTE definition;",
          "IF EXISTS (SELECT 1 FROM widgets) THEN RAISE EXCEPTION 'real guard'; END IF; EXECUTE definition;",
        ),
      ),
    ).toMatchObject([{ kind: "vacuous-guard", tables: ["widgets"] }]);
    expect(
      analyze(patch.replace("EXECUTE definition;", "EXECUTE definition; DELETE FROM widgets;")),
    ).toMatchObject([{ kind: "write", tables: ["widgets"] }]);
  });
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
