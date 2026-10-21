import { describe, expect, test } from "bun:test";
import {
  isPostReleaseEligible,
  parseBatchedBackfillMigration,
  parseConcurrentIndexMigration,
} from "../src/migrate";
import {
  migrationPhaseFromArgs,
  migrationReleaseDirectives,
  partitionMigrationPhases,
  type MigrationDeploymentMode,
} from "../src/migration-phases";

const file = "5000_phase.sql";
const index = (unique = false, marker = "") => `-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
${marker ? `-- opengeni:${marker}\n` : ""}CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY IF NOT EXISTS test_idx ON records (id);`;
const backfill = (marker = "") => `-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=100 lock-timeout=1s statement-timeout=10s
${marker ? `-- opengeni:${marker}\n` : ""}WITH batch AS (SELECT id FROM records WHERE value IS NULL LIMIT 100)
UPDATE records SET value = 1 FROM batch WHERE records.id = batch.id RETURNING records.id;`;

describe("post-release eligibility", () => {
  test("only non-unique concurrent indexes are automatically eligible", () => {
    expect(isPostReleaseEligible(file, index())).toBe(true);
    expect(isPostReleaseEligible(file, index(true))).toBe(false);
    expect(isPostReleaseEligible(file, backfill())).toBe(false);
  });
  test("explicit markers opt unique indexes and backfills in, and indexes out", () => {
    for (const source of [
      index(false, "post-release"),
      index(true, "post-release"),
      backfill("post-release"),
    ]) {
      expect(isPostReleaseEligible(file, source)).toBe(true);
      expect(isPostReleaseEligible(file, source.replaceAll("\n", "\r\n"))).toBe(true);
    }
    expect(isPostReleaseEligible(file, index(false, "pre-release"))).toBe(false);
    expect(isPostReleaseEligible(file, index(false, "post-release\n-- opengeni:pre-release"))).toBe(
      false,
    );
  });
  test("both parsers tolerate the release markers without changing their statements", () => {
    for (const marker of ["pre-release", "post-release"]) {
      expect(parseConcurrentIndexMigration(file, index(true, marker))).toEqual(
        parseConcurrentIndexMigration(file, index(true)),
      );
      expect(parseBatchedBackfillMigration(file, backfill(marker))).toEqual(
        parseBatchedBackfillMigration(file, backfill()),
      );
    }
  });
  test("never defers maintenance, historical, unclassified, ordinary DDL or malformed special files", () => {
    for (const source of [
      index().replace("rolling", "maintenance"),
      index().replace("-- deployment-mode: rolling\n", ""),
      "-- deployment-mode: rolling\n-- opengeni:post-release\nCREATE TABLE x (id int);",
      "-- deployment-mode: rolling\n-- opengeni:post-release\nALTER TABLE x ADD COLUMN y int;",
      "-- deployment-mode: rolling\n-- opengeni:post-release\nGRANT SELECT ON x TO y;",
      "-- deployment-mode: rolling\n-- opengeni:post-release\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      index(false, "post-release") + "\nCREATE TABLE x (id int);",
      backfill("post-release") + "\nCREATE TABLE x (id int);",
      backfill("post-release").replace("LIMIT 100", "LIMIT 500"),
    ])
      expect(isPostReleaseEligible(file, source)).toBe(false);
    expect(
      isPostReleaseEligible("0010_x.sql", index().replace("-- deployment-mode: rolling\n", "")),
    ).toBe(false);
  });
  test("SQL string content and trailing comments are not scheduling directives", () => {
    expect(
      migrationReleaseDirectives(
        "-- deployment-mode: rolling\nSELECT '\n-- opengeni:post-release\n';",
      ),
    ).toEqual(new Set());
    expect(migrationReleaseDirectives(index(true) + "\n-- opengeni:post-release")).toEqual(
      new Set(),
    );
  });
});

describe("pending migration partition", () => {
  const partition = (modes: string[]) =>
    partitionMigrationPhases(
      modes.map((mode, i) => ({
        name: String(i),
        deploymentMode: (mode === "post" ? "rolling" : mode) as MigrationDeploymentMode,
        postReleaseEligible: mode === "post",
      })),
    );
  test.each([
    [[], [], [], []],
    [["rolling"], ["0"], [], []],
    [["post", "post"], [], [], ["0", "1"]],
    [["rolling", "post"], ["0"], [], ["1"]],
    [["post", "rolling", "post"], ["0", "1"], [], ["2"]],
    [
      ["historical", "rolling", "maintenance", "rolling", "post", "post"],
      ["0", "1"],
      ["2", "3"],
      ["4", "5"],
    ],
    [["maintenance", "post", "rolling", "post"], [], ["0", "1", "2"], ["3"]],
    [["rolling", "unclassified", "post"], ["0"], ["1"], ["2"]],
    [["maintenance", "maintenance"], [], ["0", "1"], []],
    [["post", "maintenance"], ["0"], ["1"], []],
    [["historical"], ["0"], [], []],
  ])("partitions %j", (modes, pre, maintenance, post) => {
    expect(partition(modes)).toEqual({ pre, maintenance, post });
  });
  test("applied gaps are absent before partitioning and every pending file stays in order", () => {
    const pending = [
      { name: "0001.sql", deploymentMode: "rolling" as const, postReleaseEligible: false },
      { name: "0003.sql", deploymentMode: "rolling" as const, postReleaseEligible: true },
    ];
    expect(partitionMigrationPhases(pending)).toEqual({
      pre: ["0001.sql"],
      maintenance: [],
      post: ["0003.sql"],
    });
    for (let encoded = 0; encoded < 3125; encoded++) {
      let n = encoded;
      const modes = Array.from({ length: 5 }, () => {
        const mode = ["rolling", "historical", "maintenance", "unclassified", "post"][n % 5]!;
        n = Math.floor(n / 5);
        return mode;
      });
      const phases = partition(modes);
      expect([...phases.pre, ...phases.maintenance, ...phases.post]).toEqual([
        "0",
        "1",
        "2",
        "3",
        "4",
      ]);
      expect(
        phases.pre.every((name) =>
          ["rolling", "historical", "post"].includes(modes[Number(name)]!),
        ),
      ).toBe(true);
      expect(phases.post.every((name) => modes[Number(name)] === "post")).toBe(true);
      if (phases.maintenance.length)
        expect(["maintenance", "unclassified"]).toContain(modes[Number(phases.maintenance[0])]!);
      const beforePost = [...phases.pre, ...phases.maintenance].at(-1);
      if (beforePost !== undefined) expect(modes[Number(beforePost)]).not.toBe("post");
    }
  });
});

describe("migration phase CLI", () => {
  test("default and explicit post apply the whole chain; the flag wins over env", () => {
    expect(migrationPhaseFromArgs([], undefined)).toBe("post");
    expect(migrationPhaseFromArgs([], "pre")).toBe("pre");
    expect(migrationPhaseFromArgs(["--phase=maintenance"], "pre")).toBe("maintenance");
    expect(migrationPhaseFromArgs(["--phase", "post"], "invalid")).toBe("post");
  });
  test("invalid or missing phase values fail clearly", () => {
    for (const args of [["--phase="], ["--phase"], ["--phase=wat"], ["--phase", "--plan"]]) {
      expect(() => migrationPhaseFromArgs(args, "pre")).toThrow("Invalid migration phase");
    }
    expect(() => migrationPhaseFromArgs([], "")).toThrow("expected pre, maintenance or post");
  });
});
