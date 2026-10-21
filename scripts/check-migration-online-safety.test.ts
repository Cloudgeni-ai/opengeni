import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  ONLINE_SAFETY_FROM_ORDINAL,
  RULES,
  analyzeMigrationOnlineSafety,
  analyzeMigrationOnlineSafetyDirectory,
  type OnlineSafetyRule,
} from "./migration-online-safety";

const directories: string[] = [];
const reason = "This table has exactly one immutable configuration row";
const contract = "-- contract-step: release 1.2 stopped reading and writing this old shape";
const batch = "-- opengeni:batched-backfill batch-size=50 lock-timeout=1s statement-timeout=10s";
const boundedBatch =
  "WITH batch AS (SELECT id FROM t LIMIT 50) UPDATE t SET x=1 FROM batch WHERE t.id=batch.id RETURNING t.id;";
const rolling = (sql: string, header = "") => `-- deployment-mode: rolling\n${header}\n${sql}`;
const maintenance = (sql: string, header = "") =>
  `-- deployment-mode: maintenance\n${header}\n-- maintenance-justification: Previous workers cannot tolerate this one way protocol change\n${sql}`;
const findings = (sql: string) => analyzeMigrationOnlineSafety("5000_test.sql", sql);
const rules = (sql: string) => findings(sql).map((f) => f.rule);
function ledger(...files: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "online-safety-"));
  directories.push(directory);
  files.forEach((sql, i) => writeFileSync(join(directory, `${5000 + i}_test.sql`), sql));
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const violations: Record<OnlineSafetyRule, string> = {
  "nonconcurrent-index": rolling("CREATE INDEX idx ON t (id);"),
  "constraint-validation": rolling(
    "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (x) REFERENCES parent(id);",
  ),
  "table-rewrite": rolling("ALTER TABLE t ALTER COLUMN x TYPE bigint;", contract),
  "unbatched-data": rolling("UPDATE t SET x=1;"),
  "unannotated-contract": rolling("ALTER TABLE t DROP COLUMN old;"),
  "explicit-lock": rolling("LOCK TABLE t IN ACCESS EXCLUSIVE MODE;"),
  "maintenance-concurrent-index": maintenance("CREATE INDEX CONCURRENTLY idx ON t(id);"),
  "maintenance-batched-backfill": maintenance(boundedBatch, batch),
  "maintenance-unbatched-data": maintenance("DELETE FROM t;"),
};

describe("online-safety rules and exceptions", () => {
  for (const rule of Object.keys(RULES) as OnlineSafetyRule[]) {
    test(`${rule}: detects, explains repair, and accepts a justified exception`, () => {
      expect(rules(violations[rule])).toContain(rule);
      const detail = findings(violations[rule]).find((f) => f.rule === rule)!.detail;
      expect(detail).toContain(`-- online-safety-exception: ${rule}:`);
      expect(detail).toContain(RULES[rule]);
      // Preserve the runner directive on line two.
      const lines = violations[rule].split("\n");
      lines.splice(2, 0, `-- online-safety-exception: ${rule}: ${reason}`);
      expect(rules(lines.join("\n"))).not.toContain(rule);
    });
  }
  test("exceptions are per rule, repeated, case tolerant, and header-only", () => {
    const sql = "CREATE INDEX idx ON t(id); UPDATE t SET x=1;";
    expect(
      rules(rolling(sql, `-- ONLINE-SAFETY-EXCEPTION: NONCONCURRENT-INDEX: ${reason}`)),
    ).toEqual(["unbatched-data"]);
    expect(
      rules(
        rolling(
          sql,
          `-- online-safety-exception: nonconcurrent-index: ${reason}\n-- online-safety-exception: unbatched-data: ${reason}`,
        ),
      ),
    ).toEqual([]);
    expect(
      rules(
        rolling(
          `SELECT 1;\n-- online-safety-exception: nonconcurrent-index: ${reason}\nCREATE INDEX idx ON t(id);`,
        ),
      ),
    ).toEqual(["nonconcurrent-index"]);
    for (const value of [
      "small table",
      "TODO explain why this is safe later",
      "<a reason with enough words to pass>",
    ]) {
      expect(
        rules(rolling("UPDATE t SET x=1;", `-- online-safety-exception: unbatched-data: ${value}`)),
      ).toEqual(["unbatched-data"]);
    }
    expect(rules(rolling("SELECT 1;", "-- online-safety-exception: unknown-rule: typo"))).toEqual(
      [],
    );
  });
});

