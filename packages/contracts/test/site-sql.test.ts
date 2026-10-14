import { describe, expect, test } from "bun:test";
import {
  SITE_SQL_MAX_PARAMETERS,
  SiteSqlImportRequest,
  SiteSqlQueryDefinitionRequest,
  compileSiteSql,
  isSiteSqlPrincipalParam,
  isSiteSqlTableName,
  matchSiteOperation,
  quoteSiteSqlIdentifier,
  siteDbInternalPath,
  siteSessionPath,
  siteSqlBindings,
  type SiteSqlProfile,
} from "../src";

function problem(sql: string, profile: SiteSqlProfile = "named") {
  const result = compileSiteSql(sql, profile);
  return result.ok ? null : result.problem;
}

function compiled(sql: string, profile: SiteSqlProfile = "named") {
  const result = compileSiteSql(sql, profile);
  if (!result.ok) throw new Error(`${result.problem}: ${result.message}`);
  return result;
}

describe("compileSiteSql", () => {
  test("named queries: one read or write statement with named parameters", () => {
    const read = compiled("SELECT id, title FROM votes WHERE owner = :viewer AND n > :min;");
    expect(read.statements).toEqual([
      {
        sql: "SELECT id, title FROM votes WHERE owner = ? AND n > ?",
        kind: "read",
        params: ["viewer", "min"],
      },
    ]);
    expect(read.paramNames).toEqual(["viewer", "min"]);
    const write = compiled(
      "INSERT INTO votes (owner, choice) VALUES (:viewer, :choice) ON CONFLICT(owner) DO UPDATE SET choice = :choice RETURNING id",
    );
    expect(write.statements[0]!.kind).toBe("write");
    expect(write.statements[0]!.params).toEqual(["viewer", "choice", "choice"]);
    expect(write.paramNames).toEqual(["viewer", "choice"]);
    expect(compiled("WITH t AS (SELECT 1 AS n) SELECT n FROM t").statements[0]!.kind).toBe("read");
    expect(
      compiled("WITH t AS (SELECT 1 AS n) SELECT replace('a', 'a', 'b') FROM t").statements[0]!
        .kind,
    ).toBe("read");
    expect(
      compiled(
        "WITH old AS (SELECT id FROM votes) DELETE FROM votes WHERE id IN (SELECT id FROM old)",
      ).statements[0]!.kind,
    ).toBe("write");
    expect(compiled("REPLACE INTO kv (k, v) VALUES (:k, :v)").statements[0]!.kind).toBe("write");
  });

  test("strings, quoted identifiers and comments never hide or fake statements and parameters", () => {
    const result = compiled(
      `SELECT ':nope; DROP TABLE x', "a;b", [c:d], \`e\` -- trailing ; :comment\nFROM t /* ; :x */ WHERE v = :real`,
    );
    expect(result.paramNames).toEqual(["real"]);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]!.sql).not.toContain("comment");
    expect(compiled("SELECT 'it''s' AS s, x'00ff' AS b").paramNames).toEqual([]);
  });

  test("refuses more than one statement in named and agent profiles", () => {
    expect(problem("SELECT 1; SELECT 2")).toBe("multiple_statements");
    expect(problem("SELECT 1; DELETE FROM t", "agent")).toBe("multiple_statements");
    expect(problem("SELECT 1;;")).toBeNull();
    expect(problem("")).toBe("empty");
    expect(problem(" -- only a comment\n")).toBe("empty");
  });

  test("refuses ATTACH, DETACH, VACUUM, transactions and load_extension in every profile", () => {
    for (const profile of ["named", "agent", "script"] as const) {
      expect(problem("ATTACH DATABASE 'x' AS y", profile)).toBe("attach");
      expect(problem("detach y", profile)).toBe("attach");
      expect(problem("VACUUM INTO '/tmp/x'", profile)).toBe("vacuum");
      expect(problem("BEGIN", profile)).toBe("transaction");
      expect(problem("SAVEPOINT a", profile)).toBe("transaction");
      expect(problem("SELECT load_extension('x')", profile)).toBe("load_extension");
      expect(problem("SELECT \"LOAD_EXTENSION\"('x')", profile)).toBe("load_extension");
    }
    expect(problem("CREATE TABLE a (x); ATTACH 'b' AS b", "script")).toBe("attach");
  });

  test("PRAGMA: never in named queries or scripts; agents read the schema only", () => {
    expect(problem("PRAGMA table_info(votes)")).toBe("pragma");
    expect(problem("PRAGMA table_info(votes)", "script")).toBe("pragma");
    expect(problem("PRAGMA table_info(votes)", "agent")).toBeNull();
    expect(problem("PRAGMA foreign_keys = OFF", "agent")).toBe("pragma");
    expect(problem("PRAGMA writable_schema", "agent")).toBe("pragma");
    expect(problem("PRAGMA main.table_info(votes)", "agent")).toBe("pragma");
  });

  test("named queries cannot change the schema, EXPLAIN or recurse", () => {
    expect(problem("CREATE TABLE x (a)")).toBe("statement_not_allowed");
    expect(problem("DROP TABLE x")).toBe("statement_not_allowed");
    expect(problem("EXPLAIN SELECT 1")).toBe("statement_not_allowed");
    expect(
      problem("WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT n FROM c"),
    ).toBe("recursive");
    expect(problem("CREATE TABLE x (a)", "agent")).toBeNull();
    expect(problem("EXPLAIN QUERY PLAN SELECT 1", "agent")).toBeNull();
    expect(problem("EXPLAIN ATTACH 'x' AS y", "agent")).toBe("attach");
  });

  test("reserved names and parameter styles", () => {
    expect(problem("SELECT * FROM _cf_KV")).toBe("reserved_name");
    expect(problem('SELECT * FROM "_og_migrations"')).toBe("reserved_name");
    expect(problem("SELECT * FROM t WHERE a = ?")).toBe("parameter_style");
    expect(problem("SELECT * FROM t WHERE a = ?1")).toBe("parameter_style");
    expect(problem("SELECT * FROM t WHERE a = @a")).toBe("parameter_style");
    expect(problem("SELECT * FROM t WHERE a = $a")).toBe("parameter_style");
    expect(problem(`SELECT * FROM t WHERE a = :${"x".repeat(65)}`)).toBe("parameter_name");
    const many = Array.from({ length: SITE_SQL_MAX_PARAMETERS + 1 }, (_, i) => `:p${i}`).join(", ");
    expect(problem(`SELECT ${many}`)).toBe("too_many_parameters");
    expect(problem("SELECT 'unterminated")).toBe("syntax");
    expect(problem("SELECT 1 /* unterminated")).toBe("syntax");
  });

  test("scripts: many statements, trigger bodies keep their semicolons", () => {
    const script = compiled(
      `CREATE TABLE votes (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, choice TEXT);
       CREATE INDEX votes_owner ON votes (owner);
       CREATE TRIGGER votes_audit AFTER INSERT ON votes BEGIN
         INSERT INTO audit (what) VALUES (CASE WHEN NEW.choice IS NULL THEN 'none' ELSE NEW.choice END);
         UPDATE counters SET n = n + 1;
       END;
       INSERT INTO votes (owner, choice) VALUES ('a', 'b');`,
      "script",
    );
    expect(script.statements.map((statement) => statement.kind)).toEqual([
      "schema",
      "schema",
      "schema",
      "write",
    ]);
    expect(script.statements[2]!.sql).toContain("UPDATE counters SET n = n + 1;");
    expect(script.statements[2]!.sql.endsWith("END")).toBe(true);
  });

  test("bindings follow the compiled order; booleans bind as integers", () => {
    const statement = compiled("SELECT :a, :b, :a, :missing").statements[0]!;
    expect(siteSqlBindings(statement, { a: true, b: "x" })).toEqual([1, "x", 1, null]);
  });
});

