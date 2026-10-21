import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateBatchResult,
  batchIdentity,
  classifyBatchExit,
  type BatchTaskReceipt,
} from "./batch-result";
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