describe("online-safety SQL recognition", () => {
  test("indexes tolerate schema, quotes, case, comments and IF NOT EXISTS", () => {
    expect(
      rules(
        rolling(
          'cReAtE /* explanation */ UNIQUE INDEX IF NOT EXISTS "idx" ON ONLY "public" . "t" (id);',
        ),
      ),
    ).toEqual(["nonconcurrent-index"]);
    expect(rules(rolling("CREATE INDEX ON t(id);"))).toEqual(["nonconcurrent-index"]);
    expect(
      rules(
        rolling(
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON t(id);",
          "-- opengeni:concurrent-index lock-timeout=5s",
        ),
      ),
    ).toEqual([]);
    expect(rules(maintenance("CREATE INDEX idx ON t(id);"))).toEqual([]);
  });
  test("same-file new tables are exempt, existing IF NOT EXISTS targets are not", () => {
    expect(
      rules(
        rolling(
          'CREATE TABLE "a.b" (id int); CREATE INDEX idx ON "public"."a.b" (id); ALTER TABLE "a.b" ADD CHECK(id>0); UPDATE "a.b" SET id=1; TRUNCATE "a.b"; CLUSTER "a.b" USING idx;',
        ),
      ),
    ).toEqual([]);
    expect(
      rules(rolling("CREATE TABLE IF NOT EXISTS t(id int); CREATE INDEX idx ON t(id);")),
    ).toEqual(["nonconcurrent-index"]);
    expect(rules(rolling("DROP TABLE t; CREATE TABLE t(id int);"))).toEqual([
      "unannotated-contract",
    ]);
    expect(rules(rolling("CREATE TABLE t(id int); CREATE INDEX idx ON other.t(id);"))).toEqual([
      "nonconcurrent-index",
    ]);
  });
  test("foreign keys and CHECK require NOT VALID on their own action", () => {
    expect(rules(rolling("ALTER TABLE t ADD CHECK (NOT valid);"))).toEqual([
      "constraint-validation",
    ]);
    expect(rules(rolling("ALTER TABLE t ADD CHECK(x>0);"))).toEqual(["constraint-validation"]);
    expect(rules(rolling("ALTER TABLE t ADD COLUMN x int REFERENCES parent(id);"))).toEqual([
      "constraint-validation",
    ]);
    expect(
      rules(
        rolling(
          "ALTER TABLE t ADD CHECK(x>0) NOT VALID, ADD CONSTRAINT fk FOREIGN KEY(x) REFERENCES parent(id) NOT VALID; ALTER TABLE t VALIDATE CONSTRAINT fk;",
        ),
      ),
    ).toEqual([]);
    expect(rules(rolling("ALTER TABLE t ADD CHECK(x>0) NOT VALID, ADD CHECK(y>0);"))).toEqual([
      "constraint-validation",
    ]);
    expect(rules(rolling("ALTER TABLE t ADD CHECK(x>0) /* NOT VALID */;"))).toEqual([
      "constraint-validation",
    ]);
  });
  for (const sql of [
    "ALTER TABLE t ALTER COLUMN x TYPE text;",
    "ALTER TABLE t ALTER x SET DATA TYPE text;",
    "ALTER TABLE t ALTER x SET NOT NULL;",
    "ALTER TABLE t ADD PRIMARY KEY(id);",
    "ALTER TABLE t ADD UNIQUE(id);",
    "ALTER TABLE t SET TABLESPACE fast;",
    "ALTER TABLE t SET ACCESS METHOD heap;",
    "ALTER TABLE t ADD COLUMN x int GENERATED ALWAYS AS (y+1) STORED;",
    "CLUSTER t USING idx;",
    "VACUUM FULL t;",
    "VACUUM (ANALYZE, FULL) t;",
  ])
    test(`table rewrite: ${sql}`, () =>
      expect(rules(rolling(sql, contract))).toContain("table-rewrite"));
  test("default policy catches listed functions, not constants or SET DEFAULT", () => {
    expect(rules(rolling('ALTER TABLE t ADD COLUMN x uuid DEFAULT "gen_random_uuid"();'))).toEqual([
      "table-rewrite",
    ]);
    expect(rules(rolling("ALTER TABLE t ALTER COLUMN x SET DEFAULT type();"))).toEqual([]);
    for (const fn of [
      "now",
      "random",
      "gen_random_uuid",
      "nextval",
      "clock_timestamp",
      "uuid_generate_v4",
    ]) {
      expect(rules(rolling(`ALTER TABLE t ADD COLUMN x text DEFAULT pg_catalog.${fn}();`))).toEqual(
        ["table-rewrite"],
      );
    }
    expect(
      rules(
        rolling(
          "ALTER TABLE t ADD COLUMN x text DEFAULT 'now()', ADD COLUMN y int DEFAULT 0; ALTER TABLE t ALTER x SET DEFAULT now();",
        ),
      ),
    ).toEqual([]);
    expect(
      rules(
        rolling(
          'ALTER TABLE t ALTER COLUMN "type" SET DEFAULT 0; ALTER TABLE t CLUSTER ON idx; VACUUM ANALYZE t;',
        ),
      ),
    ).toEqual([]);
  });
  test("unique constraint can attach only an earlier concurrent unique index on that table", () => {
    for (const [index, expected] of [
      ["CREATE UNIQUE INDEX CONCURRENTLY idx ON t(id);", []],
      ["CREATE UNIQUE INDEX idx ON t(id);", ["table-rewrite"]],
      ["CREATE INDEX CONCURRENTLY idx ON t(id);", ["table-rewrite"]],
      ["CREATE UNIQUE INDEX CONCURRENTLY idx ON other(id);", ["table-rewrite"]],
      ["CREATE UNIQUE INDEX CONCURRENTLY idx ON t(id) WHERE active;", ["table-rewrite"]],
    ] as const) {
      const dir = ledger(
        rolling(index),
        rolling("ALTER TABLE t ADD CONSTRAINT u UNIQUE USING INDEX idx;"),
      );
      expect(
        analyzeMigrationOnlineSafetyDirectory(dir)
          .filter((f) => f.file.startsWith("5001"))
          .map((f) => f.rule),
      ).toEqual([...expected]);
    }
    expect(
      rules(
        rolling(
          "CREATE UNIQUE INDEX CONCURRENTLY idx ON t(id); ALTER TABLE t ADD UNIQUE USING INDEX idx;",
        ),
      ),
    ).toContain("table-rewrite");
  });
  test("data writes need a real batch directive, not a random WHERE or LIMIT", () => {
    for (const sql of [
      "UPDATE t SET x=1 WHERE done=false;",
      "DELETE FROM ONLY t WHERE id > 0;",
      "WITH b AS (SELECT id FROM t LIMIT 50) UPDATE t SET x=1 FROM b WHERE t.id=b.id RETURNING t.id;",
    ])
      expect(rules(rolling(sql))).toContain("unbatched-data");
    expect(rules(rolling(boundedBatch, batch))).toEqual([]);
    expect(rules(rolling(boundedBatch, `-- explanation\n${batch}`))).toEqual(["unbatched-data"]);
    expect(rules(rolling("UPDATE t SET x=1;", batch))).toEqual(["unbatched-data"]);
    expect(rules(rolling(boundedBatch, "-- opengeni:post-release"))).toEqual(["unbatched-data"]);
    expect(rules(rolling("SELECT 1;", "-- opengeni:pre-release"))).toEqual([]);
  });
  test("known single-row config writes pass; OR, NOT and partial composite keys do not", () => {
    const schema = rolling(
      "CREATE TABLE config (key text PRIMARY KEY, value text); CREATE TABLE multi (a int, b int, PRIMARY KEY(a,b));",
    );
    for (const sql of [
      "UPDATE config SET value='yes' WHERE key='flag';",
      "DELETE FROM config AS c WHERE c.key='flag';",
      "UPDATE multi SET a=1 WHERE a=2 AND b=3;",
    ]) {
      expect(analyzeMigrationOnlineSafetyDirectory(ledger(schema, rolling(sql)))).toEqual([]);
      expect(analyzeMigrationOnlineSafetyDirectory(ledger(schema, maintenance(sql)))).toEqual([]);
    }
    for (const sql of [
      "UPDATE config SET value='yes' WHERE key='flag' OR value='no';",
      "DELETE FROM config WHERE NOT key='flag';",
      "UPDATE multi SET a=1 WHERE a=2;",
      "UPDATE config SET value='yes' WHERE key=lower('flag');",
    ]) {
      expect(
        analyzeMigrationOnlineSafetyDirectory(ledger(schema, rolling(sql))).map((f) => f.rule),
      ).toEqual(["unbatched-data"]);
    }
  });
  test("INSERT SELECT distinguishes new tables, constant CTEs, catalogs and real sources", () => {
    expect(rules(rolling("INSERT INTO t SELECT * FROM old_table;"))).toEqual(["unbatched-data"]);
    expect(
      rules(rolling("WITH rows AS (SELECT * FROM old_table) INSERT INTO t SELECT * FROM rows;")),
    ).toEqual(["unbatched-data"]);
    expect(rules(rolling("WITH rows AS (SELECT 1) INSERT INTO t SELECT * FROM rows;"))).toEqual([]);
    expect(
      rules(
        rolling(
          "CREATE TEMP TABLE stage (id int); INSERT INTO t SELECT * FROM stage; INSERT INTO t SELECT 1; INSERT INTO t VALUES (1);",
        ),
      ),
    ).toEqual([]);
    expect(rules(rolling("INSERT INTO t SELECT oid FROM pg_catalog.pg_class;"))).toEqual([]);
  });
  for (const sql of [
    "DROP TABLE IF EXISTS t;",
    "ALTER TABLE IF EXISTS ONLY t DROP COLUMN IF EXISTS x;",
    "ALTER TABLE t DROP x;",
    "ALTER TABLE t RENAME COLUMN x TO y;",
    "ALTER TABLE t RENAME TO renamed;",
    "TRUNCATE TABLE t;",
    "TRUNCATE t, other;",
  ]) {
    test(`contract annotation: ${sql}`, () => {
      expect(rules(rolling(sql))).toEqual(["unannotated-contract"]);
      expect(rules(rolling(sql, contract))).toEqual([]);
      expect(rules(maintenance(sql))).toEqual([]);
      expect(rules(rolling(sql, "-- contract-step: TODO name the previous release here"))).toEqual([
        "unannotated-contract",
      ]);
    });
  }
  test("non-contract DDL, routine bodies, quoted SQL and comments are not executed", () => {
    expect(
      rules(
        rolling(`
      -- UPDATE t SET x=1; LOCK TABLE t;
      /* outer /* nested */ UPDATE t SET x=1; */
      SELECT 'DELETE FROM t;', $$CREATE INDEX idx ON t(id);$$;
      CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$BEGIN UPDATE t SET x=1; END$$;
      CREATE FUNCTION g() RETURNS text LANGUAGE sql AS 'SELECT ''DELETE FROM t''';
      ALTER TABLE t DROP CONSTRAINT c;
      ALTER TABLE t RENAME CONSTRAINT c TO d;
      DROP INDEX idx;
    `),
      ),
    ).toEqual([]);
    expect(
      rules(rolling('CREATE TABLE "x--y" ("id" int); CREATE INDEX "x;z" ON "x--y"(id);')),
    ).toEqual([]);
  });
  test("static SQL inside DO is inspected, dynamic strings and routine definitions are not", () => {
    expect(
      rules(rolling("DO $$ BEGIN UPDATE t SET x=1; CREATE INDEX idx ON t(id); END $$;")),
    ).toEqual(["unbatched-data", "nonconcurrent-index"]);
    expect(
      rules(
        rolling("DO $$ BEGIN EXECUTE 'UPDATE t SET x=1'; EXECUTE $q$DELETE FROM t$q$; END $$;"),
      ),
    ).toEqual([]);
    expect(
      rules(rolling("DO $$ BEGIN CREATE TABLE t(id int); END $$; CREATE INDEX idx ON t(id);")),
    ).toEqual(["nonconcurrent-index"]);
  });
  test("dollar strings and temporary schemas cannot hide adjacent operations", () => {
    expect(rules(rolling("SELECT $$-- this is data $$; UPDATE t SET x=1;"))).toEqual([
      "unbatched-data",
    ]);
    expect(rules(rolling('DO $$ BEGIN UPDATE "x--y" SET x=1; END $$;'))).toEqual([
      "unbatched-data",
    ]);
    expect(
      rules(
        rolling(
          "CREATE TEMP TABLE t(id int); UPDATE pg_temp.t SET id=1; UPDATE t SET id=1; UPDATE public.t SET id=1;",
        ),
      ),
    ).toEqual(["unbatched-data"]);
    const dir = ledger(
      rolling("CREATE TABLE config (key text PRIMARY KEY, value text)"),
      rolling("UPDATE config SET value='ok' WHERE key='flag';"),
    );
    expect(analyzeMigrationOnlineSafetyDirectory(dir)).toEqual([]);
  });
  test("index proof tracks schemas and invalidation", () => {
    const index = rolling("CREATE UNIQUE INDEX CONCURRENTLY idx ON app.t(id);");
    expect(
      analyzeMigrationOnlineSafetyDirectory(
        ledger(index, rolling("ALTER TABLE app.t ADD UNIQUE USING INDEX idx;")),
      ),
    ).toEqual([]);
    expect(
      analyzeMigrationOnlineSafetyDirectory(
        ledger(index, rolling("ALTER TABLE app.t ADD PRIMARY KEY USING INDEX idx;")),
      ).map((f) => f.rule),
    ).toEqual(["table-rewrite"]);
    expect(
      analyzeMigrationOnlineSafetyDirectory(
        ledger(index, rolling("DROP INDEX app.idx; ALTER TABLE app.t ADD UNIQUE USING INDEX idx;")),
      ).map((f) => f.rule),
    ).toEqual(["table-rewrite"]);
  });
  test("frozen ordinals are excluded without touching migration bytes", () => {
    expect(ONLINE_SAFETY_FROM_ORDINAL).toBe(888);
    expect(
      analyzeMigrationOnlineSafety("0887_frozen.sql", violations["nonconcurrent-index"]),
    ).toEqual([]);
    expect(
      analyzeMigrationOnlineSafety("0888_new.sql", violations["nonconcurrent-index"]),
    ).toHaveLength(1);
    expect(analyzeMigrationOnlineSafety("README.md", violations["nonconcurrent-index"])).toEqual(
      [],
    );
    expect(analyzeMigrationOnlineSafetyDirectory(MIGRATIONS_DIR)).toEqual([]);
    // Ensure the historical audit actually exercises the old governed range.
    const audit = analyzeMigrationOnlineSafetyDirectory(MIGRATIONS_DIR, 786);
    expect(
      audit.some(
        (f) => f.file === "0789_external_vault_sources.sql" && f.rule === "constraint-validation",
      ),
    ).toBe(true);
    for (const file of readdirSync(MIGRATIONS_DIR).filter(
      (f) => /^0[78]\d\d_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < ONLINE_SAFETY_FROM_ORDINAL,
    )) {
      expect(readFileSync(join(MIGRATIONS_DIR, file), "utf8")).not.toContain(
        "-- online-safety-exception:",
      );
    }
  });
});
