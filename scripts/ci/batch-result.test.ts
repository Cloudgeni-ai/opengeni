import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateBatchResult,
  batchIdentity,
  buildComparisonEvidence,
  classifyBatchExit,
  type BatchTaskReceipt,
} from "./batch-result";
import { expectedUnits } from "./batch-comparison";
import {
  configuredFilesPerProcess,
  deterministicUnitTestShards,
  shardProcessPlan,
  UNIT_PROCESS_CATEGORIES,
} from "./run-unit-shard";
import { discoverTestFiles } from "./workspace";
import {
  COMPARISON_SCHEMA,
  executionPlan,
  SOURCE_STEPS,
  unitKey,
} from "../merge-batcher/base-comparison";
import { readResultZip } from "../merge-batcher/github";
import { digest } from "../merge-batcher/model";
const identity = { batchId: "batch-1", headSha: "a".repeat(40), runId: "123", runAttempt: 2 };
const jobs = { plan: "success", source: "success", units: "success" };
const VERDICT_FIELDS = [
  "batchId",
  "exitCode",
  "finishedAt",
  "headSha",
  "job",
  "outcome",
  "retryable",
  "runAttempt",
  "runId",
  "schemaVersion",
  "startedAt",
];
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
  const sidecar = (job: string, fields: object) => ({
    schemaVersion: 1,
    comparisonSchema: COMPARISON_SCHEMA,
    ...identity,
    job,
    ...fields,
  });
  const rows = (units: unknown[], extra: { source?: object; unit?: object } = {}) => [
    sidecar("source", { environment: env, steps, ...extra.source }),
    sidecar("unit-0", { environment: env, units, ...extra.unit }),
  ];
  const evidence = (sidecars: unknown[], overrides: Record<string, unknown> = {}) =>
    buildComparisonEvidence({
      identity,
      unitShards: 1,
      sidecars,
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

  test("stray receipt fields never reach the aggregated verdict or its bound", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => ({
      category: "parallel",
      files: [`packages/some/long/path/file-${i}.test.ts`],
      exitCode: 0,
    }));
    const stray = [
      receipt("plan"),
      { ...receipt("source"), environment: env, steps },
      { ...receipt("unit-0", 1), environment: env, units: huge },
    ];
    const result = aggregateBatchResult(identity, ["plan", "source", "unit-0"], stray, {
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
    const incomplete = (sidecars: unknown[], overrides?: Record<string, unknown>) => {
      const built = evidence(sidecars, overrides);
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
      incomplete([...rows(units), sidecar("unit-0", { environment: env, units })])!.reasons,
    ).toContain("duplicate unit-0 comparison evidence");
    // Evidence of another attempt, tip or schema, or of a task whose verdict
    // receipt did not verify, never contributes.
    for (const unbound of [
      { runAttempt: 1 },
      { headSha: "c".repeat(40) },
      { comparisonSchema: "batch-base-comparison/v0" },
      { schemaVersion: 2 },
    ]) {
      const stale = rows(units).map((row) =>
        (row as { job: string }).job === "unit-0" ? { ...row, ...unbound } : row,
      );
      expect(incomplete(stale)!.coverage.units.every((unit) => unit.status === "not-run")).toBe(
        true,
      );
    }
    expect(
      incomplete(rows(units), { verifiedJobs: ["plan", "source"] })!.coverage.units.every(
        (unit) => unit.status === "not-run",
      ),
    ).toBe(true);
    // Evidence can never be read from a verdict receipt.
    expect(
      incomplete([
        { ...receipt("source"), environment: env, steps },
        { ...receipt("unit-0", 1), environment: env, units },
      ])!.coverage.units.every((unit) => unit.status === "not-run"),
    ).toBe(true);
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

test("CLI keeps the receipt verdict-only and writes role evidence to its sidecar", async () => {
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
        "--evidence",
        join(directory, "comparison-unit-0.json"),
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
    // Exactly the verdict shape every base's receipt-*.json aggregator copies.
    expect(Object.keys(written).sort()).toEqual(VERDICT_FIELDS);
    const evidence = JSON.parse(readFileSync(join(directory, "comparison-unit-0.json"), "utf8"));
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      comparisonSchema: COMPARISON_SCHEMA,
      ...identity,
      job: "unit-0",
    });
    expect(evidence.units).toEqual([{ category: "parallel", files: ["a.test.ts"], exitCode: 1 }]);
    expect(evidence.environment).toMatchObject({ runnerOs: "Linux", postgres: "PostgreSQL 18" });
    expect(evidence).not.toHaveProperty("steps");
    expect(evidence).not.toHaveProperty("exitCode");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A one-entry stored ZIP, as the provider serves a batch-result artifact. */
function storedZip(entry: string, data: Buffer): Uint8Array {
  const name = Buffer.from(entry);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, directory, name, end]);
}

// The ready job runs the verifier of the candidate's inspected base, not the
// candidate's own. This is the exact current-main verifier (blob d4c1b9dc), which
// copies every receipt-*.json row into the result the controller reads.
test("a full-inventory batch stays within an older base verifier's controller bound", async () => {
  const fixture = readFileSync("scripts/ci/fixtures/batch-result-aggregator-d4c1b9dc.ts.txt");
  expect(
    new Bun.CryptoHasher("sha1").update(`blob ${fixture.length}\0`).update(fixture).digest("hex"),
  ).toBe("d4c1b9dceee64375fb70fd258da47468bf7ac786");
  const directory = mkdtempSync(join(tmpdir(), "batch-old-base-verifier-"));
  try {
    const receipts = join(directory, "receipts");
    const planDirectory = join(directory, "plan");
    const bin = join(directory, "bin");
    for (const path of [receipts, planDirectory, bin]) mkdirSync(path);
    // Runner toolchain identity: every role environment field is concrete.
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho v22.23.4\n");
    chmodSync(join(bin, "node"), 0o755);
    const verifier = join(directory, "base-batch-result.ts");
    writeFileSync(verifier, fixture);
    const root = process.cwd();
    const plan = executionPlan({
      schemaVersion: 1,
      unitTests: discoverTestFiles(root).unit,
      typecheckProjects: [],
      guards: [],
      exampleBuildProjects: [],
      buildPackages: [],
    });
    const shards = 16;
    const filesPerProcess = configuredFilesPerProcess({});
    const perShard = deterministicUnitTestShards(root, plan.unitTests, shards).map((selected) => {
      const processes = shardProcessPlan(root, selected, filesPerProcess);
      return UNIT_PROCESS_CATEGORIES.flatMap((category) =>
        processes[category].map((task) => ({ category, files: [...task.files], exitCode: 0 })),
      );
    });
    const inventoryUnits = expectedUnits(root, plan, shards, filesPerProcess);
    expect(perShard.flat().map(unitKey)).toEqual(inventoryUnits.map(unitKey));
    // The scale that broke the verdict bound: thousands of unit processes.
    expect(inventoryUnits.length).toBeGreaterThan(1000);
    writeFileSync(join(planDirectory, "execution-plan.json"), JSON.stringify(plan));
    writeFileSync(
      join(planDirectory, "batch.json"),
      JSON.stringify({ purpose: "candidate", baseSha: "b".repeat(40) }),
    );
    writeFileSync(
      join(planDirectory, "inventory.json"),
      JSON.stringify({
        schemaVersion: 1,
        comparisonSchema: COMPARISON_SCHEMA,
        planDigest: digest(plan),
        shards,
        filesPerProcess,
        absent: [],
        units: inventoryUnits,
        recipePaths: [["bun.lock", "1".repeat(40)]],
      }),
    );
    writeFileSync(
      join(directory, "steps.json"),
      JSON.stringify({ steps: SOURCE_STEPS.map((step) => ({ step, exitCode: 0 })) }),
    );
    writeFileSync(join(directory, "pg.json"), JSON.stringify({ serverVersion: "PostgreSQL 18" }));
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BATCH_ID: identity.batchId,
      GITHUB_SHA: identity.headSha,
      GITHUB_RUN_ID: identity.runId,
      GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      ImageOS: "ubuntu24",
      ImageVersion: "20261020.1",
      OPENGENI_TEST_MAX_CONCURRENCY: "4",
      OPENGENI_TYPECHECK_CONCURRENCY: "4",
      CARGO_BUILD_JOBS: "4",
      OPENGENI_REQUIRE_REAL_DB: "1",
      UNIT_SHARDS: String(shards),
      PLAN_RESULT: "success",
      SOURCE_RESULT: "success",
      UNITS_RESULT: "success",
    };
    // Each task writes its receipt and sidecar exactly as the workflow does.
    const task = async (job: string, role: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/ci/batch-result.ts",
          "run",
          "--job",
          job,
          "--output",
          join(receipts, `receipt-${job}.json`),
          ...role,
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        { stdout: "ignore", stderr: "pipe", env },
      );
      expect(await child.exited).toBe(0);
    };
    await task("plan", []);
    await task("source", [
      "--role",
      "source",
      "--steps",
      join(directory, "steps.json"),
      "--evidence",
      join(receipts, "comparison-source.json"),
    ]);
    for (let shard = 0; shard < shards; shard++) {
      const outcomes = join(directory, `outcomes-${shard}.json`);
      writeFileSync(outcomes, JSON.stringify({ units: perShard[shard] }));
      await task(`unit-${shard}`, [
        "--role",
        "unit",
        "--postgres-evidence",
        join(directory, "pg.json"),
        "--units",
        outcomes,
        "--evidence",
        join(receipts, `comparison-unit-${shard}.json`),
      ]);
    }
    const aggregate = async (script: string, output: string, extra: string[] = []) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          script,
          "aggregate",
          "--receipts",
          receipts,
          "--output",
          output,
          ...extra,
        ],
        { stdout: "pipe", stderr: "pipe", env },
      );
      return { exit: await child.exited, bytes: readFileSync(output) };
    };
    const accepted = (bytes: Buffer) =>
      JSON.parse(readResultZip(storedZip("batch-result.json", bytes))) as { outcome: string };

    // The deployed base verifier sees verdict-only receipts and stays bounded.
    const old = await aggregate(verifier, join(directory, "old-result.json"));
    expect(old.exit).toBe(0);
    expect(old.bytes.length).toBeLessThan(65_536);
    expect(accepted(old.bytes).outcome).toBe("success");

    // This revision's verifier completes the comparison evidence from sidecars.
    const comparison = join(directory, "batch-comparison.json");
    const current = await aggregate("scripts/ci/batch-result.ts", join(directory, "result.json"), [
      "--plan-dir",
      planDirectory,
      "--comparison-output",
      comparison,
    ]);
    expect(current.exit).toBe(0);
    expect(current.bytes.length).toBeLessThan(65_536);
    expect(accepted(current.bytes).outcome).toBe("success");
    const evidence = JSON.parse(readFileSync(comparison, "utf8"));
    expect(evidence.reasons).toEqual([]);
    expect(evidence.coverage.complete).toBe(true);
    expect(evidence.coverage.units).toHaveLength(inventoryUnits.length);

    // Negative control: evidence folded into receipts, as the previous revision
    // wrote them, overflows the same verifier's bound and is rejected.
    for (const job of ["source", ...Array.from({ length: shards }, (_, i) => `unit-${i}`)]) {
      const path = join(receipts, `receipt-${job}.json`);
      const sidecar = JSON.parse(readFileSync(join(receipts, `comparison-${job}.json`), "utf8"));
      const { environment, units, steps } = sidecar;
      writeFileSync(
        path,
        JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), environment, units, steps }),
      );
    }
    const folded = await aggregate(verifier, join(directory, "folded-result.json"));
    expect(folded.bytes.length).toBeGreaterThan(65_536);
    expect(() => accepted(folded.bytes)).toThrow("Invalid result entry");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
