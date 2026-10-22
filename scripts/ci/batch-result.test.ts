import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateBatchResult,
  batchIdentity,
  buildComparisonEvidence,
  classifyBatchExit,
  type BatchTaskReceipt,
} from "./batch-result";
import { COMPARISON_SCHEMA, unitKey } from "../merge-batcher/base-comparison";
import { digest } from "../merge-batcher/model";
const identity = { batchId: "batch-1", headSha: "a".repeat(40), runId: "123", runAttempt: 2 };
const jobs = { plan: "success", source: "success", units: "success" };
const receipt = (job: string, exitCode = 0): BatchTaskReceipt => ({
  schemaVersion: 1,
  ...identity,
  job,
  exitCode,
  ...classifyBatchExit(exitCode),
  startedAt: "2026-10-21T11:00:00Z",
  finishedAt: "2026-10-21T11:01:00Z",
});

test("aggregate binds every selected job to exact batch, tip, run and attempt", () => {
  expect(
    aggregateBatchResult(
      identity,
      ["source", "unit-0"],
      [receipt("source"), receipt("unit-0")],
      jobs,
    ).outcome,
  ).toBe("success");
  for (const wrong of [
    { headSha: "b".repeat(40) },
    { batchId: "other" },
    { runId: "122" },
    { runAttempt: 1 },
  ]) {
    expect(
      aggregateBatchResult(identity, ["source"], [{ ...receipt("source"), ...wrong }], {
        ...jobs,
        units: "skipped",
      }).outcome,
    ).toBe("infrastructure");
  }
});
test("missing, duplicate, malformed and contradictory receipts cannot masquerade as code failures or green", () => {
  for (const rows of [
    [],
    [null],
    [receipt("source"), receipt("source")],
    [{ ...receipt("source"), outcome: "code_failure" }],
  ])
    expect(
      aggregateBatchResult(identity, ["source"], rows, { ...jobs, units: "skipped" }).outcome,
    ).toBe("infrastructure");
});
test("completed assertion failures are eligible for one controller retry, leaked processes are not", () => {
  const failed = { ...jobs, source: "failure", units: "skipped" };
  expect(aggregateBatchResult(identity, ["source"], [receipt("source", 1)], failed)).toMatchObject({
    outcome: "code_failure",
    retryable: true,
  });
  expect(aggregateBatchResult(identity, ["source"], [receipt("source", 70)], failed)).toMatchObject(
    { outcome: "code_failure", retryable: false },
  );
});
test.each([75, 124, 126, 127, 137, -1])("exit %i cannot incriminate a PR", (code) => {
  expect(classifyBatchExit(code).outcome).toBe("infrastructure");
});

test("a complete code failure remains evidence even when a sibling runner disappears", () => {
  expect(
    aggregateBatchResult(
      identity,
      ["source", "unit-0", "unit-1"],
      [receipt("source"), receipt("unit-0", 1)],
      { ...jobs, units: "failure" },
    ),
  ).toMatchObject({ outcome: "code_failure", retryable: true });
  expect(
    aggregateBatchResult(identity, ["plan", "source"], [receipt("plan", 1)], {
      plan: "failure",
      source: "skipped",
      units: "skipped",
    }),
  ).toMatchObject({ outcome: "code_failure", retryable: true });
});
test("provider cancellation wins over missing receipts and over an assertion failure", () => {
  expect(
    aggregateBatchResult(identity, ["source", "unit-0"], [receipt("source", 1)], {
      ...jobs,
      source: "failure",
      units: "cancelled",
    }).outcome,
  ).toBe("cancelled");
  expect(classifyBatchExit(143).outcome).toBe("cancelled");
});
test("skipped units are accepted only when the selected inventory is empty", () => {
  expect(
    aggregateBatchResult(identity, ["source"], [receipt("source")], { ...jobs, units: "skipped" })
      .outcome,
  ).toBe("success");
  expect(
    aggregateBatchResult(identity, ["source", "unit-0"], [receipt("source"), receipt("unit-0")], {
      ...jobs,
      units: "skipped",
    }).outcome,
  ).toBe("infrastructure");
});
test("environment identity requires exact SHA and concrete run attempt", () => {
  expect(
    batchIdentity({
      BATCH_ID: "batch-1",
      GITHUB_SHA: identity.headSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }),
  ).toEqual(identity);
  expect(() =>
    batchIdentity({
      BATCH_ID: "batch-1",
      GITHUB_SHA: "main",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }),
  ).toThrow("identity");
});

