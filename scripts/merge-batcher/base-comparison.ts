// Producer side of the versioned batch base-comparison contract
// (batch-base-comparison/v1), agreed with the active-lane consumer. A failed
// candidate is compared with the exact base's own run of the SAME frozen batch
// inventory and recipe. These helpers are pure or read-only: they never
// publish, reserve capacity, rerun, cancel or land. The consumer owns the
// durable once-only reservation, discovery, capacity accounting and recovery.
import { GitFailure, type GitStore } from "./git";
import { assertSha, canonical, digest, type Run } from "./model";
import { verifyRunResult, type VerifiedResult } from "./result";

export const COMPARISON_SCHEMA = "batch-base-comparison/v1" as const;
export const BASE_PURPOSE = "base-comparison" as const;
export const BASE_TRAILER = "Batch-Base-Manifest: ";
const CANDIDATE_TRAILER = "Batch-Manifest: ";
/** Present in every tree whose batch workflow implements this contract. */
export const COMPARISON_MARKER = "scripts/ci/batch-comparison.json";
export const BATCH_WORKFLOW = ".github/workflows/batch-ci.yml";
export const SOURCE_STEPS = ["site-runtime", "changeset", "typecheck", "guards"] as const;
export type SourceStep = (typeof SOURCE_STEPS)[number];
export const EXECUTION_STATUSES = [
  "pass",
  "fail",
  "timeout",
  "killed",
  "infrastructure",
  "not-run",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
const MAX_TRAILER_BYTES = 1_000_000;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;

/** The plan fields the batch workflow actually executes; nothing else is frozen. */
export interface ExecutionPlan {
  schemaVersion: 1;
  unitTests: string[];
  typecheckProjects: string[];
  guards: string[];
  exampleBuildProjects: string[];
  buildPackages: string[];
}
const PLAN_LISTS = [
  "unitTests",
  "typecheckProjects",
  "guards",
  "exampleBuildProjects",
  "buildPackages",
] as const;

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new Error(`Invalid execution plan ${name}`);
  return value as string[];
}

/** Normalizes an impact plan to its executed fields; unit order never affects execution. */
export function executionPlan(raw: unknown): ExecutionPlan {
  const plan = raw as Record<string, unknown> | null;
  if (!plan || typeof plan !== "object" || plan.schemaVersion !== 1)
    throw new Error("Unsupported or malformed impact plan");
  return {
    schemaVersion: 1,
    unitTests: [...new Set(stringList(plan.unitTests, "unitTests"))].sort(),
    typecheckProjects: [...stringList(plan.typecheckProjects, "typecheckProjects")],
    guards: [...stringList(plan.guards, "guards")],
    exampleBuildProjects: [...stringList(plan.exampleBuildProjects, "exampleBuildProjects")],
    buildPackages: [...stringList(plan.buildPackages, "buildPackages")],
  };
}

/** An already frozen plan: exact keys and already normalized. */
export function validateExecutionPlan(raw: unknown): ExecutionPlan {
  const keys = Object.keys((raw as object) ?? {}).sort();
  if (canonical(keys) !== canonical(["schemaVersion", ...PLAN_LISTS].sort()))
    throw new Error("Execution plan has unexpected fields");
  const plan = executionPlan(raw);
  if (canonical(plan) !== canonical(raw)) throw new Error("Execution plan is not normalized");
  return plan;
}

export interface BaseManifest {
  comparisonSchema: typeof COMPARISON_SCHEMA;
  purpose: typeof BASE_PURPOSE;
  baseSha: string;
  baseTreeSha: string;
  planDigest: string;
  recipeDigest: string;
  plan: ExecutionPlan;
}
export interface BaseRun {
  baseRunId: string;
  tipSha: string;
  manifest: BaseManifest;
}

