import { describe, expect, test } from "bun:test";
import { planMigrationMoves, type RepoFile } from "./renumber";

const text = (value: string, oid = `oid-${value.length}`): RepoFile => ({
  text: value,
  mode: "100644",
  oid,
});
const DIR = "packages/db/drizzle";
const TESTS = "packages/db/test";

describe("planMigrationMoves", () => {
  test("a changed file naming the number bare, unattributed, leaves the move to a person", () => {
    const plan = planMigrationMoves({
      paths: [`${DIR}/1071_usage.sql`],
      ledger: ["1070_a.sql", "1071_main.sql", "1071_usage.sql", "README.md"],
      files: new Map([
        [`${DIR}/1071_usage.sql`, text("-- drain 1071\nselect 1;\n", "sql")],
        [`${TESTS}/migration-1071-usage.test.ts`, text('read("1071_usage.sql");\n')],
        [".changeset/usage.md", text("Adds `1071_usage`.\n")],
        ["packages/db/src/usage.ts", text("export const unrelated = 1071;\n")],
        ["assets/logo.png", text("binary-ish 1071")],
      ]),
    });
    expect(plan.kind).toBe("manual");
  });

  test("moves above main and every number other queued PRs add", () => {
    const plan = planMigrationMoves({
      paths: [`${DIR}/1071_usage.sql`],
      ledger: ["1070_a.sql", "1071_main.sql", "1071_usage.sql"],
      reserved: [1072, 1074],
      files: new Map([
        [`${DIR}/1071_usage.sql`, text("select 1;\n", "sql")],
        [`${TESTS}/migration-1071-usage.test.ts`, text('read("1071_usage.sql");\n')],
        [".changeset/usage.md", text("Adds `1071_usage` (1071).\n")],
        ["packages/db/src/usage.ts", text("export const usage = true;\n")],
      ]),
    });
    expect(plan).toEqual({
      kind: "moved",
      moves: [{ from: `${DIR}/1071_usage.sql`, to: `${DIR}/1075_usage.sql` }],
      entries: [
        { path: ".changeset/usage.md", mode: "100644", content: "Adds `1075_usage` (1075).\n" },
        { path: `${DIR}/1071_usage.sql`, mode: "100644", sha: null },
        { path: `${DIR}/1075_usage.sql`, mode: "100644", sha: "sql" },
        { path: `${TESTS}/migration-1071-usage.test.ts`, mode: "100644", sha: null },
        {
          path: `${TESTS}/migration-1075-usage.test.ts`,
          mode: "100644",
          content: 'read("1075_usage.sql");\n',
        },
      ],
    });
  });

  test("moves two migrations of one PR to consecutive free numbers", () => {
    const plan = planMigrationMoves({
      paths: [`${DIR}/1072_second.sql`, `${DIR}/1071_first.sql`],
      ledger: ["1071_main.sql", "1072_main.sql", "1071_first.sql", "1072_second.sql"],
      files: new Map([
        [`${DIR}/1071_first.sql`, text("select 1;\n", "first")],
        [`${DIR}/1072_second.sql`, text("select 2;\n", "second")],
      ]),
    });
    expect(plan.kind === "moved" && plan.moves).toEqual([
      { from: `${DIR}/1071_first.sql`, to: `${DIR}/1073_first.sql` },
      { from: `${DIR}/1072_second.sql`, to: `${DIR}/1074_second.sql` },
    ]);
  });

  test("leaves an unreadable migration to a person", () => {
    const plan = planMigrationMoves({
      paths: [`${DIR}/1071_usage.sql`],
      ledger: ["1071_main.sql", "1071_usage.sql"],
      files: new Map([[`${DIR}/1071_usage.sql`, { text: null, mode: "100644", oid: "x" }]]),
    });
    expect(plan).toEqual({ kind: "manual", reason: "`1071_usage.sql` could not be read as text." });
  });
});
