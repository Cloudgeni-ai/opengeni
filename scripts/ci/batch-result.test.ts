import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateBatchResult,
  batchIdentity,
  classifyBatchExit,
  combineBatchExits,
  foldLanes,
  type BatchTaskReceipt,
} from "./batch-result";
import type { Manifest } from "../merge-batcher/model";
import { verifyResult } from "../merge-batcher/result";
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

const laneReceipt = (
  exitCode = 0,
  startedAt = "2026-10-21T11:00:30Z",
  finishedAt = "2026-10-21T11:30:00Z",
) => ({
  ...receipt("lanes", exitCode),
  startedAt,
  finishedAt,
});
const greenResults = { source: "success", lanes: "success", verdict: "success" };

test("main lanes fold into the source task with exit precedence and the widest time span", () => {
  const green = foldLanes(
    identity,
    [receipt("plan"), receipt("source")],
    [laneReceipt()],
    greenResults,
  );
  expect(green.sourceJob).toBe("success");
  expect(green.receipts[1]).toMatchObject({
    job: "source",
    exitCode: 0,
    outcome: "success",
    startedAt: "2026-10-21T11:00:00Z",
    finishedAt: "2026-10-21T11:30:00Z",
  });
  expect(green.components.lanes).toMatchObject({ job: "lanes", exitCode: 0 });
  expect(green.lanes).toEqual({
    required: true,
    result: "success",
    verdict: "success",
    receipt: "valid",
  });
  const cases: [number, number, number][] = [
    [0, 1, 1],
    [0, 70, 70],
    [1, 70, 70],
    [0, 124, 124],
    [1, 124, 1],
    [124, 1, 1],
    [0, 130, 130],
    [1, 130, 130],
    [75, 0, 75],
  ];
  for (const [source, lanes, expected] of cases) {
    const folded = foldLanes(identity, [receipt("source", source)], [laneReceipt(lanes)], {
      ...greenResults,
      lanes: lanes === 0 ? "success" : "failure",
    });
    expect(folded.receipts[0]).toMatchObject({
      exitCode: expected,
      ...classifyBatchExit(expected),
    });
  }
  expect(combineBatchExits([])).toBe(0);
});

test("missing, duplicate or foreign lane evidence is infrastructure, never green", () => {
  for (const lanes of [
    [],
    [laneReceipt(), laneReceipt()],
    [{ ...laneReceipt(), runAttempt: 1 }],
    [{ ...laneReceipt(), job: "source" }],
    [null],
  ]) {
    const folded = foldLanes(identity, [receipt("source")], lanes, greenResults);
    expect(folded.lanes.receipt).toBe("invalid");
    expect(folded.receipts[0]).toMatchObject({ exitCode: 75, outcome: "infrastructure" });
  }
  const cancelled = foldLanes(identity, [receipt("source")], [], {
    ...greenResults,
    lanes: "cancelled",
  });
  expect(cancelled.receipts[0]).toMatchObject({ exitCode: 130, outcome: "cancelled" });
  expect(cancelled.sourceJob).toBe("cancelled");
  // A source code failure stays evidence even without lane evidence.
  const red = foldLanes(identity, [receipt("source", 1)], [], {
    ...greenResults,
    source: "failure",
    lanes: "failure",
    verdict: "failure",
  });
  expect(red.receipts[0]).toMatchObject({ exitCode: 1, outcome: "code_failure" });
  expect(red.sourceJob).toBe("failure");
});