export function validateBaseManifest(raw: unknown): BaseManifest {
  const m = raw as BaseManifest | null;
  const keys = Object.keys((m as object) ?? {}).sort();
  if (
    !m ||
    canonical(keys) !==
      canonical(
        [
          "comparisonSchema",
          "purpose",
          "baseSha",
          "baseTreeSha",
          "planDigest",
          "recipeDigest",
          "plan",
        ].sort(),
      ) ||
    m.comparisonSchema !== COMPARISON_SCHEMA ||
    m.purpose !== BASE_PURPOSE ||
    !SHA.test(m.baseSha) ||
    !SHA.test(m.baseTreeSha) ||
    !DIGEST.test(m.planDigest) ||
    !DIGEST.test(m.recipeDigest)
  )
    throw new Error("Invalid base comparison manifest");
  const plan = validateExecutionPlan(m.plan);
  if (digest(plan) !== m.planDigest) throw new Error("Base manifest plan digest mismatch");
  return m;
}

/** Base runs live beside candidates under the same prefix, never as candidates. */
export function baseBranch(prefix: string, baseRunId: string): string {
  if (!DIGEST.test(baseRunId)) throw new Error("Invalid base run id");
  return `${prefix}base/${baseRunId}`;
}
export function classifyQueueRef(
  prefix: string,
  ref: string,
): { purpose: "candidate" | "base-comparison"; id: string } | null {
  const head = `refs/heads/${prefix}`;
  if (!ref.startsWith(head)) return null;
  const rest = ref.slice(head.length);
  if (DIGEST.test(rest)) return { purpose: "candidate", id: rest };
  if (rest.startsWith("base/") && DIGEST.test(rest.slice(5)))
    return { purpose: BASE_PURPOSE, id: rest.slice(5) };
  return null;
}

async function readCommit(git: GitStore, sha: string) {
  const lines = (await git.exec(["cat-file", "commit", assertSha(sha)])).split("\n");
  const committer = lines.find((line) => line.startsWith("committer "));
  const date = committer?.match(/ (\d+ [+-]\d{4})$/)?.[1];
  const tree = lines.find((line) => line.startsWith("tree "))?.slice(5);
  if (!date || !tree || !SHA.test(tree)) throw new Error("Unreadable commit");
  return {
    lines,
    tree,
    date,
    parents: lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
  };
}

/**
 * Deterministic base-purpose commit: base tree, sole parent the base, the
 * base's own committer date and no candidate provenance. The same
 * (baseSha, planDigest, recipeDigest) always yields the same commit SHA, so a
 * crashed writer can recover publication from the ref alone. An existing ref
 * proves publication only, never completion.
 */
export async function buildBase(
  git: GitStore,
  input: { baseSha: string; plan: ExecutionPlan; recipeDigest: string },
): Promise<BaseRun> {
  const base = await readCommit(git, input.baseSha);
  const plan = validateExecutionPlan(input.plan);
  const manifest = validateBaseManifest({
    comparisonSchema: COMPARISON_SCHEMA,
    purpose: BASE_PURPOSE,
    baseSha: input.baseSha,
    baseTreeSha: base.tree,
    planDigest: digest(plan),
    recipeDigest: input.recipeDigest,
    plan,
  });
  const baseRunId = digest(manifest);
  const trailer = `${BASE_TRAILER}${canonical(manifest)}`;
  if (Buffer.byteLength(trailer) > MAX_TRAILER_BYTES)
    throw new Error("Unsupported base comparison: frozen plan exceeds the manifest bound");
  const tipSha = await git.commit(
    base.tree,
    [input.baseSha],
    `Batch base comparison ${baseRunId}\n\n${trailer}`,
    base.date,
  );
  return { baseRunId, tipSha, manifest };
}

export async function inspectBase(git: GitStore, tipSha: string): Promise<BaseRun> {
  const tip = await readCommit(git, tipSha);
  const trailers = tip.lines.filter((line) => line.startsWith(BASE_TRAILER));
  if (
    trailers.length !== 1 ||
    Buffer.byteLength(trailers[0]!) > MAX_TRAILER_BYTES ||
    tip.lines.some((line) => line.startsWith(CANDIDATE_TRAILER))
  )
    throw new Error("Missing or ambiguous base comparison manifest");
  const manifest = validateBaseManifest(JSON.parse(trailers[0]!.slice(BASE_TRAILER.length)));
  if (tip.parents.length !== 1 || tip.parents[0] !== manifest.baseSha)
    throw new Error("Base comparison parent mismatch");
  const base = await readCommit(git, manifest.baseSha);
  if (tip.tree !== manifest.baseTreeSha || base.tree !== manifest.baseTreeSha)
    throw new Error("Base comparison tree mismatch");
  const rebuilt = await buildBase(git, {
    baseSha: manifest.baseSha,
    plan: manifest.plan,
    recipeDigest: manifest.recipeDigest,
  });
  if (rebuilt.tipSha !== tipSha) throw new Error("Noncanonical base comparison commit");
  return rebuilt;
}

