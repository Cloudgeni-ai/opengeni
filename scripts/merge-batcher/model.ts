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
export type InfrastructureRetryReason =
  | "failed-batch"
  | "verified-infrastructure"
  | "provider-cancelled"
  | "no-job-logs";
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
  infrastructureRetryReason?: InfrastructureRetryReason;
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
  reason?: InfrastructureRetryReason;
}
export interface ParkedPull {
  pull: Pull;
  baseSha: string;
  batchId: string;
  cohortId: string;
  runId: number;
  attempt: number;
  parkedAt: string;
  announced: boolean;
  effectId?: string;
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
  retry?: RetryIntent;
  /** Consecutive complete controller observations of a main-capacity hold. */
  mainCapacityWaits?: { key: string; from: string; to: string; mainRunId: number }[];
  operatorOffWaits?: { key: string; from: string; to: string; evidenceDigest: string }[];
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
  initialization?: {
    schemaVersion: 1;
    operationId: string;
    serviceUid: string;
    serviceGeneration: string;
    initializedAt: string;
  };
  baseHold?: BaseCiEvidence;
  schemaVersion: 1;
  epoch: number;
  owner: string;
  expiresAt: string;
  landed: string[];
  invalidated: string[];
  ejected: Ejection[];
  parked?: ParkedPull[];
  onNotices?: Record<string, { at: string; recipients: number[] }>;
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
  /** Present only after a complete provider demand scan. */
  mainDemand?: number;
  reservedMain: number;
  candidateSlots: 18;
  /** Active runs whose latest jobs were read in this observation. */
  scannedRuns?: number;
  /** Scanned runs proven to be waiting only for approval (no runner demand). */
  approvalOnlyRuns?: number;
  /** Provider capacity fields; see `capacityDecision`. */
  capacity?: CapacityObservation;
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

// Run-level statuses scanned for runner demand, one bounded page each. No
// single-pass page order observes every status change made between page reads
// (a run can move backwards, for example `in_progress` to `waiting` while its
// other jobs still run), so the scan lists every status twice; see
// RUN_LIST_PASSES.
export const ACTIVE_RUN_STATUSES = [
  "requested",
  "pending",
  "waiting",
  "queued",
  "in_progress",
] as const;
/**
 * Complete status listings per observation. With two passes, a run whose status
 * changes once while the inventory is listed is still listed: the second read
 * of its new status follows the first read of its old one. More changes within
 * one listing, or provider snapshot lag, are not excluded; demand and the
 * approval-only proof come from each run's job page, read after the listing,
 * and callers re-read before publication.
 */
export const RUN_LIST_PASSES = 2;
/** Runs that hold or may imminently request runners; above this the scan holds. */
export const MAX_RUNNER_RELEVANT_RUNS = 32;
/**
 * Absolute per-observation job-scan bound, independent of the runner-relevant
 * cap: at most this many distinct active runs have their jobs read, so a
 * backlog of approval-waiting runs cannot turn one observation into an
 * unbounded scan. Worst case is 10 run-list requests (5 statuses, 2 passes)
 * plus this many job requests, 74 in total, per observation. Larger backlogs
 * hold.
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
      /** Newest active full-main push CI run (highest run ID), or null when none is active. */
      latestMain: LatestMainObservation | null;
      /** Jobs `queued` or `requested` for a runner across every active full-main run. */
      mainQueuedJobs: number;
      /**
       * Active full-main runs, not proven approval-only, whose complete job page
       * has at most `MAIN_PRE_FANOUT_JOBS` jobs: their fan-out is not yet
       * instantiated (a just-pushed job-less run, a concurrency-held run, or the
       * planning phase), so their current demand understates what they will request.
       */
      preFanoutMainRuns: number[];
    }
  | { ok: false; hold: RunnerScanHold; scannedRuns: number; approvalOnlyRuns: number };
/**
 * Jobs `.github/workflows/ci.yml` instantiates before `plan` completes:
 * automation-admission, merge-content and plan. Every other job needs plan,
 * directly or transitively, and is created together with the fan-out (measured:
 * 3 early jobs, then about 55 more 77-92 seconds later). A job page listing
 * more jobs (any status, `filter=latest`) proves the fan-out exists; a drained
 * tail still lists its completed jobs. capacity.test.ts checks this constant
 * against the workflow file.
 */