test("CLI preserves child failure and records its exact identity without retrying", async () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-receipt-test-"));
  try {
    const output = join(directory, "receipt-source.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/ci/batch-result.ts",
        "run",
        "--job",
        "source",
        "--output",
        output,
        "--",
        process.execPath,
        "-e",
        "process.exit(70)",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          BATCH_ID: identity.batchId,
          GITHUB_SHA: identity.headSha,
          GITHUB_RUN_ID: identity.runId,
          GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
        },
      },
    );
    expect(await child.exited).toBe(70);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      ...identity,
      schemaVersion: 1,
      job: "source",
      exitCode: 70,
      outcome: "code_failure",
      retryable: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI emits infrastructure evidence when the command cannot start", async () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-receipt-missing-"));
  try {
    const output = join(directory, "receipt-source.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/ci/batch-result.ts",
        "run",
        "--job",
        "source",
        "--output",
        output,
        "--",
        join(directory, "missing-command"),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          BATCH_ID: identity.batchId,
          GITHUB_SHA: identity.headSha,
          GITHUB_RUN_ID: identity.runId,
          GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
        },
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      ...identity,
      outcome: "infrastructure",
      retryable: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([0, 1])(
  "setup exit %i writes only failure evidence, never a stale test success",
  async (exit) => {
    const directory = mkdtempSync(join(tmpdir(), "batch-setup-receipt-"));
    try {
      const output = join(directory, "receipt-source.json");
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/ci/batch-result.ts",
          "run",
          "--failure-only",
          "--job",
          "source",
          "--output",
          output,
          "--",
          process.execPath,
          "-e",
          `process.exit(${exit})`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            BATCH_ID: identity.batchId,
            GITHUB_SHA: identity.headSha,
            GITHUB_RUN_ID: identity.runId,
            GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
          },
        },
      );
      expect(await child.exited).toBe(exit);
      expect(existsSync(output)).toBe(exit !== 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

describe("comparison evidence never changes or bloats the verdict", () => {
  const plan = {
    schemaVersion: 1 as const,
    unitTests: ["a.test.ts", "b.test.ts"],
    typecheckProjects: [],
    guards: [],
    exampleBuildProjects: [],
    buildPackages: [],
  };
  const env = { runnerOs: "Linux", bun: "1", postgres: "PostgreSQL 18" };
  const inventory = {
    schemaVersion: 1,
    comparisonSchema: COMPARISON_SCHEMA,
    planDigest: digest(plan),
    shards: 1,
    absent: [] as string[],
    units: [
      { category: "parallel", files: ["a.test.ts"] },
      { category: "parallel", files: ["b.test.ts"] },
    ],
    recipePaths: [["bun.lock", "1".repeat(40)]],
  };
  const steps = ["site-runtime", "changeset", "typecheck", "guards"].map((step) => ({
    step,
    exitCode: 0,
  }));
  const rows = (units: unknown[], extra: { source?: object; unit?: object } = {}) => [
    receipt("plan"),
    { ...receipt("source"), environment: env, steps, ...extra.source },
    { ...receipt("unit-0", 1), environment: env, units, ...extra.unit },
  ];
  const evidence = (receipts: unknown[], overrides: Record<string, unknown> = {}) =>
    buildComparisonEvidence({
      identity,
      unitShards: 1,
      receipts,
      verifiedJobs: ["plan", "source", "unit-0"],
      batch: { purpose: "candidate", baseSha: "b".repeat(40) },
      plan,
      inventory,
      ...overrides,
    });
  const units = [
    { category: "parallel", files: ["a.test.ts"], exitCode: 0 },
    { category: "parallel", files: ["b.test.ts"], exitCode: 1 },
  ];

  test("aggregated tasks keep only verdict fields so the result stays within its bound", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => ({
      category: "parallel",
      files: [`packages/some/long/path/file-${i}.test.ts`],
      exitCode: 0,
    }));
    const result = aggregateBatchResult(identity, ["plan", "source", "unit-0"], rows(huge), {
      ...jobs,
      units: "failure",
    });
    expect(result.outcome).toBe("code_failure");
    for (const task of result.tasks) {
      expect(task).not.toHaveProperty("units");
      expect(task).not.toHaveProperty("environment");
      expect(task).not.toHaveProperty("steps");
    }
    expect(JSON.stringify(result).length).toBeLessThan(65_536);
  });

  test("complete evidence maps exits to statuses and binds recipe to role environments", () => {
    const built = evidence(rows(units))!;
    expect(built.coverage.complete).toBe(true);
    expect(built.reasons).toEqual([]);
    expect(built.coverage.units.map((unit) => unit.status)).toEqual(["pass", "fail"]);
    expect(built.coverage.sourceSteps.every((step) => step.status === "pass")).toBe(true);
    expect(built.environment).toEqual({ source: env, unit: env });
    expect(built.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(built.purpose).toBe("candidate");
  });

  test("missing, inconsistent or out-of-inventory evidence is incomplete, never green", () => {
    const incomplete = (receipts: unknown[], overrides?: Record<string, unknown>) => {
      const built = evidence(receipts, overrides);
      expect(built?.coverage.complete ?? false).toBe(false);
      return built;
    };
    expect(incomplete(rows([units[0]]))!.coverage.units[1]!.status).toBe("not-run");
    expect(
      incomplete(rows([units[0], { ...units[1], exitCode: 124 }]))!.coverage.units[1]!.status,
    ).toBe("timeout");
    expect(
      incomplete(rows([units[0], { ...units[1], exitCode: 137 }]))!.coverage.units[1]!.status,
    ).toBe("killed");
    expect(
      incomplete(rows([...units, { category: "parallel", files: ["z.test.ts"], exitCode: 0 }]))!
        .reasons,
    ).toContain("a shard executed a unit outside the inventory");
    expect(
      incomplete(rows(units, { unit: { environment: { ...env, postgres: null } } }))!.recipeDigest,
    ).toBeNull();
    expect(incomplete(rows(units, { source: { environment: undefined } }))!.reasons).toContain(
      "source environment evidence missing",
    );
    expect(
      incomplete(rows(units, { source: { steps: steps.slice(0, 2) } }))!.coverage.sourceSteps[3],
    ).toEqual({
      step: "guards",
      status: "not-run",
      exitCode: null,
    });
    expect(
      incomplete(rows(units), { inventory: { ...inventory, absent: ["c.test.ts"] } })!.coverage
        .absent,
    ).toEqual(["c.test.ts"]);
    expect(
      incomplete(rows(units), { inventory: { ...inventory, planDigest: "0".repeat(64) } })!.reasons,
    ).toContain("inventory was built from another plan");
    expect(
      incomplete(rows(units), {
        batch: { purpose: "base-comparison", baseSha: "b".repeat(40), planDigest: "0".repeat(64) },
      })!.reasons,
    ).toContain("executed plan differs from the frozen base manifest");
    expect(
      incomplete([...rows(units), { ...receipt("unit-0", 1), environment: env, units }])!.reasons,
    ).toContain("duplicate unit-0 receipt");
    // Receipts of another attempt never contribute evidence.
    const stale = rows(units).map((row) =>
      (row as BatchTaskReceipt).job === "unit-0" ? { ...row, runAttempt: 1 } : row,
    );
    expect(incomplete(stale)!.coverage.units.every((unit) => unit.status === "not-run")).toBe(true);
    // No inventory or an unnormalized plan: no comparison at all, attribution holds.
    expect(evidence(rows(units), { inventory: null })).toBeNull();
    expect(
      evidence(rows(units), { plan: { ...plan, unitTests: ["b.test.ts", "a.test.ts"] } }),
    ).toBeNull();
    expect(unitKey({ category: "parallel", files: ["b", "a"] })).toBe(
      unitKey({ category: "parallel", files: ["a", "b"] }),
    );
  });
});

test("CLI records role environment, unit outcomes and steps only as comparison fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-comparison-receipt-"));
  try {
    const output = join(directory, "receipt-unit-0.json");
    writeFileSync(
      join(directory, "outcomes.json"),
      JSON.stringify({ units: [{ category: "parallel", files: ["a.test.ts"], exitCode: 1 }] }),
    );
    writeFileSync(join(directory, "pg.json"), JSON.stringify({ serverVersion: "PostgreSQL 18" }));
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/ci/batch-result.ts",
        "run",
        "--job",
        "unit-0",
        "--output",
        output,
        "--role",
        "unit",
        "--units",
        join(directory, "outcomes.json"),
        "--postgres-evidence",
        join(directory, "pg.json"),
        "--",
        process.execPath,
        "-e",
        "process.exit(1)",
        "--units",
        "ignored-child-argument",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          BATCH_ID: identity.batchId,
          GITHUB_SHA: identity.headSha,
          GITHUB_RUN_ID: identity.runId,
          GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
          RUNNER_OS: "Linux",
        },
      },
    );
    expect(await child.exited).toBe(1);
    const written = JSON.parse(readFileSync(output, "utf8"));
    expect(written).toMatchObject({ job: "unit-0", exitCode: 1, outcome: "code_failure" });
    expect(written.units).toEqual([{ category: "parallel", files: ["a.test.ts"], exitCode: 1 }]);
    expect(written.environment).toMatchObject({ runnerOs: "Linux", postgres: "PostgreSQL 18" });
    expect(written).not.toHaveProperty("steps");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