describe("Site SQL helpers", () => {
  test("principal parameters and identifiers", () => {
    expect(isSiteSqlPrincipalParam("viewer")).toBe(true);
    expect(isSiteSqlPrincipalParam("viewer_kind")).toBe(true);
    expect(isSiteSqlPrincipalParam("viewers")).toBe(false);
    expect(isSiteSqlTableName("votes")).toBe(true);
    expect(isSiteSqlTableName("sqlite_master")).toBe(false);
    expect(isSiteSqlTableName("_og_migrations")).toBe(false);
    expect(isSiteSqlTableName("a b")).toBe(false);
    expect(quoteSiteSqlIdentifier('a"b')).toBe('"a""b"');
    expect(siteDbInternalPath("33333333-3333-4333-8333-333333333333", "run")).toBe(
      "/_og/internal/site-db/33333333-3333-4333-8333-333333333333/run",
    );
  });

  test("request schemas", () => {
    expect(SiteSqlQueryDefinitionRequest.safeParse({ sql: "SELECT 1" }).success).toBe(true);
    expect(SiteSqlImportRequest.safeParse({ format: "csv", table: "t" }).success).toBe(false);
    expect(SiteSqlImportRequest.safeParse({ format: "csv", table: "t", csv: "a\n1" }).success).toBe(
      true,
    );
    expect(SiteSqlImportRequest.safeParse({ format: "sql", sql: "SELECT 1" }).success).toBe(true);
  });

  test("the Site operation allowlist admits only named-query runs", () => {
    const base = "/v1/workspaces/site-host/published-artifacts/current/sql";
    expect(matchSiteOperation("POST", `${base}/queries/top_votes`)?.operation.id).toBe("sql.run");
    expect(matchSiteOperation("GET", `${base}/queries/top_votes`)).toBeNull();
    expect(matchSiteOperation("POST", `${base}/queries/1bad`)).toBeNull();
    expect(matchSiteOperation("POST", `${base}/execute`)).toBeNull();
    expect(matchSiteOperation("POST", `${base}/queries/a/b`)).toBeNull();
    expect(siteSessionPath(`${base}/queries/top_votes`, "ws-1", "POST", "site-9")).toBe(
      "/v1/workspaces/ws-1/published-artifacts/site-9/sql/queries/top_votes",
    );
  });
});