export const MAIN_PRE_FANOUT_JOBS = 3;
/**
 * Runner waits observed on the newest active full-main landing run. Queue
 * times are measured from each job's `created_at`: `oldestQueuedSeconds` is the
 * age of the oldest job still `queued` or `requested`, and `maxStartWaitSeconds`
 * the largest `started_at - created_at` among started jobs. Unparseable
 * timestamps yield null measurements; they never create capacity.
 */
export interface LatestMainObservation {
  runId: number;
  queuedJobs: number;
  oldestQueuedSeconds: number | null;
  maxStartWaitSeconds: number | null;
}

/**
 * Shared bounded runner-demand scan for the batcher and traffic-shadow
 * readers. It keeps the complete run inventory (every status page must be a
 * complete single page, and every status is listed `RUN_LIST_PASSES` times)
 * and reads the complete latest-job page of every
 * active run up to `MAX_SCANNED_ACTIVE_RUNS`. Only runs proven
 * approval-only are excluded from `MAX_RUNNER_RELEVANT_RUNS`; their demand is
 * still computed from their jobs (and is zero by construction). Mixed,
 * job-less, queued, otherwise unproven runs, and runs listed with any
 * non-waiting status during the listing count toward the cap. Incomplete
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
  // Runs listed with a non-waiting status in any listing of this observation;
  // they cannot be approval-only even if their latest listing is waiting.
  const listedNotWaiting = new Set<number>();
  const listings = Array.from({ length: RUN_LIST_PASSES }, () => ACTIVE_RUN_STATUSES).flat();
  for (const status of listings) {
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
      // A run listed as completed holds no runner and is not added; an earlier
      // active listing of the same run is kept (conservative).
      if (record.status === "completed") continue;
      if (record.status !== "waiting") listedNotWaiting.add(id);
      // The latest active listing wins for the run record.
      runs.set(id, record);
    }
  }
  if ([...runs.values()].some((run) => run.path === input.batchWorkflow)) return hold("batch-slot");
  if (runs.size > maxScanned) return hold("scan-bound");
  let mainDemand = 0,
    otherDemand = 0,
    runnerRelevantRuns = 0,
    mainQueuedJobs = 0;
  const preFanoutMainRuns: number[] = [];
  let latestMain: { id: number; jobs: unknown[] } | null = null;
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
    const approvalOnly = !listedNotWaiting.has(id) && approvalOnlyRun(run, jobs);
    if (approvalOnly) approvalOnlyRuns++;
    else if (++runnerRelevantRuns > maxRelevant) return hold("runner-run-bound");
    const isMain =
      run.path === ".github/workflows/ci.yml" &&
      run.head_branch === input.baseBranch &&
      run.event === "push";
    if (isMain) {
      mainDemand += demand;
      mainQueuedJobs += jobs.filter((job) =>
        RUNNER_WAIT_JOB_STATUSES.has(String((job as { status?: unknown }).status)),
      ).length;
      // A proven approval-only run (for example an old rerun awaiting
      // environment approval) is idle and does not freeze admission; it can
      // only start after approval, which a later observation sees.
      if (!approvalOnly && jobs.length <= MAIN_PRE_FANOUT_JOBS) preFanoutMainRuns.push(id);
      // GitHub run IDs increase with creation; a rerun keeps its original ID,
      // so the highest active ID is the newest landing's run.
      if (!latestMain || id > latestMain.id) latestMain = { id, jobs };
    } else otherDemand += demand;
  }
  // The final response can itself arrive after the deadline.
  const finished = now();
  if (finished - started > deadline) return hold("deadline");
  return {
    ok: true,
    mainDemand,
    otherDemand,
    scannedRuns,
    approvalOnlyRuns,
    runnerRelevantRuns,
    latestMain: latestMain ? observeMainQueue(latestMain.id, latestMain.jobs, finished) : null,
    mainQueuedJobs,
    preFanoutMainRuns: preFanoutMainRuns.sort((a, b) => a - b),
  };
}
const RUNNER_WAIT_JOB_STATUSES = new Set(["queued", "requested"]);
export function observeMainQueue(
  runId: number,
  jobs: readonly unknown[],
  at: number,
): LatestMainObservation {
  let queuedJobs = 0;
  let oldest: number | null = null;
  let maxStart: number | null = null;
  let unmeasured = false;
  for (const job of jobs) {
    const j = (job ?? {}) as { status?: unknown; created_at?: unknown; started_at?: unknown };
    const created = typeof j.created_at === "string" ? Date.parse(j.created_at) : NaN;
    if (typeof j.status === "string" && RUNNER_WAIT_JOB_STATUSES.has(j.status)) {
      queuedJobs++;
      if (!Number.isFinite(created)) unmeasured = true;
      else oldest = Math.max(oldest ?? 0, Math.max(0, Math.round((at - created) / 1000)));
    } else if (typeof j.started_at === "string" && Number.isFinite(created)) {
      const start = Date.parse(j.started_at);
      if (Number.isFinite(start) && start >= created)
        maxStart = Math.max(maxStart ?? 0, Math.round((start - created) / 1000));
    }
  }
  return {
    runId,
    queuedJobs,
    // A queued job without a parseable creation time has an unknown age.
    oldestQueuedSeconds: unmeasured ? null : oldest,
    maxStartWaitSeconds: maxStart,
  };
}

/**
 * GitHub's documented concurrent-job default for the Team plan. The org has no
 * self-hosted or larger runners, so every repository in the organization draws
 * from this one hosted pool; it is not a reserved allocation for this repository.
 */
