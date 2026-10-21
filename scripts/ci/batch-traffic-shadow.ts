import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { GitStore, AtomicGitWriter, GitFailure, MergeConflict } from "../merge-batcher/git";
import { GitHubAuth, GitHubReader } from "../merge-batcher/github";
import {
  assertSha,
  canonical,
  config,
  digest,
  emptyLedger,
  type Config,
  type Ledger,
  type Manifest,
  type Pull,
  type Run,
} from "../merge-batcher/model";
import { QueueOnlyPublisher, type CandidatePublisher } from "../merge-batcher/shadow-ci";

export const TRAFFIC_PREFIX = "queue/shadow-traffic/";
export const TRAFFIC_STATE = "refs/heads/batcher-shadow-traffic-state";
export const ADAPTER_PATHS = [
  ".github/workflows/batch-ci.yml",
  "scripts/merge-batcher/main.ts",
  "scripts/merge-batcher/git.ts",
  "scripts/merge-batcher/model.ts",
  "scripts/ci/batch-result.ts",
  "scripts/ci/batch-setup.ts",
  "scripts/ci/batch-source.ts",
] as const;
export interface MergedPull {
  number: number;
  headSha: string;
  headRef: string;
  mergeSha: string;
  mergedAt: string;
  createdAt: string;
  readiness: {
    kind: "merged-at-proxy";
    at: string;
    admissionEvidence: false;
    reviewEvidence: false;
  };
}
export interface MainCI {
  id: number;
  attempt: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  timingSource: "current-attempt-jobs" | "unavailable";
}
export interface TrafficInput {
  since: string;
  until: string;
  pulls: MergedPull[];
  runs: MainCI[];
  observedMerged: number;
  omittedByCap: number;
}
export interface Cohort {
  key: string;
  pulls: MergedPull[];
  baseSha: string | null;
  actualTipSha: string;
  manifest: Manifest | null;
  status: "built" | "conflict" | "unavailable";
  reason: string | null;
  conflictAt: number | null;
  candidateTree: string | null;
  actualTree: string | null;
  treeEqual: boolean;
  compositionComplete: boolean;
  equivalent: boolean;
  adapterReady: boolean;
  members: {
    number: number;
    actualShape: string;
    candidateTree: string;
    actualTree: string;
    treeEqual: boolean;
  }[];
  mainRuns: MainCI[];
  buildMilliseconds: number;
}
export interface TrafficReport {
  schemaVersion: 1;
  kind: "merged-traffic-shadow";
  observedAt: string;
  mode: "read-only" | "ci-shadow";
  readinessMeaning: string;
  input: TrafficInput;
  mainSha: string;
  cohorts: Cohort[];
  counts: Record<string, number>;
  timingsMilliseconds: { collect: number; replay: number };
}
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid traffic timestamp");
  return new Date(value).toISOString();
};
function positive(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid traffic number");
  return n;
}