/** Historical bases without this contract fail closed: no overlay, no substitute run. */
export async function baseSupport(
  git: GitStore,
  baseSha: string,
): Promise<{ supported: true } | { supported: false; reason: string }> {
  let raw: string;
  try {
    raw = await git.exec(["show", `${assertSha(baseSha)}:${COMPARISON_MARKER}`]);
  } catch (error) {
    if (error instanceof GitFailure)
      return { supported: false, reason: "unsupported-base: comparison marker absent" };
    throw error;
  }
  try {
    if ((JSON.parse(raw) as { comparisonSchema?: unknown }).comparisonSchema === COMPARISON_SCHEMA)
      return { supported: true };
  } catch {
    /* malformed marker: unsupported */
  }
  return { supported: false, reason: "unsupported-base: comparison schema differs" };
}

/** Any planned unit file absent from the exact base tree makes the base non-comparable. */
export async function absentFromBase(
  git: GitStore,
  baseSha: string,
  plan: ExecutionPlan,
): Promise<string[]> {
  const present = new Set(
    (await git.exec(["ls-tree", "-r", "-z", "--name-only", assertSha(baseSha)]))
      .split("\0")
      .filter(Boolean),
  );
  return plan.unitTests.filter((path) => !present.has(path));
}

export interface UnitEvidence {
  category: string;
  files: string[];
  status: ExecutionStatus;
  exitCode: number | null;
}
export interface StepEvidence {
  step: SourceStep;
  status: ExecutionStatus;
  exitCode: number | null;
}
/** `batch-comparison.json` in the `batch-comparison-<attempt>` artifact. */
export interface ComparisonEvidence {
  schemaVersion: 1;
  comparisonSchema: typeof COMPARISON_SCHEMA;
  purpose: "candidate" | typeof BASE_PURPOSE;
  batchId: string;
  headSha: string;
  runId: string;
  runAttempt: number;
  baseSha: string;
  planDigest: string;
  recipeDigest: string | null;
  recipePaths: [string, string | null][];
  environment: {
    source: Record<string, string | null> | null;
    unit: Record<string, string | null> | null;
  };
  coverage: {
    inventoryDigest: string;
    absent: string[];
    units: UnitEvidence[];
    sourceSteps: StepEvidence[];
    complete: boolean;
  };
  reasons: string[];
}

export const unitKey = (unit: { category: string; files: readonly string[] }): string =>
  canonical({ category: unit.category, files: [...unit.files].sort() });
export const inventoryDigest = (units: readonly { category: string; files: string[] }[]) =>
  digest(units.map(unitKey).sort());
export const recipeDigestOf = (
  paths: ComparisonEvidence["recipePaths"],
  environment: ComparisonEvidence["environment"],
): string => digest({ paths, environment });

function isEnvironment(value: unknown): value is Record<string, string | null> | null {
  return (
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as object).every((item) => item === null || typeof item === "string"))
  );
}
function statusOf(value: unknown): value is ExecutionStatus {
  return EXECUTION_STATUSES.includes(value as ExecutionStatus);
}

/**
 * Verifies a comparison document against its trusted, run-bound result header
 * and the exact identity the caller expects. Every derived field is recomputed;
 * any disagreement returns a reason and never a usable document.
 */
