#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@opengeni/contracts/values";

export type BatchOutcome = "success" | "code_failure" | "infrastructure" | "cancelled";
export type BatchIdentity = {
  batchId: string;
  headSha: string;
  runId: string;
  runAttempt: number;
};
export type BatchTaskReceipt = BatchIdentity & {
  schemaVersion: 1;
  job: string;
  outcome: BatchOutcome;
  retryable: boolean;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
};

export function classifyBatchExit(code: number): { outcome: BatchOutcome; retryable: boolean } {
  if (code === 0) return { outcome: "success", retryable: false };
  if (code === 130 || code === 143) return { outcome: "cancelled", retryable: false };
  // Deadline, OOM/signal, missing executable and failed execution are not an
  // assertion verdict. Exit70 is a process leak: code-red, but never retry it away.
  if (code < 0 || code === 75 || code === 124 || code === 126 || code === 127 || code >= 128)
    return { outcome: "infrastructure", retryable: false };
  return { outcome: "code_failure", retryable: code !== 70 };
}

export function batchIdentity(env: Record<string, string | undefined>): BatchIdentity {
  const { BATCH_ID: batchId, GITHUB_SHA: headSha, GITHUB_RUN_ID: runId } = env;
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    !batchId ||
    !headSha ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !runId ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  )
    throw new Error("Missing exact batch/SHA/run/attempt identity");
  return { batchId, headSha, runId, runAttempt };
}

/** Cancellation, then a code failure (a 70 process leak first), then infrastructure, then green. */
export function combineBatchExits(codes: readonly number[]): number {
  const of = (outcome: BatchOutcome) =>
    codes.filter((code) => classifyBatchExit(code).outcome === outcome);
  const cancelled = of("cancelled"),
    code = of("code_failure"),
    infrastructure = of("infrastructure");
  if (cancelled.length) return cancelled[0]!;
  if (code.length) return code.includes(70) ? 70 : code[0]!;
  if (infrastructure.length) return infrastructure[0]!;
  return 0;
}

function validTask(row: unknown, identity: BatchIdentity, job: string): row is BatchTaskReceipt {
  const task = row as Partial<BatchTaskReceipt> | null;
  if (
    !task ||
    task.schemaVersion !== 1 ||
    task.batchId !== identity.batchId ||
    task.headSha !== identity.headSha ||
    task.runId !== identity.runId ||
    task.runAttempt !== identity.runAttempt ||
    task.job !== job ||
    !Number.isSafeInteger(task.exitCode) ||
    typeof task.startedAt !== "string" ||
    typeof task.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(task.startedAt)) ||
    !Number.isFinite(Date.parse(task.finishedAt))
  )
    return false;
  const classified = classifyBatchExit(task.exitCode!);
  return classified.outcome === task.outcome && classified.retryable === task.retryable;
}

export interface LanesFold {
  receipts: unknown[];
  sourceJob: string;
  components: { source: BatchTaskReceipt | null; lanes: BatchTaskReceipt | null };
  lanes: { required: true; result: string; verdict: string; receipt: "valid" | "invalid" };
}

/**
 * Main CI lanes in Batch CI (docs/merge-batcher.md): the lane receipt joins the
 * `source` class, so a controller that only knows `plan`, `source` and
 * `unit-N` still verifies one complete result. The folded source task keeps
 * the earliest start, the latest finish and the precedence of both exits.
 * Missing or invalid lane evidence is infrastructure, never green.
 */
