import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  explicitUnitTestPaths,
  planUnitTestProcesses,
  runBoundedTestProcesses,
  resolveUnitTestSelection,
  sanitizedTestEnvironment,
  sourceMutatesSharedPostgresRole,
  sourceRequiresExclusiveSharedPostgres,
  sourceUsesExplicitTestConcurrency,
  sourceUsesWallClockPerformanceAssertion,
} from "./run-unit-shard";
import { discoverTestFiles, fileUsesProcessGlobalTestState } from "./workspace";

function withUnitShardFixture<T>(run: (root: string, files: string[]) => T): T {
  const root = mkdtempSync(join(tmpdir(), "opengeni-unit-category-shards-"));
  try {
    const sources = {
      parallel: "test('ordinary', () => {});",
      explicitConcurrency: "test.concurrent('race', () => {});",
      wallClockSensitive: "const started = performance.now(); expect(elapsed).toBeLessThan(100);",
      sharedPostgresExclusive: "// opengeni:test-shared-postgres-exclusive",
      clusterRoleSensitive: "await sql.unsafe('create role fixture_role nologin');",
    } satisfies Record<keyof ReturnType<typeof planUnitTestProcesses>, string>;
    const files = Object.entries(sources).flatMap(([category, source]) =>
      Array.from({ length: 7 }, (_, index) => {
        const path = `${category}-${index}.test.${index % 2 ? "tsx" : "ts"}`;
        const globalState = index === 2 ? "\nmock.module('fixture', () => ({}));" : "";
        writeFileSync(join(root, path), `${source}${globalState}\n// ${"x".repeat(index * 20)}\n`);
        return path;
      }),
    );
    return run(root, files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function selectFixtureUnitShards(root: string, files: string[], count: number): string[][] {
  const planPath = join(root, "impact-plan.json");
  writeFileSync(planPath, JSON.stringify({ schemaVersion: 1, unitTests: files }));
  return Array.from(
    { length: count },
    (_, index) =>
      resolveUnitTestSelection(root, [
        "--plan",
        planPath,
        "--shard",
        String(index),
        "--shards",
        String(count),
      ]).selected,
  );
}

function fixtureProcessPlan(root: string, files: string[]) {
  return planUnitTestProcesses(
    root,
    files.filter((path) => !fileUsesProcessGlobalTestState(root, path)),
    files.filter((path) => fileUsesProcessGlobalTestState(root, path)),
    1,
  );
}

describe("native PostgreSQL unit environment", () => {
  const nativeUrl = "postgres://postgres:fixture@127.0.0.1:5432/postgres?sslmode=disable";

  test("preserves the explicit native fixture only with fail-closed real DB intent", () => {
    expect(
      sanitizedTestEnvironment({
        PATH: "/bin",
        OPENGENI_REQUIRE_REAL_DB: "1",
        OPENGENI_TEST_PG_URL: nativeUrl,
        OPENGENI_DATABASE_URL: "postgres://ambient",
        OPENGENI_API_KEY: "ambient-key",
      }),
    ).toEqual({
      PATH: "/bin",
      NODE_ENV: "test",
      OPENGENI_TEST_HERMETIC: "1",
      OPENGENI_REQUIRE_REAL_DB: "1",
      OPENGENI_TEST_PG_URL: nativeUrl,
    });
  });

  test.each([undefined, "0", "true"])("scrubs a native fixture without exact opt-in %s", (flag) => {
    expect(
      sanitizedTestEnvironment({
        OPENGENI_REQUIRE_REAL_DB: flag,
        OPENGENI_TEST_PG_URL: nativeUrl,
      }),
    ).toEqual({ NODE_ENV: "test", OPENGENI_TEST_HERMETIC: "1" });
  });

  test.each([undefined, "", "   "])(
    "does not invent a native fixture for an empty URL %s",
    (url) => {
      expect(
        sanitizedTestEnvironment({
          OPENGENI_REQUIRE_REAL_DB: "1",
          OPENGENI_TEST_PG_URL: url,
        }),
      ).toEqual({
        NODE_ENV: "test",
        OPENGENI_TEST_HERMETIC: "1",
        OPENGENI_REQUIRE_REAL_DB: "1",
      });
    },
  );
});

describe("local unit selection", () => {
  test("uses the same complete unit inventory as CI without admitting prepared runtime tests", () => {
    const selection = resolveUnitTestSelection(process.cwd(), ["--all"]);
    expect(selection).toEqual({ selected: discoverTestFiles().unit, index: 0, count: 1 });
    expect(selection.selected).toContain("packages/db/test/connections.test.ts");
    expect(selection.selected).toContain(
      "apps/web/src/routes/workspace-settings-deletion.test.tsx",
    );
    expect(selection.selected).not.toContain("apps/api/test/native-report-delivery.test.ts");
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.scripts["test:unit"]).toBe("bun scripts/ci/run-unit-shard.ts --all");
  });

  test("rejects ambiguous full and shard selection", () => {
    expect(() => resolveUnitTestSelection(process.cwd(), ["--all", "--shard", "0"])).toThrow(
      "--all cannot be combined",
    );
  });
});

describe("class-aware unit shard selection", () => {
  test.each([1, 2, 4, 6, 40])(
    "is exhaustive, disjoint, unique and deterministic across %s shards",
    (count) => {
      withUnitShardFixture((root, files) => {
        const shards = selectFixtureUnitShards(root, [...files, ...files.slice(0, 4)], count);
        expect(shards).toHaveLength(count);
        expect(shards.flat().sort()).toEqual([...files].sort());
        expect(new Set(shards.flat()).size).toBe(files.length);
        expect(selectFixtureUnitShards(root, [...files].reverse(), count)).toEqual(shards);
        for (const shard of shards) expect(shard).toEqual([...shard].sort());
        for (let index = 0; index < shards.length; index++) {
          const others = new Set(shards.slice(index + 1).flat());
          expect(shards[index]!.some((path) => others.has(path))).toBe(false);
        }
      });
    },
  );

  test("retains every execution category and process-global isolation flag", () => {
    withUnitShardFixture((root, files) => {
      const records = (plan: ReturnType<typeof planUnitTestProcesses>) =>
        Object.entries(plan)
          .flatMap(([category, processes]) =>
            processes.flatMap((process) =>
              process.files.map((path) => ({ path, category, isolated: process.isolated })),
            ),
          )
          .sort((left, right) => left.path.localeCompare(right.path));
      const expected = records(fixtureProcessPlan(root, files));
      const actual = selectFixtureUnitShards(root, files, 6)
        .flatMap((shard) => records(fixtureProcessPlan(root, shard)))
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(actual).toEqual(expected);
      expect(new Set(actual.map((entry) => entry.category)).size).toBe(5);
      expect(actual.some((entry) => entry.isolated && entry.path.endsWith(".test.ts"))).toBe(true);
      expect(actual.some((entry) => !entry.isolated)).toBe(true);
    });
  });

  test("keeps serial-category assignments stable when parallel file weights and inventory change", () => {
    withUnitShardFixture((root, files) => {
      const plan = fixtureProcessPlan(root, files);
      const before = selectFixtureUnitShards(root, files, 6);
      for (const { files: parallelFiles } of plan.parallel) {
        for (const path of parallelFiles) {
          writeFileSync(
            join(root, path),
            `${readFileSync(join(root, path), "utf8")}\n// ${"x".repeat(64_000)}\n`,
          );
        }
      }
      const added = Array.from({ length: 3 }, (_, index) => {
        const path = `added-parallel-${index}.test.ts`;
        writeFileSync(join(root, path), `test('ordinary', () => {});\n// ${"x".repeat(128_000)}\n`);
        return path;
      });
      const after = selectFixtureUnitShards(root, [...files, ...added], 6);
      for (const [category, processes] of Object.entries(plan)) {
        if (category === "parallel") continue;
        const categoryFiles = new Set(processes.flatMap((process) => process.files));
        const assigned = (shards: string[][]) =>
          shards.map((shard) => shard.filter((path) => categoryFiles.has(path)));
        expect(assigned(after)).toEqual(assigned(before));
        const loads = assigned(after).map((shard) => shard.length);
        expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
      }
      expect(after.flat().sort()).toEqual([...files, ...added].sort());
    });
  });

  test("keeps empty selections empty in every shard", () => {
    withUnitShardFixture((root) => {
      expect(selectFixtureUnitShards(root, [], 6)).toEqual(Array.from({ length: 6 }, () => []));
    });
  });
});

describe("bounded unit process execution", () => {
  test("runs every task exactly once within the configured process bound", async () => {
    const started: number[] = [];
    const completed: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const status = await runBoundedTestProcesses([0, 1, 2, 3, 4, 5], 2, async (task) => {
      started.push(task);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Bun.sleep(task % 2 === 0 ? 4 : 1);
      active -= 1;
      completed.push(task);
      return 0;
    });

    expect(status).toBe(0);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...completed].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maximumActive).toBe(2);
  });

  test("stops admitting new work after a failure while settling in-flight tasks", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: number[] = [];
    const execution = runBoundedTestProcesses([0, 1, 2, 3], 2, async (task) => {
      started.push(task);
      if (task === 0) return 7;
      await gate;
      return 0;
    });
    while (started.length < 2) await Bun.sleep(1);
    await Bun.sleep(1);
    release();

    expect(await execution).toBe(7);
    expect(started).toEqual([0, 1]);
  });

  test("rejects an invalid process bound", async () => {
    await expect(runBoundedTestProcesses([1], 0, async () => 0)).rejects.toThrow(
      "positive integer",
    );
  });
});

