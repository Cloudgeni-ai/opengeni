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

  test("a PR's later migrations move too, so its migrations keep their order", () => {
    // Main took 1071; the PR adds 1071_b and 1072_c, which alters b's table.
    const plan = planMigrationMoves({
      paths: [`${DIR}/1071_b.sql`],
      added: [`${DIR}/1072_c.sql`, `${DIR}/1071_b.sql`, `${DIR}/1070_early.sql`],
      ledger: ["1070_early.sql", "1071_a.sql", "1071_b.sql", "1072_c.sql"],
      files: new Map([
        [`${DIR}/1070_early.sql`, text("select 0;\n", "early")],
        [`${DIR}/1071_b.sql`, text("create table b ();\n", "b")],
        [`${DIR}/1072_c.sql`, text("alter table b add c int;\n", "c")],
      ]),
    });
    expect(plan.kind === "moved" && plan.moves).toEqual([
      { from: `${DIR}/1071_b.sql`, to: `${DIR}/1073_b.sql` },
      { from: `${DIR}/1072_c.sql`, to: `${DIR}/1074_c.sql` },
    ]);
  });

  test("keeps each file's mode, never rewrites a symlink, and leaves unread text to a person", () => {
    const files = new Map<string, RepoFile>([
      [`${DIR}/1071_usage.sql`, text("select 1;\n", "sql")],
      [
        `${TESTS}/migration-1071-usage.test.ts`,
        { ...text('read("1071_usage.sql");\n'), mode: "100755" },
      ],
      ["docs/usage-link.md", { text: "../1071_usage.sql", mode: "120000", oid: "link" }],
    ]);
    const input = {
      paths: [`${DIR}/1071_usage.sql`],
      ledger: ["1071_main.sql", "1071_usage.sql"],
      changed: [...files.keys()],
      files,
    };
    const plan = planMigrationMoves(input);
    expect(plan.kind === "moved" && plan.entries).toEqual([
      { path: `${DIR}/1071_usage.sql`, mode: "100644", sha: null },
      { path: `${DIR}/1072_usage.sql`, mode: "100644", sha: "sql" },
      { path: `${TESTS}/migration-1071-usage.test.ts`, mode: "100755", sha: null },
      {
        path: `${TESTS}/migration-1072-usage.test.ts`,
        mode: "100755",
        content: 'read("1072_usage.sql");\n',
      },
    ]);
    // A changed text file that could not be read, or is missing, is not guessed at.
    for (const unread of [{ text: null, mode: "100644", oid: "big" }, undefined]) {
      const withUnread = new Map(files);
      if (unread) withUnread.set("docs/notes.md", unread);
      expect(
        planMigrationMoves({
          ...input,
          changed: [...input.changed, "docs/notes.md"],
          files: withUnread,
        }),
      ).toEqual({ kind: "manual", reason: "`notes.md` could not be read as text." });
    }
  });
});