test("a folded result satisfies the deployed controller verifier for every outcome", () => {
  const manifest = { batchId: identity.batchId, tipSha: identity.headSha } as unknown as Manifest;
  const verify = (lanesExit: number, results: typeof greenResults) => {
    const folded = foldLanes(
      identity,
      [receipt("plan"), receipt("source"), receipt("unit-0")],
      [laneReceipt(lanesExit)],
      results,
    );
    const result = aggregateBatchResult(identity, ["plan", "source", "unit-0"], folded.receipts, {
      plan: "success",
      source: folded.sourceJob,
      units: "success",
    });
    return {
      result,
      verified: verifyResult(
        { ...result, components: folded.components, lanes: folded.lanes },
        manifest,
        123,
        2,
      ),
    };
  };
  const green = verify(0, greenResults);
  expect(green.result.outcome).toBe("success");
  expect(green.verified).toMatchObject({ outcome: "success" });
  const red = verify(1, { ...greenResults, lanes: "failure", verdict: "failure" });
  expect(red.result).toMatchObject({ outcome: "code_failure", retryable: true });
  expect(red.verified).toMatchObject({ outcome: "code_failure", retryable: true });
  const infra = verify(124, { ...greenResults, lanes: "failure", verdict: "failure" });
  expect(infra.result.outcome).toBe("infrastructure");
  expect(infra.verified).toMatchObject({ outcome: "infrastructure", infrastructureOnly: true });
  const lanesGreenVerdictLost = verify(0, { ...greenResults, verdict: "failure" });
  expect(lanesGreenVerdictLost.result.outcome).toBe("infrastructure");
});

test("the verifier names the failing folded component for exact-base comparison", () => {
  const manifest = { batchId: identity.batchId, tipSha: identity.headSha } as unknown as Manifest;
  const classes = (
    sourceExit: number,
    lanesExit: number,
    mutate?: (r: Record<string, any>) => void,
  ) => {
    const folded = foldLanes(
      identity,
      [receipt("plan"), receipt("source", sourceExit)],
      [laneReceipt(lanesExit)],
      {
        source: sourceExit ? "failure" : "success",
        lanes: lanesExit ? "failure" : "success",
        verdict: lanesExit ? "failure" : "success",
      },
    );
    const result: Record<string, any> = {
      ...aggregateBatchResult(identity, ["plan", "source"], folded.receipts, {
        plan: "success",
        source: folded.sourceJob,
        units: "skipped",
      }),
      components: folded.components,
      lanes: folded.lanes,
    };
    mutate?.(result);
    return verifyResult(result, manifest, 123, 2)?.failedClasses;
  };
  expect(classes(0, 1)).toEqual(["lanes"]);
  expect(classes(1, 0)).toEqual(["source"]);
  expect(classes(1, 1)).toEqual(["source", "lanes"]);
  expect(classes(1, 124)).toEqual(["source"]);
  // Without components, or with components that do not fold into the task, it stays `source`.
  expect(classes(0, 1, (r) => delete r.components)).toEqual(["source"]);
  expect(classes(0, 1, (r) => (r.components.lanes.exitCode = 0))).toEqual(["source"]);
  expect(classes(0, 1, (r) => (r.components.lanes.runAttempt = 1))).toEqual(["source"]);
});

test("CLI aggregate folds the lane receipt only when Batch CI requires it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "batch-lanes-aggregate-"));
  try {
    const write = (name: string, data: unknown) =>
      Bun.write(join(directory, "receipts", name), JSON.stringify(data));
    await write("receipt-plan.json", receipt("plan"));
    await write("receipt-source.json", receipt("source"));
    await write("lanes-receipt.json", laneReceipt(1));
    const run = async (extra: Record<string, string>) => {
      const output = join(directory, `result-${Object.keys(extra).length}.json`);
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/ci/batch-result.ts",
          "aggregate",
          "--receipts",
          join(directory, "receipts"),
          "--output",
          output,
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
            UNIT_SHARDS: "0",
            PLAN_RESULT: "success",
            SOURCE_RESULT: "success",
            UNITS_RESULT: "skipped",
            ...extra,
          },
        },
      );
      const code = await child.exited;
      return { code, result: JSON.parse(readFileSync(output, "utf8")) };
    };
    const legacy = await run({});
    expect(legacy.code).toBe(0);
    expect(legacy.result.outcome).toBe("success");
    const lanes = await run({
      BATCH_LANES: "required",
      LANES_RESULT: "failure",
      LANES_VERDICT_RESULT: "failure",
    });
    expect(lanes.code).toBe(1);
    expect(lanes.result).toMatchObject({
      outcome: "code_failure",
      jobs: { source: "failure" },
      lanes: { required: true, receipt: "valid" },
      components: { source: { exitCode: 0 }, lanes: { exitCode: 1 } },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