describe("unit process planning", () => {
  test("passes custom test suffixes to Bun as explicit repository paths", () => {
    expect(
      explicitUnitTestPaths([
        "packages/core/test/example.test.ts",
        "test/integration/api.integration.ts",
        "./test/e2e/browser.e2e.ts",
      ]),
    ).toEqual([
      "./packages/core/test/example.test.ts",
      "./test/integration/api.integration.ts",
      "./test/e2e/browser.e2e.ts",
    ]);
  });

  test("recognizes authored concurrent-test syntax without matching prose", () => {
    expect(sourceUsesExplicitTestConcurrency("test.concurrent('race', () => {})")).toBe(true);
    expect(sourceUsesExplicitTestConcurrency("it ['concurrent']('race', () => {})")).toBe(true);
    expect(
      sourceUsesExplicitTestConcurrency("describe.concurrent.each([])('race', () => {})"),
    ).toBe(true);
    expect(sourceUsesExplicitTestConcurrency("const { concurrent: race } = test;")).toBe(true);
    expect(sourceUsesExplicitTestConcurrency("test('concurrent sessions', () => {})")).toBe(false);
  });

  test("recognizes real wall-clock upper bounds without matching unrelated clocks", () => {
    expect(
      sourceUsesWallClockPerformanceAssertion(
        "const started = Bun.nanoseconds(); expect(elapsed).toBeLessThan(1500);",
      ),
    ).toBe(true);
    expect(
      sourceUsesWallClockPerformanceAssertion(
        "const started = performance.now(); expect(elapsed).toBeLessThanOrEqual(100);",
      ),
    ).toBe(true);
    expect(sourceUsesWallClockPerformanceAssertion("const now = Date.now();")).toBe(false);
    expect(sourceUsesWallClockPerformanceAssertion("expect(rows).toBeLessThan(100);")).toBe(false);
  });

  test("recognizes only shared-container cluster-role mutations", () => {
    expect(
      sourceMutatesSharedPostgresRole(
        "await sql.unsafe(`alter role opengeni_app with password 'test'`);",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "const blank = await acquireBlankTestDatabase('x'); await provisionRoles(blank.databaseUrl, {});",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "const shared = await acquireSharedTestDatabase('x'); await provisionRoles(shared.adminUrl, {});",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "let shared = null; shared = await acquireSharedTestDatabase('x'); await provisionRoles(shared!.adminUrl, {});",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "await shared.admin.unsafe(`create role ${quotedRole} nologin`);",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(migrationRole)}`);",
      ),
    ).toBe(true);
    expect(
      sourceMutatesSharedPostgresRole(
        "const shared = await acquireSharedTestDatabase('x'); if (externalUrl) await provisionRoles(externalUrl, {});",
      ),
    ).toBe(false);
  });

  test("recognizes only the explicit shared-PostgreSQL exclusivity marker", () => {
    expect(
      sourceRequiresExclusiveSharedPostgres("// opengeni:test-shared-postgres-exclusive"),
    ).toBe(true);
    expect(sourceRequiresExclusiveSharedPostgres("// shared postgres exclusive")).toBe(false);
  });

  test("classifies generated and helper-driven shared-cluster role DDL in the real corpus", () => {
    const root = join(import.meta.dir, "../..");
    for (const path of [
      "apps/worker/test/editable-artifact-outbox-posture-postgres.test.ts",
      "packages/db/test/editable-artifact-materialization-postgres.test.ts",
      "packages/db/test/editable-artifacts-postgres.test.ts",
      "packages/db/test/session-activity-commit-gate.test.ts",
      "packages/db/test/migration-0120-durable-goal-wake.test.ts",
      "packages/db/test/migration-0138-sandbox-checkpoints.test.ts",
      "packages/db/test/migration-0352-session-variable-set-attachments.test.ts",
    ]) {
      expect(sourceMutatesSharedPostgresRole(readFileSync(join(root, path), "utf8"))).toBe(true);
    }
  });

  test("keeps explicit concurrency, wall clocks, shared PostgreSQL, and cluster roles out of the parallel pool", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-unit-process-plan-"));
    try {
      for (const path of ["batch-a.test.ts", "isolated-a.test.ts"]) {
        writeFileSync(join(root, path), "test('ordinary', () => {});\n");
      }
      writeFileSync(
        join(root, "timed.test.ts"),
        "const started = performance.now(); expect(performance.now() - started).toBeLessThan(100);\n",
      );
      writeFileSync(
        join(root, "role.test.ts"),
        "const shared = await acquireSharedTestDatabase('x'); await provisionRoles(shared.adminUrl, {});\n",
      );
      writeFileSync(
        join(root, "shared-postgres.test.ts"),
        "// opengeni:test-shared-postgres-exclusive\ntest('authority', () => {});\n",
      );
      mkdirSync(join(root, "nested"));
      writeFileSync(
        join(root, "nested/concurrent.test.ts"),
        "test.concurrent('authored race', () => {});\n",
      );
      const plan = planUnitTestProcesses(
        root,
        [
          "batch-a.test.ts",
          "nested/concurrent.test.ts",
          "timed.test.ts",
          "shared-postgres.test.ts",
          "role.test.ts",
        ],
        ["isolated-a.test.ts"],
        1,
      );

      expect(plan).toEqual({
        parallel: [
          { files: ["batch-a.test.ts"], isolated: false },
          { files: ["isolated-a.test.ts"], isolated: true },
        ],
        explicitConcurrency: [{ files: ["nested/concurrent.test.ts"], isolated: false }],
        wallClockSensitive: [{ files: ["timed.test.ts"], isolated: false }],
        sharedPostgresExclusive: [{ files: ["shared-postgres.test.ts"], isolated: false }],
        clusterRoleSensitive: [{ files: ["role.test.ts"], isolated: false }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
