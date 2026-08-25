import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONVENTIONAL_BUDGET_MS,
  SHARD_DEFAULT_TIMEOUT_MS,
  budgetFixLines,
  budgetViolations,
} from "./migration-test-budgets";

const FILE = "packages/db/test/example.test.ts";

function source(body: string): string {
  return [
    'import { test } from "bun:test";',
    'import { migrate } from "../src/migrate";',
    body,
    "",
  ].join("\n");
}

describe("ledger-replay budget rule", () => {
  test("reports a migrate() test with no budget", () => {
    const found = budgetViolations(
      FILE,
      source('test("replays", async () => {\n  await migrate(url);\n});'),
    );
    expect(found).toEqual([{ file: FILE, line: 3, kind: "test", timeout: null }]);
  });

  test("accepts a budget above the shard default", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          `test("replays", async () => {\n  await migrate(url);\n}, ${CONVENTIONAL_BUDGET_MS});`,
        ),
      ),
    ).toEqual([]);
  });

  /**
   * An explicit value at or below the cap CI already passes buys nothing, so it
   * is not a budget. This is the case a "has an explicit timeout" check misses.
   */
  test("rejects a budget that only restates the shard default", () => {
    const found = budgetViolations(
      FILE,
      source(
        `test("replays", async () => {\n  await migrate(url);\n}, ${SHARD_DEFAULT_TIMEOUT_MS});`,
      ),
    );
    expect(found.map((entry) => entry.timeout)).toEqual([SHARD_DEFAULT_TIMEOUT_MS]);
  });

  test("ignores a test that never replays the ledger", () => {
    expect(
      budgetViolations(FILE, source('test("pure", () => {\n  expect(1).toBe(1);\n});')),
    ).toEqual([]);
  });

  test.each([
    ["test.each", 'test.each([1])("replays %s", async () => {\n  await migrate(url);\n});'],
    ["it", 'it("replays", async () => {\n  await migrate(url);\n});'],
    ["it.only", 'it.only("replays", async () => {\n  await migrate(url);\n});'],
    ["test.concurrent", 'test.concurrent("replays", async () => {\n  await migrate(url);\n});'],
    ["beforeAll hook", "beforeAll(async () => {\n  await migrate(url);\n});"],
    ["beforeEach hook", "beforeEach(async () => {\n  await migrate(url);\n});"],
  ])("catches an unbudgeted %s", (_label, body) => {
    expect(budgetViolations(FILE, source(body))).toHaveLength(1);
  });

  /**
   * A regex over `}, <number>);` cannot see this shape at all and would report
   * the whole file as unprotected.
   */
  test("honours a file-level setDefaultTimeout above the shard default", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          `setDefaultTimeout(${CONVENTIONAL_BUDGET_MS});\ntest("replays", async () => {\n  await migrate(url);\n});`,
        ),
      ),
    ).toEqual([]);
  });

  test("does not honour a setDefaultTimeout at or below the shard default", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          `setDefaultTimeout(${SHARD_DEFAULT_TIMEOUT_MS});\ntest("replays", async () => {\n  await migrate(url);\n});`,
        ),
      ),
    ).toHaveLength(1);
  });

  test("honours an option-object timeout", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          `test("replays", { timeout: ${CONVENTIONAL_BUDGET_MS} }, async () => {\n  await migrate(url);\n});`,
        ),
      ),
    ).toEqual([]);
  });

  test("reports each unbudgeted test in a file separately", () => {
    const found = budgetViolations(
      FILE,
      source(
        [
          `test("a", async () => {\n  await migrate(url);\n}, ${CONVENTIONAL_BUDGET_MS});`,
          'test("b", async () => {\n  await migrate(url);\n});',
          'test("c", async () => {\n  await migrate(url);\n});',
        ].join("\n"),
      ),
    );
    expect(found).toHaveLength(2);
  });

  test("the fix text names the floor and the convention", () => {
    const text = budgetFixLines().join("\n");
    expect(text).toContain(String(SHARD_DEFAULT_TIMEOUT_MS));
    expect(text).toContain("180_000");
  });
});

