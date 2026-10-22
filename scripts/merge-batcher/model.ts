import { createHash } from "node:crypto";

export const SHA = /^[a-f0-9]{40}$/;
export const ID = /^[a-f0-9]{64}$/;
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function assertSha(value: string): string {
  if (!SHA.test(value)) throw new Error("Expected a full lowercase Git SHA");
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Non-JSON manifest value");
  return result;
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export interface ReadyBinding {
  eventId: string;
  at: string;
  source: "auto-merge" | "queue-ready";
  evidenceId: string;
  evidenceDigest: string;
}
export interface Pull {
  number: number;
  headSha: string;
  headRef: string;
  binding: ReadyBinding;
  controlPlane?: boolean;
}
export interface BatchSpec {
  schemaVersion: 1;
  baseSha: string;
  predecessor: string | null;
  createdAt: string;
  recoveryOf: string | null;
  pulls: Pull[];
}
export interface Manifest extends Omit<BatchSpec, "pulls"> {
  batchId: string;
  tipSha: string;
  pulls: (Pull & { mergeSha: string })[];
}
export type Outcome = "success" | "code_failure" | "infrastructure" | "cancelled" | "unknown";
export interface Run {
  id: number;
  attempt: number;
  headSha: string;
  branch: string;
  workflow: string;
  status: "queued" | "in_progress" | "completed";
  outcome: Outcome;
  completedAt: string | null;
  trusted: boolean;
  retryable: boolean;
  startedAt?: string | null;
}
export interface Candidate {
  manifest: Manifest;
  branch: string;
  runs: Run[];
  containedInBase: boolean;
}
export interface Ejection {
  pull: Pull;
  reason: string;
  batchId: string;
  announced: boolean;
  effectId?: string;
}
export interface RetryIntent {
  runId: number;
  fromAttempt: number;
  requestedAt: string;
}
export interface StageSample {
  batchId: string;
  readyAt: string;
  readyBindings: { key: string; number: number; headSha: string; readyAt: string }[];
  builtAt: string | null;
  publishedAt: string | null;
  ciStartedAt: string | null;
  ciCompletedAt: string | null;
  landedAt: string | null;
  observedAt: string;
}
export interface MissingRun {
  firstSeenAt: string;
  status: "holding" | "abandoned" | "released";
  updatedAt: string;
  kind?: "workflow-admission" | "historical-run-history";
  recovery?: {
    confirmedNoRun: true;
    at: string;
    controllerId: string | null;
    tipSha: string;
    previousStateSha: string | null;
  };
}
export interface Ledger {
  schemaVersion: 1;
  epoch: number;
  owner: string;
  expiresAt: string;
  landed: string[];
  invalidated: string[];
  ejected: Ejection[];
  recovery: { batchId: string; pulls: Pull[] }[];
  retries: Record<string, RetryIntent>;
  codeFailures: Record<string, string[]>;
  effects: Record<string, DurableEffect>;
  landings: Record<string, LandedPull>;
  stages: Record<string, StageSample>;
  missingRuns: Record<string, MissingRun>;
}
export interface EffectState {
  id: string;
  status: "pending" | "submitting" | "uncertain" | "done" | "blocked";
  attempts: number;
  checks: number;
  nextAt: string;
  lastError: string | null;
}
export interface FollowupRequest {
  original: number;
  sourceRepository: string;
  sourceRef: string;
  headSha: string;
  landedHeadSha: string;
  landedMergeSha: string;
  landedTipSha: string;
  marker: string;
  title: string;
  body: string;
}
export interface FollowupPull {
  number: number;
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
}
export type DurableEffect = EffectState &
  (
    | { kind: "rerun"; run: Run }
    | { kind: "comment"; number: number; body: string; marker: string }
    | { kind: "followup"; request: FollowupRequest }
  );
export interface LandedPull {
  batchId: string;
  tipSha: string;
  mergeSha: string;
  pull: Pull;
  currentHeadSha: string | null;
  status:
    | "pending"
    | "unchanged"
    | "requeued"
    | "awaiting-evidence"
    | "already-contained"
    | "closed-newer-head"
    | "followup-pending"
    | "followup-open"
    | "followup-blocked"
    | "history-diverged"
    | "provider-unavailable";
  nextCheckAt: string;
  checkedAt: string | null;
  note: string | null;
  followupNumber?: number;
}
export interface Headroom {
  allowed: boolean;
  reason: string;
  budget: number | null;
  occupied: number;
  reservedMain: number;
  candidateSlots: 18;
  /** Active runs whose latest jobs were read in this observation. */
  scannedRuns?: number;
  /** Scanned runs proven to be waiting only for approval (no runner demand). */
  approvalOnlyRuns?: number;
}
// GitHub job statuses. Only jobs that hold or are about to request a hosted
// runner are demand: queued and in_progress jobs, plus requested jobs (created
// but not yet queued), which are counted conservatively. Jobs waiting for environment
// approval (waiting) or a job concurrency group (pending) and completed jobs
// hold no runner, and a run without materialized jobs (for example a run held
// by its concurrency group) is only a placeholder. Any other or missing status
// returns null so callers hold instead of treating unknown demand as free.
const RUNNER_DEMAND_JOB_STATUSES = new Set(["queued", "in_progress", "requested"]);
const IDLE_JOB_STATUSES = new Set(["waiting", "pending", "completed"]);
export function runnerJobDemand(jobs: readonly unknown[]): number | null {
  let demand = 0;
  for (const job of jobs) {
    const status =
      job !== null && typeof job === "object" ? (job as { status?: unknown }).status : undefined;
    if (typeof status !== "string") return null;
    if (RUNNER_DEMAND_JOB_STATUSES.has(status)) demand++;
    else if (!IDLE_JOB_STATUSES.has(status)) return null;
  }
  return demand;
}

// Run-level statuses scanned for runner demand, one bounded page each, in
// lifecycle order: a run that advances between page reads (for example an
// approved `waiting` run becoming `queued`) is listed by the later page
// instead of slipping between them, and its later listing wins.
export const ACTIVE_RUN_STATUSES = [
  "requested",
  "pending",
  "waiting",
  "queued",
  "in_progress",
] as const;
/** Runs that hold or may imminently request runners; above this the scan holds. */
export const MAX_RUNNER_RELEVANT_RUNS = 32;
/**
 * Absolute per-observation job-scan bound, independent of the runner-relevant
 * cap: at most this many distinct active runs have their jobs read, so a
 * backlog of approval-waiting runs cannot turn one observation into an
 * unbounded scan. Worst case is 5 run-list requests plus this many job
 * requests per observation. Larger backlogs hold.
 */
export const MAX_SCANNED_ACTIVE_RUNS = 64;
/** Wall-clock bound for one scan; exceeding it holds instead of admitting. */
export const ACTIVE_RUN_SCAN_DEADLINE_MS = 120_000;

/**
 * A run is approval-only when GitHub reports the run itself as `waiting` and
 * its complete latest-job page proves it: at least one job is `waiting` (the
 * environment approval gate) and every job is a known idle status (`waiting`,
 * `pending` or `completed`). Any `queued`, `in_progress` or `requested` job,
 * an empty job list, or another run status is not proof. Unknown statuses are
 * rejected earlier by `runnerJobDemand`.
 */
export function approvalOnlyRun(run: unknown, jobs: readonly unknown[]): boolean {
  if (run === null || typeof run !== "object" || (run as { status?: unknown }).status !== "waiting")
    return false;
  let waiting = false;
  for (const job of jobs) {
    const status =
      job !== null && typeof job === "object" ? (job as { status?: unknown }).status : undefined;
    if (status === "waiting") waiting = true;
    else if (status !== "pending" && status !== "completed") return false;
  }
  return waiting;
}

export type RunnerScanHold =
  | "incomplete-runs"
  | "invalid-run"
  | "batch-slot"
  | "scan-bound"
  | "runner-run-bound"
  | "incomplete-jobs"
  | "unknown-job-status"
  | "deadline";
export type RunnerScan =
  | {
      ok: true;
      mainDemand: number;
      otherDemand: number;
      scannedRuns: number;
      approvalOnlyRuns: number;
      runnerRelevantRuns: number;
    }
  | { ok: false; hold: RunnerScanHold; scannedRuns: number; approvalOnlyRuns: number };

/**
 * Shared bounded runner-demand scan for the batcher and traffic-shadow
 * readers. It keeps the complete run inventory (every status page must be a
 * complete single page) and reads the complete latest-job page of every
 * active run up to `MAX_SCANNED_ACTIVE_RUNS`. Only runs proven
 * approval-only are excluded from `MAX_RUNNER_RELEVANT_RUNS`; their demand is
 * still computed from their jobs (and is zero by construction). Mixed,
 * job-less, queued or otherwise unproven runs count toward the cap. Incomplete
 * pages, unknown statuses, a second Batch CI run, the scan bound and the
 * deadline hold. Provider errors propagate to the caller, which holds.
 * Approval can still be granted after observation; callers re-read before
 * publication, as with every other observed status.
 */
export async function scanRunnerDemand(input: {
  get: (path: string) => Promise<unknown>;
  batchWorkflow: string;
  baseBranch: string;
  /** Run ID validator; return null to hold, or throw. Defaults to positive safe integers. */
  runId?: (value: unknown) => number | null;
  now?: () => number;
  maxScannedRuns?: number;
  maxRunnerRelevantRuns?: number;
  deadlineMs?: number;
}): Promise<RunnerScan> {
  const now = input.now ?? Date.now;
  const started = now();
  const maxScanned = input.maxScannedRuns ?? MAX_SCANNED_ACTIVE_RUNS;
  const maxRelevant = input.maxRunnerRelevantRuns ?? MAX_RUNNER_RELEVANT_RUNS;
  const deadline = input.deadlineMs ?? ACTIVE_RUN_SCAN_DEADLINE_MS;
  const runId =
    input.runId ??
    ((value: unknown) =>
      Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);
  let scannedRuns = 0,
    approvalOnlyRuns = 0;
  const hold = (reason: RunnerScanHold): RunnerScan => ({
    ok: false,
    hold: reason,
    scannedRuns,
    approvalOnlyRuns,
  });
  const runs = new Map<number, Record<string, unknown>>();
  for (const status of ACTIVE_RUN_STATUSES) {
    if (now() - started > deadline) return hold("deadline");
    const page = (await input.get(`actions/runs?status=${status}&per_page=100&page=1`)) as {
      workflow_runs?: unknown;
      total_count?: unknown;
    } | null;
    if (
      page === null ||
      typeof page !== "object" ||
      Array.isArray(page) ||
      !Array.isArray(page.workflow_runs) ||
      !Number.isSafeInteger(page.total_count) ||
      (page.total_count as number) > 100 ||
      page.workflow_runs.length !== page.total_count
    )
      return hold("incomplete-runs");
    for (const run of page.workflow_runs as unknown[]) {
      if (run === null || typeof run !== "object") return hold("invalid-run");
      const id = runId((run as { id?: unknown }).id);
      if (id === null) return hold("invalid-run");
      const record = run as Record<string, unknown>;
      // A run that completed between list pages holds no runner.
      if (record.status !== "completed") runs.set(id, record);
    }
  }
  if ([...runs.values()].some((run) => run.path === input.batchWorkflow)) return hold("batch-slot");
  if (runs.size > maxScanned) return hold("scan-bound");
  let mainDemand = 0,
    otherDemand = 0,
    runnerRelevantRuns = 0;
  for (const [id, run] of runs) {
    if (now() - started > deadline) return hold("deadline");
    const page = (await input.get(`actions/runs/${id}/jobs?filter=latest&per_page=100&page=1`)) as {
      jobs?: unknown;
      total_count?: unknown;
    } | null;
    if (
      page === null ||
      typeof page !== "object" ||
      Array.isArray(page) ||
      !Array.isArray(page.jobs) ||
      !Number.isSafeInteger(page.total_count) ||
      (page.total_count as number) > 100 ||
      page.jobs.length !== page.total_count
    )
      return hold("incomplete-jobs");
    scannedRuns++;
    const jobs = page.jobs as unknown[];
    const demand = runnerJobDemand(jobs);
    if (demand === null) return hold("unknown-job-status");
    if (approvalOnlyRun(run, jobs)) approvalOnlyRuns++;
    else if (++runnerRelevantRuns > maxRelevant) return hold("runner-run-bound");
    const isMain =
      run.path === ".github/workflows/ci.yml" &&
      run.head_branch === input.baseBranch &&
      run.event === "push";
    if (isMain) mainDemand += demand;
    else otherDemand += demand;
  }
  return { ok: true, mainDemand, otherDemand, scannedRuns, approvalOnlyRuns, runnerRelevantRuns };
}
export const emptyLedger = (): Ledger => ({
  schemaVersion: 1,
  epoch: 0,
  owner: "",
  expiresAt: new Date(0).toISOString(),
  landed: [],
  invalidated: [],
  ejected: [],
  recovery: [],
  retries: {},
  codeFailures: {},
  effects: {},
  landings: {},
  stages: {},
  missingRuns: {},
});
export interface Observation {
  now: string;
  baseSha: string;
  ready: Pull[];
  excluded: { number: number; reason: string }[];
  candidates: Candidate[];
  stateSha: string | null;
  ledger: Ledger;
  mainBusy?: boolean;
  headroom?: Headroom | null;
  observationWarnings?: string[];
  telemetry?: {
    status: "unknown" | "within-threshold" | "stop";
    p95ReadyToCiSeconds: number | null;
    samples: number;
    coverageSince: string;
    completeWindow: boolean;
  };
  missingRuns?: Record<string, MissingRun>;
}
export interface Config {
  repository: string;
  baseBranch: string;
  branchPrefix: string;
  stateRef: string;
  workflow: string;
  mode: "shadow" | "shadow-ci" | "active";
  maxBatchSize: number;
  maxInflight: number;
  speculationDepth: number;
  pollSeconds: number;
  leaseSeconds: number;
  gitDir: string;
  outputDir: string;
  port: number;
  fetchTimeoutSeconds: number;
  missingRunSeconds: number;
  runnerBudget: number | null;
  mainReserve: number | null;
}
export function config(env: Record<string, string | undefined>): Config {
  const integer = (key: string, fallback: number, max: number): number => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const mode = env.BATCHER_MODE ?? "shadow";
  if (mode !== "shadow" && mode !== "shadow-ci" && mode !== "active")
    throw new Error("Invalid BATCHER_MODE");
  const repository = env.BATCHER_REPOSITORY ?? "Cloudgeni-ai/opengeni";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const baseBranch = env.BATCHER_BASE_BRANCH ?? "main";
  const branchPrefix = env.BATCHER_BRANCH_PREFIX ?? (mode === "active" ? "queue/live/" : "queue/");
  for (const ref of [baseBranch, `${branchPrefix}test`]) {
    if (!/^[\w/-]+$/.test(ref) || ref.includes("//") || ref.startsWith("-") || ref.endsWith("/"))
      throw new Error("Invalid branch configuration");
  }
  if (!branchPrefix.endsWith("/") || baseBranch.startsWith(branchPrefix))
    throw new Error("Queue namespace must be separate from base");
  const stateRef =
    mode === "shadow-ci" ? env.BATCHER_SHADOW_CI_STATE_REF : "refs/heads/batcher-state";
  if (
    !stateRef ||
    (mode === "shadow-ci" && stateRef !== "refs/heads/batcher-shadow-ci-state") ||
    !/^refs\/heads\/[\w/-]+$/.test(stateRef) ||
    stateRef === `refs/heads/${baseBranch}` ||
    stateRef.startsWith(`refs/heads/${branchPrefix}`)
  )
    throw new Error(
      "Shadow-ci requires explicit BATCHER_SHADOW_CI_STATE_REF outside main and queue (otherwise its lease would trigger CI)",
    );
  return {
    repository,
    baseBranch,
    branchPrefix,
    mode,
    stateRef,
    workflow: ".github/workflows/batch-ci.yml",
    maxBatchSize: integer("BATCHER_MAX_BATCH_SIZE", 16, 256),
    maxInflight: integer("BATCHER_MAX_INFLIGHT", 1, 16),
    speculationDepth: integer("BATCHER_SPECULATION_DEPTH", 2, 16),
    pollSeconds: integer("BATCHER_POLL_SECONDS", mode === "active" ? 30 : 120, 3600),
    leaseSeconds: integer("BATCHER_LEASE_SECONDS", 120, 3600),
    gitDir: env.BATCHER_GIT_DIR ?? "/data/objects.git",
    outputDir: env.BATCHER_OUTPUT_DIR ?? "/data/shadow",
    port: integer("PORT", 8080, 65535),
    fetchTimeoutSeconds: integer("BATCHER_FETCH_TIMEOUT_SECONDS", 600, 3600),
    missingRunSeconds: integer("BATCHER_MISSING_RUN_SECONDS", 900, 86400),
    runnerBudget: env.BATCHER_RUNNER_BUDGET ? integer("BATCHER_RUNNER_BUDGET", 0, 100000) : null,
    mainReserve: env.BATCHER_MAIN_RESERVE ? integer("BATCHER_MAIN_RESERVE", 0, 100000) : null,
  };
}
export const bindingKey = (pull: Pull): string =>
  digest({
    number: pull.number,
    headSha: pull.headSha,
    binding: pull.binding,
    controlPlane: pull.controlPlane ?? false,
  });
export const ejectionKey = (pull: Pull): string =>
  digest({
    number: pull.number,
    headSha: pull.headSha,
    eventId: pull.binding.eventId,
    source: pull.binding.source,
  });
export function validateSpec(value: unknown): BatchSpec {
  const spec = value as BatchSpec;
  if (
    !spec ||
    spec.schemaVersion !== 1 ||
    !SHA.test(spec.baseSha) ||
    !Array.isArray(spec.pulls) ||
    !spec.pulls.length ||
    spec.pulls.length > 256 ||
    !Number.isFinite(Date.parse(spec.createdAt))
  )
    throw new Error("Invalid batch manifest");
  if (spec.predecessor !== null && !ID.test(spec.predecessor))
    throw new Error("Invalid predecessor");
  if (spec.recoveryOf !== null && !ID.test(spec.recoveryOf))
    throw new Error("Invalid recovery parent");
  const seen = new Set<number>();
  for (const p of spec.pulls) {
    if (
      !p ||
      !Number.isSafeInteger(p.number) ||
      p.number < 1 ||
      seen.has(p.number) ||
      !SHA.test(p.headSha) ||
      typeof p.headRef !== "string" ||
      !p.binding ||
      typeof p.binding.eventId !== "string" ||
      !p.binding.eventId ||
      !Number.isFinite(Date.parse(p.binding.at)) ||
      !["auto-merge", "queue-ready"].includes(p.binding.source) ||
      typeof p.binding.evidenceId !== "string" ||
      !ID.test(p.binding.evidenceDigest)
    )
      throw new Error("Invalid batch member");
    seen.add(p.number);
  }
  if (
    spec.pulls.length > 1 &&
    spec.pulls.some((p) => p.headRef === "changeset-release/main" || p.controlPlane)
  )
    throw new Error("Version must be singleton");
  return spec;
}
