#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BASE_PURPOSE,
  COMPARISON_SCHEMA,
  inventoryDigest,
  recipeDigestOf,
  SOURCE_STEPS,
  unitKey,
  validateExecutionPlan,
  type ComparisonEvidence,
} from "../merge-batcher/base-comparison";
import { canonical, digest } from "../merge-batcher/model";
import { environmentIdentity, executionStatus, nodeVersion } from "./batch-comparison";

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
/** Comparison-only task fields; they never enter a receipt or the aggregated verdict. */
export type ComparisonTaskFields = {
  environment?: Record<string, string | null>;
  units?: { category: string; files: string[]; exitCode: number | null }[];
  steps?: { step: string; exitCode: number | null }[];
};
/**
 * One task's comparison evidence, written beside (never inside) its receipt as
 * `comparison-<job>.json`. Receipts keep the exact verdict shape that every
 * base's `receipt-*.json` aggregator copies into the bounded result artifact.
 */
export type ComparisonSidecar = BatchIdentity &
  ComparisonTaskFields & {
    schemaVersion: 1;
    comparisonSchema: typeof COMPARISON_SCHEMA;
    job: string;
  };
const TASK_FIELDS = [
  "schemaVersion",
  "batchId",
  "headSha",
  "runId",
  "runAttempt",
  "job",
  "outcome",
  "retryable",
  "exitCode",
  "startedAt",
  "finishedAt",
] as const;
/** The verdict-bearing receipt only; keeps the result artifact within its bound. */
function verdictTask(row: BatchTaskReceipt): BatchTaskReceipt {
  return Object.fromEntries(TASK_FIELDS.map((key) => [key, row[key]])) as BatchTaskReceipt;
}

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
    verified.push(verdictTask(row as BatchTaskReceipt));
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

/**
 * Comparison evidence for batch-base-comparison/v1, built by the base-checked-out
 * verifier from the plan artifact and the task receipts of this exact attempt.
 * It never changes the verdict. Returns null when the run carries no
 * comparison inventory (absent metadata: the consumer holds attribution).
 */