export function verifyEvidence(
  rawResult: unknown,
  rawEvidence: unknown,
  expected: {
    purpose: ComparisonEvidence["purpose"];
    batchId: string;
    headSha: string;
    runId: number;
    attempt: number;
    baseSha: string;
  },
): { ok: true; evidence: ComparisonEvidence } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const header = (rawResult as { comparison?: Record<string, unknown> } | null)?.comparison;
  if (!header || typeof header !== "object")
    return fail("absent comparison metadata: attribution held");
  if (header.comparisonSchema !== COMPARISON_SCHEMA) return fail("comparison schema differs");
  if (header.purpose !== expected.purpose) return fail("comparison purpose differs");
  if (header.evidenceDigest !== digest(rawEvidence ?? null))
    return fail("comparison evidence is not bound to its result");
  const e = rawEvidence as ComparisonEvidence | null;
  if (
    !e ||
    e.schemaVersion !== 1 ||
    e.comparisonSchema !== COMPARISON_SCHEMA ||
    e.purpose !== expected.purpose ||
    e.batchId !== expected.batchId ||
    e.headSha !== expected.headSha ||
    e.runId !== String(expected.runId) ||
    e.runAttempt !== expected.attempt ||
    e.baseSha !== expected.baseSha
  )
    return fail("comparison identity differs from the exact run");
  if (
    !DIGEST.test(e.planDigest) ||
    !(e.recipeDigest === null || DIGEST.test(e.recipeDigest)) ||
    !Array.isArray(e.recipePaths) ||
    e.recipePaths.some(
      (item) =>
        !Array.isArray(item) ||
        item.length !== 2 ||
        typeof item[0] !== "string" ||
        !(item[1] === null || SHA.test(item[1])),
    ) ||
    !e.environment ||
    !isEnvironment(e.environment.source) ||
    !isEnvironment(e.environment.unit) ||
    !e.coverage ||
    !Array.isArray(e.coverage.units) ||
    !Array.isArray(e.coverage.sourceSteps) ||
    !Array.isArray(e.coverage.absent) ||
    typeof e.coverage.complete !== "boolean" ||
    !Array.isArray(e.reasons) ||
    e.reasons.some((reason) => typeof reason !== "string")
  )
    return fail("malformed comparison evidence");
  for (const unit of e.coverage.units)
    if (
      !unit ||
      typeof unit.category !== "string" ||
      !Array.isArray(unit.files) ||
      !unit.files.length ||
      unit.files.some((file) => typeof file !== "string") ||
      !statusOf(unit.status) ||
      !(unit.exitCode === null || Number.isSafeInteger(unit.exitCode))
    )
      return fail("malformed unit evidence");
  const keys = e.coverage.units.map(unitKey);
  if (new Set(keys).size !== keys.length) return fail("duplicate unit identity");
  const steps = e.coverage.sourceSteps;
  if (
    steps.length !== SOURCE_STEPS.length ||
    steps.some((step, i) => !step || step.step !== SOURCE_STEPS[i] || !statusOf(step.status))
  )
    return fail("malformed source step evidence");
  if (inventoryDigest(e.coverage.units) !== e.coverage.inventoryDigest)
    return fail("inventory digest mismatch");
  const recipe =
    e.environment.source && (e.environment.unit || e.coverage.units.length === 0)
      ? recipeDigestOf(e.recipePaths, e.environment)
      : null;
  if (recipe !== e.recipeDigest) return fail("recipe digest mismatch");
  const complete =
    e.reasons.length === 0 &&
    e.recipeDigest !== null &&
    e.coverage.absent.length === 0 &&
    e.coverage.units.every((unit) => unit.status === "pass" || unit.status === "fail") &&
    steps.every((step) => step.status === "pass" || step.status === "fail");
  if (complete !== e.coverage.complete) return fail("coverage completeness claim mismatch");
  return { ok: true, evidence: e };
}