/** Closed/updated pagination is not GitHub Search, so it has no Search 1,000-result cap. */
export async function collectTraffic(
  reader: GitHubReader,
  since: string,
  until: string,
  maximumPulls = 128,
): Promise<TrafficInput> {
  since = timestamp(since);
  until = timestamp(until);
  if (since >= until || maximumPulls < 1 || maximumPulls > 1000)
    throw new Error("Invalid traffic window/cap");
  const byNumber = new Map<number, MergedPull>();
  let complete = false;
  for (let page = 1; page <= 100; page++) {
    const rows = await reader.get(
      `pulls?state=closed&base=${encodeURIComponent(reader.config.baseBranch)}&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(rows)) throw new Error("Malformed closed PR page");
    for (const row of rows) {
      if (!row.merged_at) continue;
      const mergedAt = timestamp(row.merged_at);
      if (mergedAt < since || mergedAt > until || row.base?.ref !== reader.config.baseBranch)
        continue;
      if (row.base?.repo?.full_name !== reader.config.repository)
        throw new Error("Traffic PR repository mismatch");
      const number = positive(row.number);
      const pull: MergedPull = {
        number,
        headSha: assertSha(row.head?.sha),
        headRef: String(row.head?.ref ?? ""),
        mergeSha: assertSha(row.merge_commit_sha),
        mergedAt,
        createdAt: timestamp(row.created_at),
        readiness: {
          kind: "merged-at-proxy",
          at: mergedAt,
          admissionEvidence: false,
          reviewEvidence: false,
        },
      };
      if (!pull.headRef) throw new Error("Missing historical PR head ref");
      const prior = byNumber.get(number);
      if (prior && canonical(prior) !== canonical(pull))
        throw new Error("PR projection changed during collection");
      byNumber.set(number, pull);
    }
    if (rows.length < 100 || timestamp(rows.at(-1)!.updated_at) < since) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error("Traffic pagination incomplete; narrow the lookback");
  const all = [...byNumber.values()].sort(
    (a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number,
  );
  const pulls = all.slice(-maximumPulls);
  const runs: MainCI[] = [];
  // Query exact observed merge SHAs instead of a capped date-filtered run search.
  for (const sha of new Set(pulls.map((p) => p.mergeSha))) {
    const rows = await reader.pages(
      `actions/workflows/ci.yml/runs?branch=${encodeURIComponent(reader.config.baseBranch)}&event=push&head_sha=${sha}`,
      "workflow_runs",
    );
    for (const row of rows) {
      if (
        row.head_sha !== sha ||
        row.event !== "push" ||
        row.head_branch !== reader.config.baseBranch ||
        row.path !== ".github/workflows/ci.yml"
      )
        continue;
      const id = positive(row.id),
        attempt = positive(row.run_attempt);
      if (runs.some((r) => r.id === id && r.attempt === attempt)) continue;
      const jobs = await reader.pages(`actions/runs/${id}/attempts/${attempt}/jobs`, "jobs");
      const starts = jobs
        .filter((j) => j.started_at)
        .map((j) => timestamp(j.started_at))
        .sort();
      const ends = jobs
        .filter((j) => j.completed_at)
        .map((j) => timestamp(j.completed_at))
        .sort();
      const startedAt = starts[0] ?? null;
      const completedAt =
        row.status === "completed" && jobs.length > 0 && jobs.every((j) => j.status === "completed")
          ? (ends.at(-1) ?? null)
          : null;
      runs.push({
        id,
        attempt,
        headSha: sha,
        status: String(row.status),
        conclusion: row.conclusion ?? null,
        createdAt: timestamp(row.created_at),
        startedAt,
        completedAt,
        durationSeconds:
          startedAt && completedAt
            ? Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
            : null,
        timingSource: startedAt ? "current-attempt-jobs" : "unavailable",
      });
    }
  }
  return {
    since,
    until,
    pulls,
    runs,
    observedMerged: all.length,
    omittedByCap: Math.max(0, all.length - pulls.length),
  };
}

/** Core manifest compatibility only: this synthetic binding is NEVER real readiness. */
export function proxyPull(p: MergedPull): Pull {
  return {
    number: p.number,
    headSha: p.headSha,
    headRef: p.headRef,
    binding: {
      source: "queue-ready",
      eventId: `traffic-shadow:merged-at-proxy:${p.number}:${p.mergeSha}`,
      at: p.mergedAt,
      evidenceId: "traffic-shadow:NOT-ADMISSION-OR-REVIEW-EVIDENCE",
      evidenceDigest: digest({
        kind: "merged-at-proxy",
        number: p.number,
        headSha: p.headSha,
        mergeSha: p.mergeSha,
        mergedAt: p.mergedAt,
      }),
    },
  };
}
export function fifoCohorts(
  pulls: MergedPull[],
  cap: number,
  order: Map<string, number>,
): MergedPull[][] {
  if (!Number.isInteger(cap) || cap < 1 || cap > 16) throw new Error("Cohort cap must be 1..16");
  const unique = new Map<number, MergedPull>();
  for (const p of pulls) {
    const prior = unique.get(p.number);
    if (prior && canonical(prior) !== canonical(p))
      throw new Error("Conflicting duplicate traffic PR");
    unique.set(p.number, p);
  }
  const sorted = [...unique.values()].sort(
    (a, b) =>
      a.mergedAt.localeCompare(b.mergedAt) ||
      (order.get(a.mergeSha) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.mergeSha) ?? Number.MAX_SAFE_INTEGER) ||
      a.number - b.number,
  );
  const cohorts: MergedPull[][] = [];
  let current: MergedPull[] = [];
  const drain = () => {
    if (current.length) cohorts.push(current);
    current = [];
  };
  for (const p of sorted) {
    if (p.headRef === "changeset-release/main") {
      drain();
      cohorts.push([p]);
    } else {
      current.push(p);
      if (current.length === cap) drain();
    }
  }
  drain();
  return cohorts;
}
async function commitInfo(git: GitStore, sha: string) {
  const [tree, parents] = await Promise.all([
    git.exec(["rev-parse", `${assertSha(sha)}^{tree}`]),
    git.exec(["rev-list", "--parents", "-n", "1", sha]),
  ]);
  return { tree: assertSha(tree), parents: parents.split(" ").slice(1) };
}
export async function adapterPresent(git: GitStore, base: string, tip: string): Promise<boolean> {
  for (const path of ADAPTER_PATHS) {
    try {
      const before = await git.exec(["rev-parse", `${assertSha(base)}:${path}`]);
      const after = await git.exec(["rev-parse", `${assertSha(tip)}:${path}`]);
      // Do not run newly introduced or changed verifier bytes in historical cohorts.
      if (!/^[a-f0-9]{40}$/.test(before) || before !== after) return false;
    } catch (e) {
      if (e instanceof GitFailure) return false;
      throw e;
    }
  }
  return true;
}
export async function replayTraffic(
  git: GitStore,
  remote: string,
  input: TrafficInput,
  cap = 16,
): Promise<TrafficReport> {
  const started = performance.now();
  await git.init();
  await git.fetch(remote, ["+refs/heads/main:refs/remotes/traffic/main"]);
  const mainSha = assertSha(await git.exec(["rev-parse", "refs/remotes/traffic/main"]));
  const history = (await git.exec(["rev-list", "--first-parent", "--reverse", mainSha])).split(
    "\n",
  );
  const order = new Map(history.map((sha, i) => [sha, i]));
  const cohorts: Cohort[] = [];
  for (const pulls of fifoCohorts(input.pulls, cap, order)) {
    const at = performance.now(),
      actualTipSha = pulls.at(-1)!.mergeSha;
    const cohort: Cohort = {
      key: digest(pulls),
      pulls,
      baseSha: null,
      actualTipSha,
      manifest: null,
      status: "unavailable",
      reason: null,
      conflictAt: null,
      candidateTree: null,
      actualTree: null,
      treeEqual: false,
      compositionComplete: false,
      equivalent: false,
      adapterReady: false,
      members: [],
      mainRuns: input.runs.filter((r) => r.headSha === actualTipSha),
      buildMilliseconds: 0,
    };
    cohorts.push(cohort);
    try {
      const indices = pulls.map((p) => order.get(p.mergeSha));
      if (
        indices.some((i) => i === undefined) ||
        indices.some((i, n) => n > 0 && i! <= indices[n - 1]!)
      ) {
        cohort.reason =
          "Merge projections are not ordered unique retained main first-parent commits";
        continue;
      }
      const first = await commitInfo(git, pulls[0]!.mergeSha);
      if (!first.parents[0]) {
        cohort.reason = "No pre-cohort first parent";
        continue;
      }
      cohort.baseSha = first.parents[0];
      cohort.compositionComplete = indices.every((i, n) => i === indices[0]! + n);
      for (const p of pulls) {
        try {
          await git.exec(["cat-file", "-e", `${p.headSha}^{commit}`]);
        } catch (e) {
          if (!(e instanceof GitFailure)) throw e;
          await git.fetch(remote, [p.headSha]);
        }
      }
      const manifest = await git.build({
        schemaVersion: 1,
        baseSha: cohort.baseSha,
        predecessor: null,
        recoveryOf: null,
        createdAt: pulls.at(-1)!.mergedAt,
        pulls: pulls.map(proxyPull),
      });
      cohort.manifest = manifest;
      for (const [i, member] of manifest.pulls.entries()) {
        const actual = await commitInfo(git, pulls[i]!.mergeSha),
          candidate = await commitInfo(git, member.mergeSha);
        cohort.members.push({
          number: member.number,
          actualShape:
            actual.parents.length === 1
              ? "single-parent-squash-or-rebase"
              : actual.parents.length === 2 && actual.parents[1] === member.headSha
                ? "exact-head-merge"
                : "other-merge",
          candidateTree: candidate.tree,
          actualTree: actual.tree,
          treeEqual: candidate.tree === actual.tree,
        });
      }
      cohort.candidateTree = (await commitInfo(git, manifest.tipSha)).tree;
      cohort.actualTree = (await commitInfo(git, actualTipSha)).tree;
      cohort.treeEqual = cohort.candidateTree === cohort.actualTree;
      cohort.equivalent =
        cohort.treeEqual && cohort.compositionComplete && cohort.members.every((m) => m.treeEqual);
      cohort.adapterReady = await adapterPresent(git, cohort.baseSha, manifest.tipSha);
      cohort.status = "built";
      cohort.reason = cohort.equivalent
        ? null
        : "Tree or intermediate composition differs; historical CI is not equivalent candidate evidence";
    } catch (e) {
      if (e instanceof MergeConflict) {
        cohort.status = "conflict";
        cohort.conflictAt = e.number;
        cohort.reason = "Conflict at this composition step, not proof of a unique culpable PR";
      } else if (e instanceof GitFailure)
        cohort.reason = "Historical Git objects unavailable or Git operation failed";
      else throw e;
    } finally {
      cohort.buildMilliseconds = performance.now() - at;
    }
  }
  return {
    schemaVersion: 1,
    kind: "merged-traffic-shadow",
    mode: "read-only",
    observedAt: new Date().toISOString(),
    readinessMeaning:
      "mergedAt is a FIFO readiness PROXY, never queue admission, VM tests or review evidence. Historical main CI is observational, not candidate CI or release admission.",
    input,
    mainSha,
    cohorts,
    counts: {
      pulls: input.pulls.length,
      cohorts: cohorts.length,
      built: cohorts.filter((c) => c.status === "built").length,
      conflicts: cohorts.filter((c) => c.status === "conflict").length,
      unavailable: cohorts.filter((c) => c.status === "unavailable").length,
      equivalent: cohorts.filter((c) => c.equivalent).length,
      disagreements: cohorts.filter((c) => c.status === "built" && !c.equivalent).length,
      adapterReady: cohorts.filter((c) => c.adapterReady).length,
      mainRuns: input.runs.length,
    },
    timingsMilliseconds: { collect: 0, replay: performance.now() - started },
  };
}

export function compareOutcome(cohort: Cohort, run: Run | undefined) {
  const exact =
    !!run &&
    !!cohort.manifest &&
    run.headSha === cohort.manifest.tipSha &&
    run.branch === `${TRAFFIC_PREFIX}${cohort.manifest.batchId}` &&
    run.workflow === ".github/workflows/batch-ci.yml" &&
    run.trusted &&
    run.status === "completed";
  const comparable =
    exact && cohort.equivalent && (run!.outcome === "success" || run!.outcome === "code_failure");
  const historicalRuns = cohort.mainRuns.filter(
    (r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure"),
  );
  return {
    batchId: cohort.manifest?.batchId ?? null,
    candidateEvidenceExact: exact,
    candidateOutcome: exact ? run!.outcome : "unknown",
    historicalMainRuns: cohort.mainRuns,
    comparable,
    agreement:
      comparable && historicalRuns.length === 1
        ? (run!.outcome === "success") === (historicalRuns[0]!.conclusion === "success")
        : null,
    uniqueCulprit: null,
    limitation:
      "Same trees do not imply identical workflow coverage. Failure is an aggregate observation; cancellation, infrastructure and absent receipts never identify a culprit.",
  };
}
interface TrafficLedger extends Ledger {
  trafficShadow: {
    kind: "merged-traffic-shadow";
    published: string[];
    publishedBindings: string[];
  };
}
export function trafficConfig(
  env: Record<string, string | undefined>,
  mode: "shadow" | "shadow-ci",
  gitDir: string,
  outputDir: string,
): Config {
  const base = config({ ...env, BATCHER_MODE: "shadow", BATCHER_BRANCH_PREFIX: TRAFFIC_PREFIX });
  if (base.baseBranch !== "main") throw new Error("Traffic shadow reconstructs main only");
  return {
    ...base,
    mode,
    branchPrefix: TRAFFIC_PREFIX,
    stateRef: TRAFFIC_STATE,
    maxInflight: 1,
    maxBatchSize: 16,
    gitDir,
    outputDir,
  };
}
export interface TrafficPublication {
  action: "published" | "wait";
  reason: string;
  batchId: string | null;
  comparisons: ReturnType<typeof compareOutcome>[];
}
/** Only this optional adapter receives a publisher. Read-only replay cannot push. */
export async function publishOneTraffic(
  settings: Config,
  git: GitStore,
  reader: Pick<GitHubReader, "runs">,
  remote: string,
  report: TrafficReport,
  publisher: CandidatePublisher,
): Promise<TrafficPublication> {
  if (
    settings.mode !== "shadow-ci" ||
    settings.branchPrefix !== TRAFFIC_PREFIX ||
    settings.stateRef !== TRAFFIC_STATE ||
    settings.baseBranch !== "main" ||
    settings.maxInflight !== 1
  )
    throw new Error("Restricted traffic publication configuration required");
  const refs = await git.remoteRefs(remote),
    stateSha = refs.get(TRAFFIC_STATE) ?? null;
  let ledger: TrafficLedger = {
    ...emptyLedger(),
    trafficShadow: { kind: "merged-traffic-shadow", published: [], publishedBindings: [] },
  };
  if (stateSha) {
    await git.fetch(remote, [stateSha]);
    ledger = (await git.readLedger(stateSha)) as TrafficLedger;
    if (
      ledger.trafficShadow?.kind !== "merged-traffic-shadow" ||
      !Array.isArray(ledger.trafficShadow.published) ||
      !Array.isArray(ledger.trafficShadow.publishedBindings) ||
      ![...ledger.trafficShadow.published, ...ledger.trafficShadow.publishedBindings].every((id) =>
        /^[a-f0-9]{64}$/.test(id),
      )
    )
      throw new Error("Not a traffic-shadow CAS ledger");
  }
  const seen = new Set(ledger.trafficShadow.published),
    comparisons: ReturnType<typeof compareOutcome>[] = [];
  const seenBindings = new Set(ledger.trafficShadow.publishedBindings);
  let occupied = false;
  for (const [ref, sha] of refs) {
    if (!ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)) continue;
    await git.fetch(remote, [sha]);
    const manifest = await git.inspect(sha);
    if (ref !== `refs/heads/${TRAFFIC_PREFIX}${manifest.batchId}`)
      throw new Error("Traffic candidate ref/manifest mismatch");
    seen.add(manifest.batchId);
    for (const pull of manifest.pulls) seenBindings.add(pull.binding.evidenceDigest);
    const runs = await reader.runs(manifest, ref.slice("refs/heads/".length));
    if (!runs.length || runs.some((r) => r.status !== "completed")) occupied = true;
    const cohort = report.cohorts.find((c) => c.manifest?.batchId === manifest.batchId);
    if (cohort)
      comparisons.push(
        compareOutcome(cohort, [...runs].sort((a, b) => b.id - a.id || b.attempt - a.attempt)[0]),
      );
  }
  const wait = (reason: string): TrafficPublication => ({
    action: "wait",
    reason,
    batchId: null,
    comparisons,
  });
  if (occupied)
    return wait(
      "One hosted traffic candidate slot occupied, including unpublished workflow results; no cancellation",
    );
  const pending = report.cohorts.filter(
    (c) =>
      c.manifest &&
      !seen.has(c.manifest.batchId) &&
      c.manifest.pulls.every((p) => !seenBindings.has(p.binding.evidenceDigest)),
  );
  const chosen = pending.find((c) => c.adapterReady && c.equivalent);
  if (!chosen?.manifest)
    return wait(
      pending.length
        ? "Waiting for an equivalent cohort whose pre-cohort base already contains the unchanged adapter; no overlays"
        : "No unseen candidates; restart deduplication retained",
    );
  // Recompute instead of trusting a saved report and recheck refs before CAS.
  if (
    canonical(await git.inspect(chosen.manifest.tipSha)) !== canonical(chosen.manifest) ||
    !(await adapterPresent(git, chosen.manifest.baseSha, chosen.manifest.tipSha))
  )
    throw new Error("Traffic manifest/adapter changed");
  const fresh = await git.remoteRefs(remote);
  if (
    (fresh.get(TRAFFIC_STATE) ?? null) !== stateSha ||
    canonical(
      [...fresh].filter(([ref]) => ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)).sort(),
    ) !==
      canonical([...refs].filter(([ref]) => ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)).sort())
  )
    return wait("CAS snapshot changed; re-observe");
  const now = new Date().toISOString();
  const next: TrafficLedger = {
    ...ledger,
    epoch: ledger.epoch + 1,
    owner: "merged-traffic-shadow",
    expiresAt: now,
    trafficShadow: {
      kind: "merged-traffic-shadow",
      published: [...seen, chosen.manifest.batchId].sort(),
      publishedBindings: [
        ...seenBindings,
        ...chosen.manifest.pulls.map((p) => p.binding.evidenceDigest),
      ].sort(),
    },
  };
  const nextSha = await git.stateCommit(next, stateSha, now);
  await publisher.publish(stateSha, nextSha, chosen.manifest);
  return {
    action: "published",
    reason:
      "Queue-only candidate + durable CAS state; no main, PR state, cancellation or rerun writes",
    batchId: chosen.manifest.batchId,
    comparisons,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: "boolean" },
      "ci-shadow": { type: "boolean" },
      "lookback-hours": { type: "string" },
      cap: { type: "string" },
      "max-prs": { type: "string" },
      output: { type: "string" },
      "git-dir": { type: "string" },
    },
  });
  const hours = Number(values["lookback-hours"] ?? env.TRAFFIC_SHADOW_LOOKBACK_HOURS ?? 24);
  const cap = Number(values.cap ?? env.TRAFFIC_SHADOW_CAP ?? 16);
  const maxPrs = Number(values["max-prs"] ?? env.TRAFFIC_SHADOW_MAX_PRS ?? 128);
  if (
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > 720 ||
    !Number.isInteger(maxPrs) ||
    maxPrs < 1 ||
    maxPrs > 1000 ||
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > 16
  )
    throw new Error("Invalid traffic lookback/cap");
  const output = resolve(values.output ?? env.TRAFFIC_SHADOW_OUTPUT ?? "./traffic-shadow");
  const gitDir = resolve(
    values["git-dir"] ?? env.TRAFFIC_SHADOW_GIT_DIR ?? join(output, "objects.git"),
  );
  const mode = values["ci-shadow"] ? "shadow-ci" : "shadow";
  const settings = trafficConfig(env, mode, gitDir, output);
  const auth = new GitHubAuth({ ...env, BATCHER_MODE: mode });
  const reader = new GitHubReader(settings, auth),
    remote = `https://github.com/${settings.repository}.git`;
  let stopping = false;
  const isStopping = () => stopping;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      const at = performance.now(),
        until = new Date().toISOString(),
        since = new Date(Date.parse(until) - hours * 3600000).toISOString();
      const input = await collectTraffic(reader, since, until, maxPrs);
      const collect = performance.now() - at;
      const git = new GitStore(gitDir, await auth.gitEnv());
      const report = await replayTraffic(git, remote, input, cap);
      report.timingsMilliseconds.collect = collect;
      report.mode = mode === "shadow" ? "read-only" : "ci-shadow";
      const publication =
        mode === "shadow-ci"
          ? await publishOneTraffic(
              settings,
              git,
              reader,
              remote,
              report,
              new QueueOnlyPublisher(
                settings,
                new AtomicGitWriter(git, remote, TRAFFIC_STATE, "refs/heads/main"),
              ),
            )
          : null;
      await mkdir(output, { recursive: true });
      const filename = join(output, `traffic-${until.replaceAll(":", "-")}.json`);
      await writeFile(filename, canonical({ ...report, publication }) + "\n", { mode: 0o600 });
      const temporary = join(output, `latest.${process.pid}.tmp`);
      await writeFile(temporary, canonical({ ...report, publication }) + "\n", { mode: 0o600 });
      await rename(temporary, join(output, "latest.json"));
      console.log(
        JSON.stringify({
          file: filename,
          counts: report.counts,
          timingsMilliseconds: report.timingsMilliseconds,
          publication,
        }),
      );
      if (values.once || env.TRAFFIC_SHADOW_ONCE === "true") break;
      for (let i = 0; i < settings.pollSeconds && !isStopping(); i++) await Bun.sleep(1000);
    } while (!isStopping());
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Traffic shadow failed");
    process.exitCode = 1;
  });
