import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  planUnitTestProcesses,
  runBoundedTestProcesses,
  sourceMutatesSharedPostgresRole,
  sourceRequiresExclusiveSharedPostgres,
  sourceUsesExplicitTestConcurrency,
  sourceUsesWallClockPerformanceAssertion,
} from "./run-unit-shard";

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
