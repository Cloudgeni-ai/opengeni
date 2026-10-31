import { describe, expect, test } from "bun:test";
import { planMigrationMoves, type MovePlan, type RepoFile } from "./renumber";

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

  /** Main took 1143 after the PR branched; the PR mentions its own 1143 bare. */
  const ownMentions = (
    overrides: Partial<Parameters<typeof planMigrationMoves>[0]> = {},
  ): Parameters<typeof planMigrationMoves>[0] => ({
    paths: [`${DIR}/1143_own.sql`],
    added: [`${DIR}/1143_own.sql`],
    ledger: ["1142_x.sql", "1143_main.sql", "1143_own.sql"],
    branchLedger: ["1142_x.sql", "README.md"],
    changed: [`${DIR}/1143_own.sql`, "packages/db/src/audience.ts", ".changeset/own.md"],
    files: new Map([
      [`${DIR}/1143_own.sql`, text("select 1;\n", "sql")],
      [
        "packages/db/src/audience.ts",
        text(
          "// Unused since migration 1143\nexport const a = 1;\n// Since 1143 owners keep schedules.\n",
        ),
      ],
      [".changeset/own.md", text("Rolling migration 1143 keeps a.\n")],
    ]),
    mainFiles: new Map([
      [
        "packages/db/src/audience.ts",
        text("export const a = 1;\n// Since 1143 owners keep schedules.\n", "main"),
      ],
    ]),
    ...overrides,
  });

  test("rewrites the PR's own bare mentions on lines main lacks, never main's lines", () => {
    expect(planMigrationMoves(ownMentions())).toEqual({
      kind: "moved",
      moves: [{ from: `${DIR}/1143_own.sql`, to: `${DIR}/1144_own.sql` }],
      entries: [
        { path: ".changeset/own.md", mode: "100644", content: "Rolling migration 1144 keeps a.\n" },
        { path: `${DIR}/1143_own.sql`, mode: "100644", sha: null },
        { path: `${DIR}/1144_own.sql`, mode: "100644", sha: "sql" },
        {
          path: "packages/db/src/audience.ts",
          mode: "100644",
          // The last line was on main and names main's 1143.
          content:
            "// Unused since migration 1144\nexport const a = 1;\n// Since 1143 owners keep schedules.\n",
        },
      ],
    });
  });

  test("a PR's later migration naming its earlier one bare follows the move", () => {
    const plan = planMigrationMoves(
      ownMentions({
        added: [`${DIR}/1143_own.sql`, `${DIR}/1144_more.sql`],
        ledger: ["1142_x.sql", "1143_main.sql", "1143_own.sql", "1144_more.sql"],
        changed: [`${DIR}/1143_own.sql`, `${DIR}/1144_more.sql`],
        files: new Map([
          [`${DIR}/1143_own.sql`, text("create table own ();\n", "own")],
          [`${DIR}/1144_more.sql`, text("-- after 1143\nalter table own add b int;\n", "more")],
        ]),
        mainFiles: new Map(),
      }),
    );
    expect(plan.kind === "moved" && plan.moves).toEqual([
      { from: `${DIR}/1143_own.sql`, to: `${DIR}/1145_own.sql` },
      { from: `${DIR}/1144_more.sql`, to: `${DIR}/1146_more.sql` },
    ]);
    expect(plan.kind === "moved" && plan.entries).toContainEqual({
      path: `${DIR}/1146_more.sql`,
      mode: "100644",
      content: "-- after 1145\nalter table own add b int;\n",
    });
  });

  test("leaves a bare number to a person when it could name another migration", () => {
    const manual: MovePlan = {
      kind: "manual",
      reason:
        "`.changeset/own.md`, `packages/db/src/audience.ts` mentions 1143 without naming `1143_own`, so the batcher cannot tell which migration it means.",
    };
    // Main already had a 1143 when the PR branched, so the author may mean it.
    expect(
      planMigrationMoves(ownMentions({ branchLedger: ["1142_x.sql", "1143_main.sql"] })),
    ).toEqual(manual);
    // The PR adds two migrations numbered 1143.
    expect(
      planMigrationMoves(ownMentions({ added: [`${DIR}/1143_own.sql`, `${DIR}/1143_twin.sql`] })),
    ).toEqual(manual);
    // Main's copy could not be read, so the PR's lines are unknown.
    expect(
      planMigrationMoves(
        ownMentions({
          mainFiles: new Map([
            ["packages/db/src/audience.ts", { text: null, mode: "100644", oid: "big" }],
          ]),
        }),
      ),
    ).toEqual(manual);
    // Without main's copies or the branch point nothing can be attributed.
    const { mainFiles: _mainFiles, ...withoutMainFiles } = ownMentions();
    expect(planMigrationMoves(withoutMainFiles)).toEqual(manual);
    const { branchLedger: _branchLedger, ...withoutBranchLedger } = ownMentions();
    expect(planMigrationMoves(withoutBranchLedger)).toEqual(manual);
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