export const DEFAULT_PROVIDER_JOB_LIMIT = 60;
/**
 * Fixed allowance for runner-holding jobs in other organization repositories.
 * The batcher's App is installed only on this repository, so it cannot read
 * other repositories' jobs; it must assume them. Measured October 22, 2026
 * 02:00-08:40 UTC across every repository pushed since October 21 (10-second
 * samples): other-repository runner-holding jobs were p50 1, p95 10, p99 18 and
 * at most 28 (cua 21 + cloudgeni 7 at 06:35:30). The allowance is that
 * maximum. It is a measured assumption from one window, not an observation.
 */
export const DEFAULT_OTHER_REPOSITORY_ALLOWANCE = 28;
/** Peak hosted jobs one Batch CI candidate can request (16 unit shards + source, rounded up). */
export const CANDIDATE_SLOTS = 18;
export type CapacityHold =
  | "main-pre-fanout"
  | "main-queued"
  | "repository-budget"
  | "provider-limit"
  | "invalid-capacity";
export interface CapacityObservation {
  providerJobLimit: number | null;
  otherRepositoryAllowance: number | null;
  /** Observed repository jobs + other-repository allowance + candidate slots. */
  providerRequired: number | null;
  latestMain: LatestMainObservation | null;
  mainQueuedJobs: number;
  preFanoutMainRuns: number[];
  hold: CapacityHold | null;
}
/**
 * Admission over a complete scan. All of the following must hold:
 *
 * 1. No active full-main run is before its fan-out (see `MAIN_PRE_FANOUT_JOBS`);
 *    its imminent fan-out (up to 46 runner-holding jobs measured) would not fit
 *    beside a candidate.
 * 2. No active full-main run has a job waiting for a runner (`queued` or
 *    `requested`). Main CI is never gated, cancelled or skipped; only new
 *    candidates wait while main is short of runners.
 * 3. The existing repository allocation: other + max(main reserve, main) +
 *    18 <= runner budget (52/30/18 in the qualified configuration).
 * 4. The provider pool: main + other + other-repository allowance + 18 <=
 *    provider job limit (with defaults, observed repository demand <= 14).
 *
 * Invalid limits fail closed first. Approval-only runs contribute no demand
 * and never count as pre-fan-out.
 */
