import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isPreReleaseEligible,
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

describe("posture-inert pre eligibility", () => {
  test("specialized indexes and backfills are inert; historical and unknown modes are not", () => {
    for (const source of [index(), index(true), index(false, "pre-release"), backfill()]) {
      expect(isPreReleaseEligible(file, source)).toBe(true);
    }
    expect(isPreReleaseEligible("0010_historical.sql", "SELECT 1;")).toBe(false);
    expect(isPreReleaseEligible(file, index().replace("rolling", "maintenance"))).toBe(false);
  });
  test("ordinary posture-changing and uncertain statements stop pre, despite rolling headers", () => {
    for (const sql of [
      "CREATE TABLE t (id int);",
      "CREATE UNLOGGED TABLE t (id int);",
      "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      "CREATE PROCEDURE p() LANGUAGE sql AS 'SELECT 1';",
      "GRANT SELECT ON t TO app;",
      "REVOKE SELECT ON t FROM app;",
      "ALTER TABLE t OWNER TO app;",
      "ALTER TABLE t ENABLE ROW LEVEL SECURITY;",
      'ALTER TABLE "a--b" FORCE ROW LEVEL SECURITY;',
      "CREATE POLICY p ON t USING (true);",
      "ALTER POLICY p ON t USING (true);",
      "DROP POLICY p ON t;",
      "CREATE SCHEMA s;",
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO app;",
      "CREATE VIEW v AS SELECT 1;",
      "CREATE MATERIALIZED VIEW v AS SELECT 1;",
      "ALTER FUNCTION f() SECURITY DEFINER;",
      "DROP FUNCTION f();",
      "DROP TABLE t;",
      "DO $$ BEGIN EXECUTE 'CREATE ' || 'TABLE t (id int)'; END $$;",
      "CALL opaque();",
      "CREATE EXTENSION opaque;",
      "ALTER TABLE t RENAME TO renamed;",
      "ALTER TABLE t SET SCHEMA other;",
      "ALTER TABLE t INHERIT parent;",
      "ALTER TABLE t NO INHERIT parent;",
      "ALTER TABLE t ATTACH PARTITION child FOR VALUES IN (1);",
      "ALTER TABLE t DETACH PARTITION child;",
      "SET ROLE app;",
      "SET LOCAL ROLE app;",
      "SET SESSION AUTHORIZATION app;",
      "SELECT opaque_ddl();",
      "WITH invoked AS (SELECT opaque_ddl()) SELECT * FROM invoked;",
    ])
      expect(isPreReleaseEligible(file, `-- deployment-mode: rolling\n${sql}`)).toBe(false);
    expect(
      isPreReleaseEligible(
        file,
        "-- deployment-mode: rolling\n-- GRANT and ROW LEVEL SECURITY are just comments\n/* CREATE TABLE */ ALTER TABLE t ADD COLUMN value text;",
      ),
    ).toBe(true);
    expect(isPreReleaseEligible(file, "-- deployment-mode: rolling\nSELECT 1;")).toBe(true);
  });
  test("real production migrations cannot run pre until old-binary readiness tolerates their posture", () => {
    const directory = join(import.meta.dir, "../drizzle");
    for (const [ordinal, expected] of [
      ["0842", false],
      ["0846", false],
      ["0847", false],
      ["0866", true],
      ["0867", true],
      ["0874", true],
      ["0875", true],
      ["0879", true],
    ] as const) {
      const name = readdirSync(directory).find((candidate) => candidate.startsWith(`${ordinal}_`))!;
      expect(isPreReleaseEligible(name, readFileSync(join(directory, name), "utf8"))).toBe(
        expected,
      );
    }
  });
});

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
        deploymentMode: (mode === "post" || mode === "posture"
          ? "rolling"
          : mode) as MigrationDeploymentMode,
        preReleaseEligible: mode === "rolling" || mode === "post",
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
      [],
      ["0", "1", "2", "3"],
      ["4", "5"],
    ],
    [["maintenance", "post", "rolling", "post"], [], ["0", "1", "2"], ["3"]],
    [["rolling", "unclassified", "post"], ["0"], ["1"], ["2"]],
    [["maintenance", "maintenance"], [], ["0", "1"], []],
    [["post", "maintenance"], ["0"], ["1"], []],
    [["historical"], [], ["0"], []],
    [["rolling", "posture", "rolling", "post"], ["0"], ["1", "2"], ["3"]],
  ])("partitions %j", (modes, pre, maintenance, post) => {
    expect(partition(modes)).toEqual({ pre, maintenance, post });
  });
  test("applied gaps are absent before partitioning and every pending file stays in order", () => {
    const pending = [
      {
        name: "0001.sql",
        deploymentMode: "rolling" as const,
        preReleaseEligible: true,
        postReleaseEligible: false,
      },
      {
        name: "0003.sql",
        deploymentMode: "rolling" as const,
        preReleaseEligible: true,
        postReleaseEligible: true,
      },
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
      expect(phases.pre.every((name) => ["rolling", "post"].includes(modes[Number(name)]!))).toBe(
        true,
      );
      expect(phases.post.every((name) => modes[Number(name)] === "post")).toBe(true);
      if (phases.maintenance.length)
        expect(["maintenance", "unclassified", "historical"]).toContain(
          modes[Number(phases.maintenance[0])]!,
        );
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