export function foldLanes(
  identity: BatchIdentity,
  receipts: readonly unknown[],
  laneReceipts: readonly unknown[],
  results: { source: string; lanes: string; verdict: string },
): LanesFold {
  const lane =
    laneReceipts.length === 1 && validTask(laneReceipts[0], identity, "lanes")
      ? laneReceipts[0]
      : null;
  const sourceIndexes = receipts.flatMap((row, index) =>
    validTask(row, identity, "source") ? [index] : [],
  );
  const source =
    sourceIndexes.length === 1 ? (receipts[sourceIndexes[0]!] as BatchTaskReceipt) : null;
  const resultValues = [results.source, results.lanes, results.verdict];
  const sourceJob = resultValues.includes("cancelled")
    ? "cancelled"
    : resultValues.every((value) => value === "success")
      ? "success"
      : "failure";
  const folded = [...receipts];
  if (source) {
    const laneExit = lane ? lane.exitCode : results.lanes === "cancelled" ? 130 : 75;
    const exitCode = combineBatchExits([source.exitCode, laneExit]);
    const starts = [source.startedAt, ...(lane ? [lane.startedAt] : [])];
    const ends = [source.finishedAt, ...(lane ? [lane.finishedAt] : [])];
    folded[sourceIndexes[0]!] = {
      ...source,
      ...classifyBatchExit(exitCode),
      exitCode,
      startedAt: starts.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)),
      finishedAt: ends.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)),
    } satisfies BatchTaskReceipt;
  }
  return {
    receipts: folded,
    sourceJob,
    components: { source, lanes: lane },
    lanes: {
      required: true,
      result: results.lanes,
      verdict: results.verdict,
      receipt: lane ? "valid" : "invalid",
    },
  };
}

