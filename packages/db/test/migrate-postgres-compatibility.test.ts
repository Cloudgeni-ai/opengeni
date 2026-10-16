import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";
import { migrationSqlForServer } from "../src/migration-postgres-compatibility";

const fence = "0345_tenant_scoped_session_tenancy_fence.sql";
const pools = "0598_claude_subscription_account_pools.sql";
const sources = new Map(
  await Promise.all(
    [fence, pools].map(
      async (file) =>
        [file, await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8")] as const,
    ),
  ),
);

function connection(version: string) {
  const inspections: string[] = [];
  const statements: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      inspections.push(strings.join("?"));
      return Promise.resolve([{ version }]);
    },
    {
      unsafe: async (text: string) => {
        statements.push(text);
      },
    },
  ) as unknown as postgres.Sql;
  return { sql, inspections, statements };
}

describe("immutable historical PostgreSQL catalog compatibility", () => {
  test("deployed migration bytes retain their original release-schema identities", () => {
    expect(createHash("sha256").update(sources.get(fence)!).digest("hex")).toBe(
      "6661f19636089871c25d6496d2baa14b502cc875b01c3e5a4ce2869e8c046f97",
    );
    expect(createHash("sha256").update(sources.get(pools)!).digest("hex")).toBe(
      "09b62695ae4ed1b64c780b7d970c819b1433cba1cdea31fb76b6b7b29793dde3",
    );
  });

  for (const version of ["160011", "170007"]) {
    test(`PostgreSQL ${version} executes both historical sources verbatim`, async () => {
      for (const [file, source] of sources) {
        const db = connection(version);
        expect(await migrationSqlForServer(db.sql, file, source)).toBe(source);
        expect(db.inspections).toHaveLength(1);
      }
    });
  }

  test("PostgreSQL 18 excludes only the three 0345 catalog counts, retaining every other check", async () => {
    const source = sources.get(fence)!;
    const executable = await migrationSqlForServer(connection("180000").sql, fence, source);
    expect(executable.match(/AND constraint_value.contype <> 'n'/g)).toHaveLength(3);
    expect(executable.replaceAll(" AND constraint_value.contype <> 'n'", "")).toBe(source);
    expect(executable).toContain("attribute.attnotnull::text");
    expect(executable).toContain("session tenancy target registry column drift");
    expect(executable).toContain("session tenancy inventory ledger column drift");
    expect(executable).toContain("shared session tenancy capability function ACL drift");
  });

  test("PostgreSQL 18 does not copy NOT NULL twice in 0598 or alter its codec stage", async () => {
    const source = sources.get(pools)!;
    const executable = await migrationSqlForServer(connection("180001").sql, pools, source);
    expect(executable.match(/AND contype <> 'n'/g)).toHaveLength(1);
    expect(executable.replace(" AND contype <> 'n'", "")).toBe(source);
    expect(executable).toContain("LIKE");
  });

  test("unrelated sources, even matching ordinals, never inspect or change the server", async () => {
    const db = connection("180000");
    for (const file of ["0345_other.sql", "0598_other.sql", "toString", "0799_new.sql"]) {
      const source = "SELECT * FROM pg_constraint;";
      expect(await migrationSqlForServer(db.sql, file, source)).toBe(source);
    }
    expect(db.inspections).toEqual([]);
  });

  test("modified historical sources fail before DDL instead of silently adapting arbitrary SQL", async () => {
    for (const [file, source] of sources) {
      const db = connection("180000");
      await expect(executeMigrationFile(db.sql, file, source + "\n")).rejects.toThrow(
        "immutable deployed source",
      );
      expect(db.statements).toEqual([]);
    }
  });

  test("an invalid server version fails before DDL", async () => {
    const db = connection("unknown");
    await expect(executeMigrationFile(db.sql, fence, sources.get(fence)!)).rejects.toThrow(
      "cannot determine PostgreSQL migration compatibility",
    );
    expect(db.statements).toEqual([]);
  });

  test("the ordinary migration runner uses the adapter under its existing transaction preamble", async () => {
    const db = connection("180000");
    await executeMigrationFile(db.sql, fence, sources.get(fence)!);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain("pg_catalog.set_config('lock_timeout', '5s', true)");
    expect(db.statements[0]?.match(/AND constraint_value.contype <> 'n'/g)).toHaveLength(3);
    expect(db.inspections[0]).toContain("pg_catalog.current_setting('server_version_num')");
  });
});