describe("floor is pinned to the runner", () => {
  /**
   * The floor mirrors the cap `run-unit-shard.ts` actually passes. If that
   * literal ever changes, a hand-copied constant would silently stop matching
   * the thing it exists to be compared against.
   */
  test("matches the --timeout the unit shard runner passes", () => {
    const runner = readFileSync(`${import.meta.dir}/ci/run-unit-shard.ts`, "utf8");
    const declared = /"--timeout=(\d+)"/.exec(runner);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(SHARD_DEFAULT_TIMEOUT_MS);
  });
});

describe("timeout resolution", () => {
  /** Largest wins, because that is the one bun actually applies. */
  test("takes the largest of several declared timeouts", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          'test("replays", { timeout: 5 }, async () => {\n  await migrate(url);\n}, 180_000);',
        ),
      ),
    ).toEqual([]);
  });

  test("resolves a timeout passed as a module-level constant", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          'const BUDGET = 180_000;\ntest("replays", async () => {\n  await migrate(url);\n}, BUDGET);',
        ),
      ),
    ).toEqual([]);
  });

  /**
   * Resolution is scoped to real module-level declarations. Walking the whole
   * program would let an unrelated inner binding of the same name decide the
   * answer by traversal order, and 19 unit test files already redeclare the same
   * numeric name with different values.
   */
  test("ignores an inner binding that shadows a module-level timeout constant", () => {
    expect(
      budgetViolations(
        FILE,
        source(
          'const BUDGET = 180_000;\nfunction helper() {\n  const BUDGET = 500;\n  return BUDGET;\n}\ntest("replays", async () => {\n  await migrate(url);\n}, BUDGET);',
        ),
      ),
    ).toEqual([]);
  });

  test("drops a module-level constant declared twice with different values", () => {
    const found = budgetViolations(
      FILE,
      source(
        'const BUDGET = 180_000;\nconst BUDGET = 500;\ntest("replays", async () => {\n  await migrate(url);\n}, BUDGET);',
      ),
    );
    expect(found.map((entry) => entry.timeout)).toEqual([null]);
  });

  test("reports the line of each site", () => {
    const found = budgetViolations(
      FILE,
      source('\n\ntest("replays", async () => {\n  await migrate(url);\n});'),
    );
    expect(found.map((entry) => entry.line)).toEqual([5]);
  });
});

describe("ledger-replay triggers", () => {
  /**
   * The shared-container helpers replay the ledger through
   * `ensureTemplateBuilt`, and keying only on `migrate()` missed 21 real hooks.
   */
  test.each([
    ["acquireSharedTestDatabase"],
    ["acquireBlankTestDatabase"],
    ["acquireOwnerMigratedTestDatabase"],
  ])("treats %s as a ledger replay", (helper) => {
    expect(
      budgetViolations(FILE, source(`beforeAll(async () => {\n  await ${helper}("x");\n});`)),
    ).toHaveLength(1);
  });

  /** The SDK-named thin wrapper over `migrate`; three unit tests call it. */
  test("treats runMigrations as a ledger replay", () => {
    expect(
      budgetViolations(FILE, source('test("x", async () => {\n  await runMigrations(url);\n});')),
    ).toHaveLength(1);
  });

  test("ignores an unrelated helper", () => {
    expect(
      budgetViolations(FILE, source('beforeAll(async () => {\n  await acquireNothing("x");\n});')),
    ).toEqual([]);
  });
});

describe("check-migration-test-budgets CLI", () => {
  const scratch: string[] = [];
  test("exits 1 and names the site, then 0 once budgeted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "budget-cli-"));
    scratch.push(dir);
    await mkdir(join(dir, "packages/db/test"), { recursive: true });
    const target = join(dir, "packages/db/test/example.test.ts");
    const run = async () => {
      const child = Bun.spawn(["bun", join(import.meta.dir, "check-migration-test-budgets.ts")], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      });
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code: await child.exited, out, err };
    };
    await writeFile(target, source('test("replays", async () => {\n  await migrate(url);\n});'));
    const before = await run();
    expect(before.code).toBe(1);
    expect(before.err).toContain("packages/db/test/example.test.ts");
    expect(before.err).toContain("budget: none");

    await writeFile(
      target,
      source('test("replays", async () => {\n  await migrate(url);\n}, 180_000);'),
    );
    const after = await run();
    expect(after.code).toBe(0);
    expect(after.out).toContain("[migration-test-budgets] ok");
    await rm(dir, { recursive: true, force: true });
  }, 60_000);
});