export function aggregateBatchResult(
  identity: BatchIdentity,
  expectedJobs: readonly string[],
  receipts: readonly unknown[],
  jobs: { plan: string; source: string; units: string },
) {
  let outcome: BatchOutcome = "success";
  let reason = "All selected source and unit checks passed";
  const verified: BatchTaskReceipt[] = [];
  const invalidReasons: string[] = [];
  const invalid = (message: string) => {
    invalidReasons.push(message);
  };
  const seen = new Set<string>();
  for (const item of receipts) {
    const row = item as Partial<BatchTaskReceipt> | null;
    if (
      !row ||
      row.schemaVersion !== 1 ||
      row.batchId !== identity.batchId ||
      row.headSha !== identity.headSha ||
      row.runId !== identity.runId ||
      row.runAttempt !== identity.runAttempt ||
      !row.job ||
      !expectedJobs.includes(row.job) ||
      seen.has(row.job) ||
      !Number.isSafeInteger(row.exitCode) ||
      typeof row.retryable !== "boolean" ||
      !["success", "code_failure", "infrastructure", "cancelled"].includes(row.outcome ?? "")
    ) {
      invalid("Missing, duplicate, malformed or wrong-attempt task receipt");
      continue;
    }
    const classified = classifyBatchExit(row.exitCode!);
    if (classified.outcome !== row.outcome || classified.retryable !== row.retryable) {
      invalid("Task outcome does not match its recorded process exit");
      continue;
    }
    seen.add(row.job);
    verified.push(row as BatchTaskReceipt);
  }
  if (jobs.plan !== "success") invalid("Candidate planning did not complete successfully");
  if (expectedJobs.some((job) => !seen.has(job)))
    invalid("Not every selected job produced a receipt");
  if (invalidReasons.length === 0) {
    if (verified.some((row) => row.outcome === "infrastructure")) {
      invalid("At least one task ended without a code verdict");
    } else if (
      verified.some((row) => row.outcome === "cancelled") ||
      Object.values(jobs).includes("cancelled")
    ) {
      outcome = "cancelled";
      reason = "Cancellation is not a failing PR verdict";
    } else if (verified.some((row) => row.outcome === "code_failure")) {
      outcome = "code_failure";
      reason = "Completed checks reported a code failure";
    } else if (
      jobs.source !== "success" ||
      (expectedJobs.some((job) => job.startsWith("unit-"))
        ? jobs.units !== "success"
        : jobs.units !== "skipped")
    ) {
      invalid("Provider job result is not consistent with complete successful receipts");
    }
  }
  if (invalidReasons.length > 0) {
    outcome = "infrastructure";
    reason = invalidReasons.join("; ");
  }
  // A missing sibling does not erase a completed assertion on this exact tip.
  // This never permits green with partial evidence. Cancellation still wins.
  if (verified.some((row) => row.outcome === "code_failure")) {
    outcome = "code_failure";
    reason =
      "Completed checks reported a code failure" +
      (invalidReasons.length ? `; incomplete sibling evidence: ${invalidReasons.join("; ")}` : "");
  }
  // A provider cancellation wins even when interrupted tasks never wrote files.
  if (Object.values(jobs).includes("cancelled")) {
    outcome = "cancelled";
    reason = "Cancellation is not a failing PR verdict";
  }
  const retryable =
    outcome === "code_failure" &&
    verified.filter((row) => row.outcome === "code_failure").every((row) => row.retryable);
  return {
    schemaVersion: 1 as const,
    ...identity,
    outcome,
    retryable,
    reason,
    expectedJobs: [...expectedJobs],
    jobs,
    tasks: verified,
    finishedAt: new Date().toISOString(),
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "run") {
    const identity = batchIdentity(process.env);
    const job = argument("--job"),
      output = argument("--output");
    const split = process.argv.indexOf("--");
    if (split < 0 || !process.argv[split + 1]) throw new Error("Missing command after --");
    const startedAt = new Date().toISOString();
    let interrupted = false;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        interrupted = true;
        child?.kill(signal);
      });
    let exitCode = -1;
    try {
      child = Bun.spawn(process.argv.slice(split + 1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      });
      exitCode = await child.exited;
    } catch (error) {
      console.error("Batch task could not execute:", errorMessage(error));
    }
    if (interrupted) exitCode = 130;
    // Setup success is not test success. If a later test is killed, do not
    // leave a stale green setup receipt masquerading as that test's result.
    if (exitCode !== 0 || !process.argv.slice(0, split).includes("--failure-only")) {
      save(output, {
        schemaVersion: 1,
        ...identity,
        job,
        ...classifyBatchExit(exitCode),
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
    process.exit(exitCode < 0 ? 1 : exitCode);
  } else if (mode === "aggregate") {
    const identity = batchIdentity(process.env);
    const directory = argument("--receipts");
    const units = Number(process.env.UNIT_SHARDS ?? "0");
    if (!Number.isSafeInteger(units) || units < 0 || units > 16)
      throw new Error("Invalid selected shard count");
    const read = async (pattern: string) => {
      const rows: unknown[] = [];
      for await (const path of new Bun.Glob(pattern).scan({ cwd: directory })) {
        try {
          rows.push(JSON.parse(readFileSync(join(directory, path), "utf8")));
        } catch {
          rows.push(null);
        }
      }
      return rows;
    };
    let receipts = await read("**/receipt-*.json");
    let source = process.env.SOURCE_RESULT ?? "unknown";
    let extra: Omit<LanesFold, "receipts" | "sourceJob"> | undefined;
    if (process.env.BATCH_LANES === "required") {
      const {
        receipts: folded,
        sourceJob,
        ...rest
      } = foldLanes(identity, receipts, await read("**/lanes-receipt.json"), {
        source,
        lanes: process.env.LANES_RESULT ?? "unknown",
        verdict: process.env.LANES_VERDICT_RESULT ?? "unknown",
      });
      receipts = folded;
      source = sourceJob;
      extra = rest;
    } else if (process.env.BATCH_LANES) throw new Error("Invalid BATCH_LANES");
    const result = {
      ...aggregateBatchResult(
        identity,
        ["plan", "source", ...Array.from({ length: units }, (_, i) => `unit-${i}`)],
        receipts,
        {
          plan: process.env.PLAN_RESULT ?? "unknown",
          source,
          units: process.env.UNITS_RESULT ?? "unknown",
        },
      ),
      ...extra,
    };
    save(argument("--output"), result);
    console.log(
      JSON.stringify({
        outcome: result.outcome,
        reason: result.reason,
        retryable: result.retryable,
      }),
    );
    // The artifact is authoritative only together with this exact provider run.
    // The next workflow step uploads it even when this gate is not green.
    process.exit(result.outcome === "success" ? 0 : 1);
  } else throw new Error("usage: batch-result.ts run|aggregate [options]");
}