export function capacityDecision(input: {
  mainDemand: number;
  otherDemand: number;
  latestMain: LatestMainObservation | null;
  mainQueuedJobs: number;
  preFanoutMainRuns: readonly number[];
  runnerBudget: number;
  mainReserve: number;
  providerJobLimit: number;
  otherRepositoryAllowance: number;
}): { allowed: boolean; reservedMain: number; capacity: CapacityObservation } {
  const reservedMain = Math.max(input.mainReserve, input.mainDemand);
  const validLimit = Number.isSafeInteger(input.providerJobLimit) && input.providerJobLimit >= 1;
  const validAllowance =
    Number.isSafeInteger(input.otherRepositoryAllowance) &&
    input.otherRepositoryAllowance >= 0 &&
    validLimit &&
    input.otherRepositoryAllowance <= input.providerJobLimit;
  const providerRequired =
    validLimit && validAllowance
      ? input.mainDemand + input.otherDemand + input.otherRepositoryAllowance + CANDIDATE_SLOTS
      : null;
  const hold: CapacityHold | null =
    providerRequired === null
      ? "invalid-capacity"
      : !Array.isArray(input.preFanoutMainRuns) || input.preFanoutMainRuns.length > 0
        ? "main-pre-fanout"
        : !Number.isSafeInteger(input.mainQueuedJobs) ||
            input.mainQueuedJobs !== 0 ||
            (input.latestMain?.queuedJobs ?? 0) > 0
          ? "main-queued"
          : input.otherDemand + reservedMain + CANDIDATE_SLOTS > input.runnerBudget
            ? "repository-budget"
            : providerRequired > input.providerJobLimit
              ? "provider-limit"
              : null;
  return {
    allowed: hold === null,
    reservedMain,
    capacity: {
      providerJobLimit: validLimit ? input.providerJobLimit : null,
      otherRepositoryAllowance: validAllowance ? input.otherRepositoryAllowance : null,
      providerRequired,
      latestMain: input.latestMain,
      mainQueuedJobs: input.mainQueuedJobs,
      preFanoutMainRuns: Array.isArray(input.preFanoutMainRuns) ? [...input.preFanoutMainRuns] : [],
      hold,
    },
  };
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
export function requireInitializedState(stateSha: string | null, ledger: Ledger): void {
  const init = ledger.initialization;
  if (
    !stateSha ||
    !SHA.test(stateSha) ||
    init?.schemaVersion !== 1 ||
    !/^[a-f0-9-]{36}$/.test(init.operationId) ||
    !init.serviceUid ||
    !/^[1-9][0-9]*$/.test(init.serviceGeneration) ||
    !Number.isFinite(Date.parse(init.initializedAt))
  ) {
    const error = new Error(
      "Active state uninitialized or missing: operator initialization required; never auto-reinitialize",
    );
    error.name = "ActiveStateInitializationError";
    throw error;
  }
}
export interface Observation {
  baseCI?: BaseCiEvidence;
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
    rawP95ReadyToCiSeconds?: number | null;
    windowSeconds?: number;
    samples: number;
    coverageSince: string;
    completeWindow: boolean;
  };
  missingRuns?: Record<string, MissingRun>;
}
export interface BaseCiEvidence {
  sha: string;
  status: "green" | "red" | "unknown";
  runId: number | null;
  attempt: number | null;
  reason: string;
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
  operatorOffEvidence?: string;
  onNoticeId?: string;
  port: number;
  fetchTimeoutSeconds: number;
  missingRunSeconds: number;
  runnerBudget: number | null;
  mainReserve: number | null;
  providerJobLimit: number;
  otherRepositoryAllowance: number;
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
  if (env.BATCHER_ON_NOTICE_ID && !/^[a-zA-Z0-9_-]{8,128}$/.test(env.BATCHER_ON_NOTICE_ID))
    throw new Error("Invalid BATCHER_ON_NOTICE_ID");
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
    ...(env.BATCHER_ON_NOTICE_ID ? { onNoticeId: env.BATCHER_ON_NOTICE_ID } : {}),
    ...(env.BATCHER_OPERATOR_OFF_EVIDENCE
      ? { operatorOffEvidence: env.BATCHER_OPERATOR_OFF_EVIDENCE }
      : {}),
    port: integer("PORT", 8080, 65535),
    fetchTimeoutSeconds: integer("BATCHER_FETCH_TIMEOUT_SECONDS", 600, 3600),
    missingRunSeconds: integer("BATCHER_MISSING_RUN_SECONDS", 900, 86400),
    runnerBudget: env.BATCHER_RUNNER_BUDGET ? integer("BATCHER_RUNNER_BUDGET", 0, 100000) : null,
    mainReserve: env.BATCHER_MAIN_RESERVE ? integer("BATCHER_MAIN_RESERVE", 0, 100000) : null,
    providerJobLimit: integer("BATCHER_PROVIDER_JOB_LIMIT", DEFAULT_PROVIDER_JOB_LIMIT, 100000),
    otherRepositoryAllowance: (() => {
      const raw =
        env.BATCHER_OTHER_REPOSITORY_ALLOWANCE ?? String(DEFAULT_OTHER_REPOSITORY_ALLOWANCE);
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isSafeInteger(n) || n < 0 || n > 100000)
        throw new Error("Invalid BATCHER_OTHER_REPOSITORY_ALLOWANCE");
      return n;
    })(),
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