/** The exact provider run of a published base ref, bound before its evidence is used. */
export function verifyBaseRun(input: {
  prefix: string;
  workflow: string;
  base: BaseRun;
  run: Pick<Run, "id" | "attempt" | "headSha" | "branch" | "workflow" | "status">;
  /** Latest provider attempt for this run id; an older attempt is stale. */
  latestAttempt: number;
  /** Raw `batch-result.json` and `batch-comparison.json` of exactly this run attempt. */
  result: unknown;
  evidence: unknown;
}):
  | { ok: true; outcome: "success" | "code_failure"; evidence: ComparisonEvidence }
  | { ok: false; reason: string } {
  const { base, run } = input;
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (input.workflow !== BATCH_WORKFLOW || run.workflow !== BATCH_WORKFLOW)
    return fail("base run is not the batch workflow");
  if (run.branch !== baseBranch(input.prefix, base.baseRunId) || run.headSha !== base.tipSha)
    return fail("base run is not bound to the exact base ref and tip");
  if (run.attempt !== input.latestAttempt) return fail("stale base run attempt");
  if (run.status !== "completed") return fail("base run has not completed");
  const verified: VerifiedResult | null = verifyRunResult(
    input.result,
    { batchId: base.baseRunId, tipSha: base.tipSha },
    run.id,
    run.attempt,
    BASE_PURPOSE,
  );
  if (!verified) return fail("base result is not verifiable for this exact run");
  if (verified.outcome !== "success" && verified.outcome !== "code_failure")
    return fail(`base run ended ${verified.outcome}; not comparable`);
  const checked = verifyEvidence(input.result, input.evidence, {
    purpose: BASE_PURPOSE,
    batchId: base.baseRunId,
    headSha: base.tipSha,
    runId: run.id,
    attempt: run.attempt,
    baseSha: base.manifest.baseSha,
  });
  if (!checked.ok) return checked;
  const evidence = checked.evidence;
  if (evidence.planDigest !== base.manifest.planDigest) return fail("base plan digest differs");
  if (evidence.recipeDigest !== base.manifest.recipeDigest)
    return fail("base recipe differs from the frozen recipe");
  if (!evidence.coverage.complete) return fail("base coverage incomplete");
  return { ok: true, outcome: verified.outcome, evidence };
}

export type ComparisonVerdict =
  | {
      verdict: "new-failure-demonstrated";
      units: { category: string; files: string[] }[];
      steps: SourceStep[];
    }
  | { verdict: "no-demonstrated-new-failure" }
  | { verdict: "not-comparable"; reason: string };

/**
 * A candidate failure is demonstrated new only when the complete comparable
 * base passed the identical execution unit under the identical recipe. An
 * empty difference never proves inheritance: it holds. A difference is not
 * causation either; the consumer's policy owns split, eject or reconfirmation.
 */
export function compareFailures(
  candidate: { outcome: VerifiedResult["outcome"]; evidence: ComparisonEvidence },
  base: { evidence: ComparisonEvidence },
): ComparisonVerdict {
  const c = candidate.evidence,
    b = base.evidence;
  const hold = (reason: string) => ({ verdict: "not-comparable" as const, reason });
  if (candidate.outcome !== "code_failure") return hold("candidate has no verified code failure");
  if (c.purpose !== "candidate" || b.purpose !== BASE_PURPOSE) return hold("purpose mismatch");
  if (c.comparisonSchema !== COMPARISON_SCHEMA || b.comparisonSchema !== COMPARISON_SCHEMA)
    return hold("comparison schema mismatch");
  if (c.baseSha !== b.baseSha) return hold("base evidence is for a different base");
  if (c.planDigest !== b.planDigest) return hold("frozen plan differs");
  if (c.recipeDigest === null || c.recipeDigest !== b.recipeDigest)
    return hold("execution recipe or environment differs");
  if (c.reasons.length) return hold(`candidate evidence inconsistent: ${c.reasons.join("; ")}`);
  if (!b.coverage.complete || b.reasons.length) return hold("base coverage incomplete");
  const baseUnits = new Map(b.coverage.units.map((unit) => [unitKey(unit), unit.status]));
  const units = c.coverage.units
    .filter((unit) => unit.status === "fail" && baseUnits.get(unitKey(unit)) === "pass")
    .map((unit) => ({ category: unit.category, files: [...unit.files] }));
  const steps = c.coverage.sourceSteps
    .filter(
      (step) =>
        step.status === "fail" &&
        b.coverage.sourceSteps.find((item) => item.step === step.step)?.status === "pass",
    )
    .map((step) => step.step);
  return units.length || steps.length
    ? { verdict: "new-failure-demonstrated", units, steps }
    : { verdict: "no-demonstrated-new-failure" };
}