export function buildComparisonEvidence(input: {
  identity: BatchIdentity;
  unitShards: number;
  sidecars: readonly unknown[];
  verifiedJobs: readonly string[];
  batch: unknown;
  plan: unknown;
  inventory: unknown;
}): ComparisonEvidence | null {
  const inventory = input.inventory as {
    schemaVersion?: unknown;
    comparisonSchema?: unknown;
    planDigest?: unknown;
    shards?: unknown;
    absent?: unknown;
    units?: unknown;
    recipePaths?: unknown;
  } | null;
  const batch = input.batch as { purpose?: unknown; baseSha?: unknown; planDigest?: unknown };
  if (
    !inventory ||
    inventory.schemaVersion !== 1 ||
    inventory.comparisonSchema !== COMPARISON_SCHEMA ||
    !batch ||
    typeof batch.baseSha !== "string" ||
    !Array.isArray(inventory.units) ||
    !Array.isArray(inventory.absent) ||
    !Array.isArray(inventory.recipePaths)
  )
    return null;
  let planDigest: string;
  try {
    planDigest = digest(validateExecutionPlan(input.plan));
  } catch {
    return null;
  }
  const purpose = batch.purpose === BASE_PURPOSE ? BASE_PURPOSE : "candidate";
  const reasons: string[] = [];
  if (inventory.planDigest !== planDigest) reasons.push("inventory was built from another plan");
  if (purpose === BASE_PURPOSE && batch.planDigest !== planDigest)
    reasons.push("executed plan differs from the frozen base manifest");
  if (inventory.shards !== input.unitShards)
    reasons.push("unit shard count differs from inventory");
  const id = input.identity;
  // Evidence counts only for a task whose verdict receipt verified for this
  // exact attempt; an unbound, stale or duplicate sidecar never completes it.
  const rows = new Map<string, ComparisonSidecar>();
  for (const item of input.sidecars) {
    const row = item as ComparisonSidecar | null;
    if (
      !row ||
      row.schemaVersion !== 1 ||
      row.comparisonSchema !== COMPARISON_SCHEMA ||
      row.batchId !== id.batchId ||
      row.headSha !== id.headSha ||
      row.runId !== id.runId ||
      row.runAttempt !== id.runAttempt ||
      !input.verifiedJobs.includes(row.job)
    )
      continue;
    if (rows.has(row.job)) reasons.push(`duplicate ${row.job} comparison evidence`);
    rows.set(row.job, row);
  }
  const expected = (inventory.units as { category: string; files: string[] }[]).map((unit) => ({
    category: String(unit?.category),
    files: Array.isArray(unit?.files) ? unit.files.map(String) : [],
  }));
  const exits = new Map<string, number | null>();
  const known = new Set(expected.map(unitKey));
  for (let shard = 0; shard < input.unitShards; shard++) {
    const units = rows.get(`unit-${shard}`)?.units;
    if (!Array.isArray(units)) continue;
    for (const unit of units) {
      const key = unitKey({
        category: String(unit?.category),
        files: Array.isArray(unit?.files) ? unit.files.map(String) : [],
      });
      if (!known.has(key)) reasons.push("a shard executed a unit outside the inventory");
      else if (exits.has(key)) reasons.push("a unit executed in more than one shard");
      else exits.set(key, Number.isSafeInteger(unit?.exitCode) ? unit.exitCode : null);
    }
  }
  const units = expected.map((unit) => {
    const exitCode = exits.get(unitKey(unit)) ?? null;
    return { ...unit, status: executionStatus(exitCode), exitCode };
  });
  const recorded = rows.get("source")?.steps;
  const sourceSteps = SOURCE_STEPS.map((step) => {
    const entry = Array.isArray(recorded) ? recorded.find((item) => item?.step === step) : null;
    const exitCode = Number.isSafeInteger(entry?.exitCode) ? entry!.exitCode : null;
    return { step, status: executionStatus(exitCode), exitCode };
  });
  // Environment is bound by execution role; plan and ready never ran tests.
  const usable = (value: unknown): Record<string, string | null> | null =>
    value &&
    typeof value === "object" &&
    Object.values(value).length &&
    Object.values(value).every((item) => typeof item === "string" && item)
      ? (value as Record<string, string | null>)
      : null;
  const source = usable(rows.get("source")?.environment);
  if (!source) reasons.push("source environment evidence missing");
  const unitEnvironments = Array.from({ length: input.unitShards }, (_, shard) =>
    usable(rows.get(`unit-${shard}`)?.environment),
  );
  let unit: Record<string, string | null> | null = null;
  if (input.unitShards > 0) {
    if (unitEnvironments.some((value) => !value)) reasons.push("unit environment evidence missing");
    else if (new Set(unitEnvironments.map((value) => canonical(value))).size !== 1)
      reasons.push("unit shards ran in different environments");
    else unit = unitEnvironments[0]!;
  }
  const recipePaths = inventory.recipePaths as [string, string | null][];
  const environment = { source, unit };
  const recipeDigest =
    source && (unit || units.length === 0) ? recipeDigestOf(recipePaths, environment) : null;
  const absent = (inventory.absent as unknown[]).map(String);
  const complete =
    reasons.length === 0 &&
    recipeDigest !== null &&
    absent.length === 0 &&
    units.every((item) => item.status === "pass" || item.status === "fail") &&
    sourceSteps.every((item) => item.status === "pass" || item.status === "fail");
  return {
    schemaVersion: 1,
    comparisonSchema: COMPARISON_SCHEMA,
    purpose,
    batchId: id.batchId,
    headSha: id.headSha,
    runId: id.runId,
    runAttempt: id.runAttempt,
    baseSha: batch.baseSha,
    planDigest,
    recipeDigest,
    recipePaths,
    environment,
    coverage: {
      inventoryDigest: inventoryDigest(units),
      absent,
      units,
      sourceSteps,
      complete,
    },
    reasons,
  };
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function argument(name: string, optional = false): string {
  // Wrapper options precede `--`; never read the wrapped command's arguments.
  const split = process.argv.indexOf("--");
  const own = split < 0 ? process.argv : process.argv.slice(0, split);
  const index = own.indexOf(name);
  const value = index < 0 ? undefined : own[index + 1];
  if (!value) {
    if (optional) return "";
    throw new Error(`Missing ${name}`);
  }
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
      console.error(
        "Batch task could not execute:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (interrupted) exitCode = 130;
    // Comparison-only evidence for this task; never part of its verdict.
    const comparison: ComparisonTaskFields = {};
    const role = argument("--role", true);
    if (role === "source" || role === "unit") {
      try {
        const postgres =
          role === "unit"
            ? (
                readJson(argument("--postgres-evidence", true)) as {
                  serverVersion?: unknown;
                } | null
              )?.serverVersion
            : null;
        comparison.environment = environmentIdentity(role, process.env, {
          node: nodeVersion(),
          postgres: typeof postgres === "string" && postgres ? postgres : null,
        });
      } catch {
        /* missing environment evidence makes the run non-comparable, never red */
      }
    }
    const units = (readJson(argument("--units", true)) as { units?: unknown } | null)?.units;
    if (Array.isArray(units))
      comparison.units = units as NonNullable<ComparisonTaskFields["units"]>;
    const steps = (readJson(argument("--steps", true)) as { steps?: unknown } | null)?.steps;
    if (Array.isArray(steps))
      comparison.steps = steps as NonNullable<ComparisonTaskFields["steps"]>;
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
      const evidence = argument("--evidence", true);
      if (evidence) {
        try {
          const sidecar: ComparisonSidecar = {
            schemaVersion: 1,
            comparisonSchema: COMPARISON_SCHEMA,
            ...identity,
            job,
            ...comparison,
          };
          save(evidence, sidecar);
        } catch (error) {
          console.error(
            "Comparison evidence not recorded; attribution will hold:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    process.exit(exitCode < 0 ? 1 : exitCode);
  } else if (mode === "aggregate") {
    const identity = batchIdentity(process.env);
    const directory = argument("--receipts");
    const units = Number(process.env.UNIT_SHARDS ?? "0");
    if (!Number.isSafeInteger(units) || units < 0 || units > 16)
      throw new Error("Invalid selected shard count");
    const receipts: unknown[] = [];
    for await (const path of new Bun.Glob("**/receipt-*.json").scan({ cwd: directory })) {
      try {
        receipts.push(JSON.parse(readFileSync(join(directory, path), "utf8")));
      } catch {
        receipts.push(null);
      }
    }
    const result = aggregateBatchResult(
      identity,
      ["plan", "source", ...Array.from({ length: units }, (_, i) => `unit-${i}`)],
      receipts,
      {
        plan: process.env.PLAN_RESULT ?? "unknown",
        source: process.env.SOURCE_RESULT ?? "unknown",
        units: process.env.UNITS_RESULT ?? "unknown",
      },
    );
    const output: Record<string, unknown> = { ...result };
    const planDirectory = argument("--plan-dir", true);
    const comparisonOutput = argument("--comparison-output", true);
    if (planDirectory) {
      const batch = readJson(join(planDirectory, "batch.json")) as { purpose?: unknown } | null;
      // A base-comparison result can never verify as a candidate result.
      if (batch?.purpose === BASE_PURPOSE) output.purpose = BASE_PURPOSE;
      if (comparisonOutput) {
        try {
          const sidecars: unknown[] = [];
          for await (const path of new Bun.Glob("**/comparison-*.json").scan({ cwd: directory }))
            sidecars.push(readJson(join(directory, path)));
          const evidence = buildComparisonEvidence({
            identity,
            unitShards: units,
            sidecars,
            verifiedJobs: result.tasks.map((task) => task.job),
            batch,
            plan: readJson(join(planDirectory, "execution-plan.json")),
            inventory: readJson(join(planDirectory, "inventory.json")),
          });
          if (evidence) {
            save(comparisonOutput, evidence);
            output.comparison = {
              comparisonSchema: COMPARISON_SCHEMA,
              purpose: evidence.purpose,
              evidenceDigest: digest(evidence),
            };
          }
        } catch (error) {
          console.error(
            "Comparison evidence unavailable; attribution will hold:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    save(argument("--output"), output);
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
