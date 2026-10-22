import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { GitStore, AtomicGitWriter, GitFailure, MergeConflict } from "../merge-batcher/git";
import { GitHubAuth, GitHubReader } from "../merge-batcher/github";
import {
  assertSha,
  canonical,
  capacityDecision,
  config,
  DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
  DEFAULT_PROVIDER_JOB_LIMIT,
  digest,
  emptyLedger,
  MAX_RUNNER_RELEVANT_RUNS,
  MAX_SCANNED_ACTIVE_RUNS,
  scanRunnerDemand,
  type CapacityHold,
  type CapacityObservation,
  type RunnerScanHold,
  type Config,
  type Ledger,
  type Manifest,
  type Pull,
  type Run,
} from "../merge-batcher/model";
import { QueueOnlyPublisher, type CandidatePublisher } from "../merge-batcher/shadow-ci";
import type { VerifiedResult } from "../merge-batcher/result";

export const TRAFFIC_PREFIX = "queue/shadow-traffic/";
export const TRAFFIC_STATE = "refs/heads/batcher-shadow-traffic-state";
export const ADAPTER_PATHS = [
  ".github/workflows/batch-ci.yml",
  "scripts",
  "scripts/merge-batcher/main.ts",
  "scripts/merge-batcher/git.ts",
  "scripts/merge-batcher/model.ts",
  "scripts/ci/batch-result.ts",
  "scripts/ci/batch-setup.ts",
  "scripts/ci/batch-source.ts",
  "scripts/ci/impact.ts",
  "scripts/ci/profile-command.ts",
  "scripts/ci/run-unit-shard.ts",
  ".bun-version",
  "package.json",
  "bun.lock",
] as const;
export const ADAPTER_COVERAGE =
  "Exact scripts tree (including all core and CI scripts), Batch CI workflow, Bun version, root package manifest and lockfile. Not an exhaustive execution dependency closure: workspace package sources, other configuration and third-party actions/images can differ.";
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
  observedMerges?: { number: number; mergeSha: string; mergedAt: string }[];
}
export interface HistoricalHead {
  number: number;
  headSha: string;
  postBaseMainAncestors: string[];
  classification: "contains-post-base-main" | "no-post-base-main-detected";
  onActualParent: { clean: boolean; treeEqual: boolean | null; tree: string | null } | null;
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
  exclusions: { number: number; headSha: string; reason: string }[];
  historicalHeads: HistoricalHead[];
  candidateTree: string | null;
  actualTree: string | null;
  treeEqual: boolean;
  compositionComplete: boolean;
  equivalent: boolean;
  adapterReady: boolean;
  adapterCheck: AdapterCheck | null;
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
  replayMeaning: string;
  adapterCoverage: string;
  collectionCoverage: {
    status: "unmapped-main-commits" | "no-unmapped-main-commits";
    windowMainCommits: number;
    selectedMapped: number;
    knownOmittedByCap: number;
    selectedNotOnMain: number[];
    unrepresented: {
      sha: string;
      committedAt: string;
      prNumberHints: number[];
      classification: "not-selected-or-direct-commit" | "outside-retained-cap-or-unmapped";
    }[];
    limitation: string;
  };
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
    observedMerges: all.map(({ number, mergeSha, mergedAt }) => ({ number, mergeSha, mergedAt })),
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
  adapterBoundaries: ReadonlySet<string> = new Set(),
  adapterStarts: ReadonlySet<string> = new Set(),
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
    if (adapterStarts.has(p.mergeSha)) drain();
    if (p.headRef === "changeset-release/main" || adapterBoundaries.has(p.mergeSha)) {
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
export interface AdapterCheck {
  baseSha: string;
  tipSha: string;
  ready: boolean;
  firstFailure: {
    path: string;
    reason: "changed-or-invalid-object" | "not-a-tree" | "unavailable-object";
    before: string | null;
    after: string | null;
  } | null;
}
export async function inspectAdapter(
  git: GitStore,
  base: string,
  tip: string,
): Promise<AdapterCheck> {
  const check: AdapterCheck = {
    baseSha: assertSha(base),
    tipSha: assertSha(tip),
    ready: false,
    firstFailure: null,
  };
  for (const path of ADAPTER_PATHS) {
    let before: string | null = null,
      after: string | null = null;
    try {
      before = await git.exec(["rev-parse", `${check.baseSha}:${path}`]);
      after = await git.exec(["rev-parse", `${check.tipSha}:${path}`]);
      // Do not run newly introduced or changed verifier bytes in historical cohorts.
      if (!/^[a-f0-9]{40}$/.test(before) || before !== after) {
        check.firstFailure = { path, reason: "changed-or-invalid-object", before, after };
        return check;
      }
      if (path === "scripts" && (await git.exec(["cat-file", "-t", before])) !== "tree") {
        check.firstFailure = { path, reason: "not-a-tree", before, after };
        return check;
      }
    } catch (e) {
      if (e instanceof GitFailure) {
        check.firstFailure = { path, reason: "unavailable-object", before, after };
        return check;
      }
      throw e;
    }
  }
  check.ready = true;
  return check;
}
export async function adapterPresent(git: GitStore, base: string, tip: string): Promise<boolean> {
  return (await inspectAdapter(git, base, tip)).ready;
}

/** Segmentation is only a selection aid: synthetic candidates still pass the exact guard. */
async function findAdapterBoundaries(
  git: GitStore,
  pulls: MergedPull[],
  order: Map<string, number>,
) {
  const boundaries = new Set<string>();
  const starts = new Set<string>();
  let previous: string | undefined;
  for (const [pull] of fifoCohorts(pulls, 1, order)) {
    const sha = pull!.mergeSha;
    if (!order.has(sha)) {
      boundaries.add(sha);
      continue;
    }
    try {
      const actual = await commitInfo(git, sha);
      if (
        previous &&
        actual.parents[0] &&
        order.get(previous)! < order.get(sha)! &&
        (await git.exec([
          "log",
          "--first-parent",
          "--format=%H",
          `${previous}..${actual.parents[0]}`,
          "--",
          ...ADAPTER_PATHS,
        ]))
      )
        starts.add(sha);
      if (
        !actual.parents[0] ||
        (await git.exec(["diff", "--name-only", actual.parents[0], sha, "--", ...ADAPTER_PATHS]))
      )
        boundaries.add(sha);
    } catch (error) {
      if (!(error instanceof GitFailure)) throw error;
      // Keep unavailable members visible as isolated cohorts, never silently drop them.
      boundaries.add(sha);
    }
    previous = sha;
  }
  return { boundaries, starts };
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
  const selected = new Set(input.pulls.map((p) => p.mergeSha));
  const mergeMembers = new Map<string, Set<number>>();
  for (const pull of input.pulls) {
    const members = mergeMembers.get(pull.mergeSha) ?? new Set<number>();
    members.add(pull.number);
    mergeMembers.set(pull.mergeSha, members);
  }
  const observed = new Set(input.observedMerges?.map((p) => p.mergeSha) ?? []);
  const earliestSelected = Math.min(...input.pulls.map((p) => order.get(p.mergeSha) ?? Infinity));
  const mainRows = (await git.exec(["log", "--first-parent", "--format=%H%x09%cI%x09%s", mainSha]))
    .split("\n")
    .map((line) => {
      const [sha, committedAt, ...subject] = line.split("\t");
      return {
        sha: assertSha(sha ?? ""),
        committedAt: timestamp(committedAt),
        subject: subject.join("\t"),
      };
    })
    .filter((row) => row.committedAt >= input.since && row.committedAt <= input.until);
  const collectionCoverage: TrafficReport["collectionCoverage"] = {
    status: "no-unmapped-main-commits",
    windowMainCommits: mainRows.length,
    selectedMapped: input.pulls.filter((p) => order.has(p.mergeSha)).length,
    knownOmittedByCap: mainRows.filter((row) => observed.has(row.sha) && !selected.has(row.sha))
      .length,
    selectedNotOnMain: input.pulls.filter((p) => !order.has(p.mergeSha)).map((p) => p.number),
    unrepresented: mainRows
      .filter((row) => !selected.has(row.sha) && !observed.has(row.sha))
      .map((row) => ({
        sha: row.sha,
        committedAt: row.committedAt,
        prNumberHints: [...row.subject.matchAll(/(?:\(#(\d+)\)|Merge pull request #(\d+))/g)].map(
          (match) => Number(match[1] ?? match[2]),
        ),
        classification:
          !input.observedMerges &&
          input.omittedByCap > 0 &&
          (order.get(row.sha) ?? Infinity) < earliestSelected
            ? ("outside-retained-cap-or-unmapped" as const)
            : ("not-selected-or-direct-commit" as const),
      })),
    limitation:
      "Cross-check of current retained first-parent main by committer-time window, not snapshot-consistent PR pagination. Unrepresented commits may be missing PR collection, direct commits, batch landings or timestamp differences; subject PR numbers are hints only. Old retained input lacks exact omitted-merge projections. No exhaustive PR-history guarantee.",
  };
  if (collectionCoverage.unrepresented.length || collectionCoverage.selectedNotOnMain.length)
    collectionCoverage.status = "unmapped-main-commits";
  const cohorts: Cohort[] = [];
  const { boundaries, starts } = await findAdapterBoundaries(git, input.pulls, order);
  for (const pulls of fifoCohorts(input.pulls, cap, order, boundaries, starts)) {
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
      exclusions: [],
      historicalHeads: [],
      candidateTree: null,
      actualTree: null,
      treeEqual: false,
      compositionComplete: false,
      equivalent: false,
      adapterReady: false,
      adapterCheck: null,
      members: [],
      mainRuns: input.runs.filter((r) => r.headSha === actualTipSha),
      buildMilliseconds: 0,
    };
    cohorts.push(cohort);
    try {
      const indices = pulls.map((p) => order.get(p.mergeSha));
      if (
        pulls.some((p) => mergeMembers.get(p.mergeSha)!.size > 1) ||
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
      for (const pull of pulls) {
        const ancestors = new Set(
          (await git.exec(["rev-list", pull.headSha, `^${cohort.baseSha}`])).split("\n"),
        );
        const postBaseMainAncestors = history
          .slice((order.get(cohort.baseSha) ?? -1) + 1)
          .filter((sha) => ancestors.has(sha));
        const projection: HistoricalHead = {
          number: pull.number,
          headSha: pull.headSha,
          postBaseMainAncestors,
          classification: postBaseMainAncestors.length
            ? "contains-post-base-main"
            : "no-post-base-main-detected",
          onActualParent: null,
        };
        if (postBaseMainAncestors.length) {
          const actual = await commitInfo(git, pull.mergeSha);
          try {
            const merged = assertSha(
              (
                await git.exec(["merge-tree", "--write-tree", actual.parents[0]!, pull.headSha])
              ).split("\n")[0] ?? "",
            );
            projection.onActualParent = {
              clean: true,
              treeEqual: merged === actual.tree,
              tree: merged,
            };
          } catch (error) {
            if (!(error instanceof GitFailure)) throw error;
            projection.onActualParent = { clean: false, treeEqual: null, tree: null };
          }
        }
        cohort.historicalHeads.push(projection);
      }
      let viable = pulls;
      let manifest: Manifest | null = null;
      while (viable.length) {
        try {
          manifest = await git.build({
            schemaVersion: 1,
            baseSha: cohort.baseSha,
            predecessor: null,
            recoveryOf: null,
            createdAt: pulls.at(-1)!.mergedAt,
            pulls: viable.map(proxyPull),
          });
          break;
        } catch (e) {
          if (!(e instanceof MergeConflict)) throw e;
          const excluded = viable.find((p) => p.number === e.number);
          if (!excluded)
            throw new Error("Conflict does not identify a candidate member", { cause: e });
          cohort.conflictAt ??= excluded.number;
          cohort.exclusions.push({
            number: excluded.number,
            headSha: excluded.headSha,
            reason: cohort.historicalHeads.find((h) => h.number === excluded.number)!
              .postBaseMainAncestors.length
              ? "Historical replay artifact: observed head contains main commits newer than cohort base. Excluded direct member, not queue infeasibility or unique culprit evidence; later heads may retain its changes"
              : "Exact-head composition conflict: excluded as a direct member, not a unique culprit or proof its changes are absent from later heads",
          });
          viable = viable.filter(
            (p) => p.number !== excluded.number || p.headSha !== excluded.headSha,
          );
        }
      }
      if (!manifest) {
        cohort.status = "conflict";
        cohort.reason = "No viable direct members remain after exact-head conflict exclusions";
        continue;
      }
      if (cohort.exclusions.length) cohort.compositionComplete = false;
      cohort.manifest = manifest;
      for (const member of manifest.pulls) {
        const original = pulls.find((p) => p.number === member.number)!;
        const actual = await commitInfo(git, original.mergeSha),
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
      cohort.adapterCheck = await inspectAdapter(git, cohort.baseSha, manifest.tipSha);
      cohort.adapterReady = cohort.adapterCheck.ready;
      cohort.status = "built";
      cohort.reason = cohort.equivalent
        ? null
        : "Tree or intermediate composition differs; historical CI is not equivalent candidate evidence";
      if (!cohort.equivalent && cohort.historicalHeads.some((h) => h.postBaseMainAncestors.length))
        cohort.reason +=
          "; historical heads contain post-cohort-base main ancestry, so disagreement is a replay artifact, not queue feasibility evidence";
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
    replayMeaning:
      "Fixed-count historical composition experiment, NOT an arrival/service-time queue simulation. Cohorts may span hours and observed heads can contain main ancestry newer than their cohort base. Conflicts/disagreements do not measure live batch feasibility or throughput.",
    adapterCoverage: ADAPTER_COVERAGE,
    collectionCoverage,
    input,
    mainSha,
    cohorts,
    counts: {
      pulls: input.pulls.length,
      cohorts: cohorts.length,
      built: cohorts.filter((c) => c.status === "built").length,
      conflicts: cohorts.filter((c) => c.exclusions.length > 0 || c.status === "conflict").length,
      excludedHeads: cohorts.reduce((sum, c) => sum + c.exclusions.length, 0),
      rebuiltRemainders: cohorts.filter((c) => c.status === "built" && c.exclusions.length > 0)
        .length,
      unavailable: cohorts.filter((c) => c.status === "unavailable").length,
      equivalent: cohorts.filter((c) => c.equivalent).length,
      disagreements: cohorts.filter((c) => c.status === "built" && !c.equivalent).length,
      adapterReady: cohorts.filter((c) => c.adapterReady).length,
      mainRuns: input.runs.length,
      temporalLeakageHeads: cohorts.reduce(
        (sum, c) =>
          sum + c.historicalHeads.filter((h) => h.postBaseMainAncestors.length > 0).length,
        0,
      ),
      replayArtifactExclusions: cohorts.reduce(
        (sum, c) =>
          sum +
          c.exclusions.filter((e) =>
            c.historicalHeads.some(
              (h) => h.number === e.number && h.postBaseMainAncestors.length > 0,
            ),
          ).length,
        0,
      ),
      unrepresentedMainCommits: collectionCoverage.unrepresented.length,
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
/** Local evidence cache only, never credentials. Checksums detect torn/corrupt entries. */
export class TrafficCache {
  constructor(
    readonly dir: string,
    readonly clock = Date.now,
  ) {}
  async get<T>(key: string): Promise<T | null> {
    try {
      const envelope = JSON.parse(await readFile(join(this.dir, `${digest(key)}.json`), "utf8"));
      if (
        !envelope ||
        typeof envelope !== "object" ||
        !("value" in envelope) ||
        envelope.key !== key ||
        envelope.hash !== digest(envelope.value) ||
        (envelope.expiresAt !== null && envelope.expiresAt <= this.clock())
      )
        return null;
      return envelope.value as T;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw error;
    }
  }
  async put(key: string, value: unknown, ttlSeconds: number | null): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, `${digest(key)}.json`),
      temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(
      temp,
      canonical({
        key,
        value,
        hash: digest(value),
        expiresAt: ttlSeconds === null ? null : this.clock() + ttlSeconds * 1000,
      }),
      { mode: 0o600 },
    );
    await rename(temp, target);
  }
  async prune(maximum = 2048): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = (await readdir(this.dir, { withFileTypes: true })).filter(
      (f) =>
        f.isFile() &&
        /^[a-f0-9]{64}\.json$/.test(f.name) &&
        f.name !== `${digest("read-budget")}.json`,
    );
    if (files.length <= maximum) return;
    const times = await Promise.all(
      files.map(async (f) => ({
        file: join(this.dir, f.name),
        at: (await stat(join(this.dir, f.name))).mtimeMs,
      })),
    );
    times.sort((a, b) => a.at - b.at);
    for (const item of times.slice(0, files.length - maximum)) await unlink(item.file);
  }
}
export class TrafficBackoff extends Error {
  constructor(
    readonly retryAt: number,
    reason: string,
  ) {
    super(reason);
  }
}
interface ReadBudget {
  windowAt: number;
  used: number;
  blockedUntil: number;
  failures: number;
}
export class TrafficReadControl {
  private cycle = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    readonly cache: TrafficCache,
    readonly perHour = 600,
    readonly perCycle = 200,
    readonly remainingFloor = 1000,
  ) {}
  beginCycle() {
    this.cycle = 0;
  }
  private async budget(): Promise<ReadBudget> {
    const now = this.cache.clock();
    const saved = await this.cache.get<ReadBudget>("read-budget");
    return !saved || now - saved.windowAt >= 3600000
      ? {
          windowAt: now,
          used: 0,
          blockedUntil: saved?.blockedUntil ?? 0,
          failures: saved?.failures ?? 0,
        }
      : saved;
  }
  wrap(transport: typeof fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "api.github.com") return transport(input, init);
      // Serialize the budget and response backoff updates, including parallel callers.
      const operation = this.tail.then(async () => {
        const budget = await this.budget();
        const now = this.cache.clock();
        if (budget.blockedUntil > now)
          throw new TrafficBackoff(budget.blockedUntil, "GitHub traffic reads backed off");
        if (budget.used >= this.perHour)
          throw new TrafficBackoff(
            budget.windowAt + 3600000,
            "Hourly traffic read budget exhausted",
          );
        if (this.cycle >= this.perCycle)
          throw new TrafficBackoff(now + 60000, "Per-cycle traffic read budget exhausted");
        budget.used++;
        this.cycle++;
        await this.cache.put("read-budget", budget, null);
        let response: Response;
        try {
          response = await transport(input, init);
        } catch {
          throw new TrafficBackoff(
            this.cache.clock() + 60000,
            "GitHub traffic read transport unavailable",
          );
        }
        const responseAt = this.cache.clock();
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (
          response.status === 429 ||
          response.status === 403 ||
          (remaining !== null && Number(remaining) < this.remainingFloor)
        ) {
          const latest = await this.budget();
          const retry = Number(response.headers.get("retry-after"));
          const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
          latest.failures++;
          latest.blockedUntil = Math.max(
            responseAt + Math.min(3600, 60 * 2 ** Math.min(6, latest.failures - 1)) * 1000,
            Number.isFinite(retry) ? responseAt + Math.max(0, retry) * 1000 : 0,
            Number.isFinite(reset) ? Math.min(responseAt + 3600000, reset) : 0,
          );
          await this.cache.put("read-budget", latest, null);
          if (!response.ok)
            throw new TrafficBackoff(
              latest.blockedUntil,
              "GitHub rate/permission response; bounded backoff",
            );
        }
        return response;
      });
      this.tail = operation.then(
        () => {},
        () => {},
      );
      return operation;
    }) as typeof fetch;
  }
}
export class CachedTrafficReader extends GitHubReader {
  constructor(
    settings: Config,
    auth: GitHubAuth,
    transport: typeof fetch,
    readonly trafficCache: TrafficCache,
  ) {
    super(settings, auth, transport);
  }
  override async get(path: string): ReturnType<GitHubReader["get"]> {
    const key = `get:${this.config.repository}:${path}`;
    const cached = await this.trafficCache.get<Awaited<ReturnType<GitHubReader["get"]>>>(key);
    if (cached !== null) return cached;
    const value = await super.get(path);
    const jobs = !Array.isArray(value) && Array.isArray(value.jobs) ? value.jobs : null;
    const attemptPath = /^(actions\/runs\/(\d+)\/attempts\/(\d+))\/jobs\?/.exec(path);
    let immutable = false;
    if (
      attemptPath &&
      jobs !== null &&
      jobs.length > 0 &&
      jobs.every((j) => j.status === "completed")
    ) {
      // Completed jobs alone do not prove later jobs cannot appear in this attempt.
      const attempt = await this.get(attemptPath[1]!);
      immutable =
        !Array.isArray(attempt) &&
        attempt.status === "completed" &&
        attempt.id === Number(attemptPath[2]) &&
        attempt.run_attempt === Number(attemptPath[3]);
    } else if (/^actions\/runs\/\d+\/attempts\/\d+$/.test(path) && !Array.isArray(value)) {
      immutable = value.status === "completed";
    }
    await this.trafficCache.put(key, value, immutable ? null : 300);
    return value;
  }
  async fresh(path: string) {
    return super.get(path);
  }
  override async resultArtifact(
    manifest: Manifest,
    runId: number,
    attempt: number,
  ): Promise<VerifiedResult | null> {
    const key = `result:${this.config.repository}:${manifest.batchId}:${manifest.tipSha}:${runId}:${attempt}`;
    const cached = await this.trafficCache.get<VerifiedResult>(key);
    if (cached) return cached;
    const result = await super.resultArtifact(manifest, runId, attempt);
    if (result && result.outcome !== "infrastructure" && result.outcome !== "unknown")
      await this.trafficCache.put(key, result, null);
    return result;
  }
}
export interface Headroom {
  allowed: boolean;
  reason: string;
  occupied: number;
  reservedMain: number;
  candidateSlots: number;
  budget: number | null;
  scannedRuns?: number;
  approvalOnlyRuns?: number;
  capacity?: CapacityObservation;
}
const TRAFFIC_CAPACITY_HOLD_REASONS: Record<CapacityHold, string> = {
  "main-pre-fanout": "A full-main CI run has not instantiated its fan-out yet",
  "main-queued": "A full-main CI run has jobs waiting for hosted runners",
  "repository-budget": "Insufficient full-main runner headroom",
  "provider-limit":
    "Repository jobs plus other-repository allowance and 18 candidate slots exceed the hosted job limit",
  "invalid-capacity": "Invalid hosted job limit or other-repository allowance",
};
/**
 * Parses an optional non-negative integer capacity setting. Unset uses the
 * documented default; anything else that is not a safe integer becomes NaN,
 * which `capacityDecision` rejects (fail closed, no publication).
 */
export function capacitySetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return raw.trim() !== "" && Number.isSafeInteger(n) && n >= 0 ? n : Number.NaN;
}
const TRAFFIC_HEADROOM_HOLD_REASONS: Record<RunnerScanHold, string> = {
  "incomplete-runs": "Runner observation exceeds bounded scan or is incomplete",
  // A non-object run entry; malformed run IDs throw in the validator below.
  "invalid-run": "Invalid active run identity",
  "batch-slot": "Another Batch CI run already occupies hosted headroom",
  "scan-bound": `Runner observation exceeds bounded scan of ${MAX_SCANNED_ACTIVE_RUNS} active runs`,
  "runner-run-bound": `Too many active workflows for bounded runner observation (over ${MAX_RUNNER_RELEVANT_RUNS} excluding proven approval-only runs)`,
  "incomplete-jobs": "Active job scan incomplete; no publication",
  "unknown-job-status": "Unrecognized job status in active job scan; no publication",
  deadline: "Runner observation exceeded its scan deadline; no publication",
};
export async function readHeadroom(
  reader: Pick<CachedTrafficReader, "fresh">,
  runnerBudget: number | undefined,
  mainReserve: number | undefined,
  now?: () => number,
  capacity: { providerJobLimit?: number; otherRepositoryAllowance?: number } = {},
): Promise<Headroom> {
  const result: Headroom = {
    allowed: false,
    reason: "Configure an allocated repository runner budget and full-main reserve",
    occupied: 0,
    reservedMain: mainReserve ?? 0,
    candidateSlots: 18,
    budget: runnerBudget ?? null,
  };
  if (
    !runnerBudget ||
    !mainReserve ||
    !Number.isSafeInteger(runnerBudget) ||
    !Number.isSafeInteger(mainReserve) ||
    mainReserve < 1
  )
    return result;
  const scan = await scanRunnerDemand({
    get: (path) => reader.fresh(path),
    batchWorkflow: ".github/workflows/batch-ci.yml",
    baseBranch: "main",
    // Malformed provider run identities remain a hard error, as before.
    runId: positive,
    ...(now ? { now } : {}),
  });
  result.scannedRuns = scan.scannedRuns;
  result.approvalOnlyRuns = scan.approvalOnlyRuns;
  if (!scan.ok) return { ...result, reason: TRAFFIC_HEADROOM_HOLD_REASONS[scan.hold] };
  const { mainDemand: mainBusy, otherDemand: otherBusy } = scan;
  result.occupied = mainBusy + otherBusy;
  const decision = capacityDecision({
    mainDemand: mainBusy,
    otherDemand: otherBusy,
    latestMain: scan.latestMain,
    mainQueuedJobs: scan.mainQueuedJobs,
    preFanoutMainRuns: scan.preFanoutMainRuns,
    runnerBudget,
    mainReserve,
    providerJobLimit: capacity.providerJobLimit ?? DEFAULT_PROVIDER_JOB_LIMIT,
    otherRepositoryAllowance:
      capacity.otherRepositoryAllowance ?? DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
  });
  result.reservedMain = decision.reservedMain;
  result.capacity = decision.capacity;
  result.allowed = decision.allowed;
  result.reason = decision.capacity.hold
    ? TRAFFIC_CAPACITY_HOLD_REASONS[decision.capacity.hold]
    : "Configured full-main reserve fits after current repository demand and 18 candidate slots";
  return result;
}
interface PublicationRecord {
  tipSha: string;
  publishedAt: string;
  status: "pending" | "terminal" | "blocked" | "recovered";
  run?: Run;
  recoveryReason?: string;
}
interface TrafficLedger extends Ledger {
  trafficShadow: {
    kind: "merged-traffic-shadow";
    published: string[];
    publishedBindings: string[];
    records?: Record<string, PublicationRecord>;
    settled?: Record<string, string>;
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
  action: "published" | "wait" | "recovered";
  reason: string;
  batchId: string | null;
  comparisons: ReturnType<typeof compareOutcome>[];
  quarantined: { ref: string; sha: string; reason: string }[];
  quarantineCount: number;
  recoveryRequired: string[];
  headroom: Headroom | null;
}
export class TrafficPublisher extends QueueOnlyPublisher {
  async saveState(expected: string | null, next: string): Promise<void> {
    if (this.config.stateRef !== TRAFFIC_STATE || this.config.branchPrefix !== TRAFFIC_PREFIX)
      throw new Error("Traffic state namespace required");
    await this.writer.transaction([{ ref: TRAFFIC_STATE, expected, next }]);
  }
}
export interface PublicationOptions {
  now?: string;
  noRunHoldSeconds?: number;
  maxScans?: number;
  historyLimit?: number;
  cache?: TrafficCache;
  headroom?: () => Promise<Headroom>;
  recoverNoRun?: { batchId: string; reason: string };
}
/** Only this optional adapter receives a publisher. Read-only replay cannot push. */
export async function publishOneTraffic(
  settings: Config,
  git: GitStore,
  reader: Pick<GitHubReader, "runs">,
  remote: string,
  report: TrafficReport,
  publisher: CandidatePublisher & {
    saveState?: (expected: string | null, next: string) => Promise<void>;
  },
  options: PublicationOptions = {},
): Promise<TrafficPublication> {
  if (
    settings.mode !== "shadow-ci" ||
    settings.branchPrefix !== TRAFFIC_PREFIX ||
    settings.stateRef !== TRAFFIC_STATE ||
    settings.baseBranch !== "main" ||
    settings.maxInflight !== 1
  )
    throw new Error("Restricted traffic publication configuration required");
  const refs = await git.remoteRefs(remote);
  const stateSha = refs.get(TRAFFIC_STATE) ?? null;
  const now = timestamp(options.now ?? new Date().toISOString());
  const holdSeconds = options.noRunHoldSeconds ?? 600,
    maxScans = options.maxScans ?? 32,
    historyLimit = options.historyLimit ?? 32;
  if (
    !Number.isSafeInteger(holdSeconds) ||
    holdSeconds < 1 ||
    !Number.isSafeInteger(maxScans) ||
    maxScans < 1 ||
    maxScans > 100 ||
    !Number.isSafeInteger(historyLimit) ||
    historyLimit < 1 ||
    historyLimit > 100
  )
    throw new Error("Invalid traffic hold/scan policy");
  const cache = options.cache ?? new TrafficCache(join(settings.outputDir, "traffic-cache"));
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
  const records = (ledger.trafficShadow.records ??= {});
  const settled = (ledger.trafficShadow.settled ??= {});
  for (const [id, record] of Object.entries(records)) {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !record ||
      !["pending", "blocked", "terminal", "recovered"].includes(record.status)
    )
      throw new Error("Malformed traffic publication record");
    assertSha(record.tipSha);
    timestamp(record.publishedAt);
  }
  for (const [id, sha] of Object.entries(settled)) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Malformed traffic settled identity");
    assertSha(sha);
  }
  const original = canonical(ledger);
  const seen = new Set(ledger.trafficShadow.published),
    comparisons: ReturnType<typeof compareOutcome>[] = [];
  const seenBindings = new Set(ledger.trafficShadow.publishedBindings);
  const quarantined: TrafficPublication["quarantined"] = [],
    recoveryRequired: string[] = [];
  let occupied = false,
    scans = 0,
    deferred = 0,
    quarantineCount = 0;
  const observed = new Set<string>();
  let headroom: Headroom | null = null;
  const quarantine = (ref: string, sha: string, reason: string) => {
    quarantineCount++;
    if (quarantined.length < historyLimit) quarantined.push({ ref, sha, reason });
  };
  const getHeadroom = async () =>
    (headroom ??= options.headroom
      ? await options.headroom()
      : {
          allowed: false,
          reason: "Full-main headroom observation not configured",
          occupied: 0,
          reservedMain: 0,
          candidateSlots: 18,
          budget: null,
        });
  let recovered: string | null = null;
  for (const [ref, sha] of refs) {
    if (!ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)) continue;
    const id = ref.slice(`refs/heads/${TRAFFIC_PREFIX}`.length);
    if (!/^[a-f0-9]{64}$/.test(id)) {
      quarantine(ref, sha, "Malformed traffic ref name");
      continue;
    }
    if (settled[id]) {
      if (settled[id] !== sha) quarantine(ref, sha, "Settled ref changed SHA; excluded");
      const cohort = report.cohorts.find((c) => c.manifest?.batchId === id);
      if (cohort && records[id]?.run && comparisons.length < historyLimit)
        comparisons.push(compareOutcome(cohort, records[id]!.run));
      continue;
    }
    const badKey = `quarantine:${settings.repository}:${ref}:${sha}`;
    const bad = await cache.get<string>(badKey);
    if (bad) {
      quarantine(ref, sha, bad);
      continue;
    }
    if (scans >= maxScans) {
      deferred++;
      continue;
    }
    scans++;
    let manifest: Manifest;
    try {
      const key = `manifest:${sha}`;
      const cached = await cache.get<Manifest>(key);
      if (cached) manifest = cached;
      else {
        await git.fetch(remote, [sha]);
        manifest = await git.inspect(sha);
        await cache.put(key, manifest, null);
      }
      if (ref !== `refs/heads/${TRAFFIC_PREFIX}${manifest.batchId}` || manifest.tipSha !== sha)
        throw new Error("Traffic candidate ref/manifest mismatch");
    } catch (error) {
      const reason =
        error instanceof GitFailure
          ? "Traffic ref Git inspection unavailable; quarantined"
          : "Malformed traffic manifest; quarantined";
      await cache.put(badKey, reason, error instanceof GitFailure ? 300 : null);
      quarantine(ref, sha, reason);
      continue;
    }
    seen.add(manifest.batchId);
    for (const pull of manifest.pulls) seenBindings.add(pull.binding.evidenceDigest);
    const record = (records[id] ??= { tipSha: sha, publishedAt: now, status: "pending" });
    if (record.tipSha !== sha) {
      quarantine(ref, sha, "Publication record SHA mismatch");
      continue;
    }
    const runs = await reader.runs(manifest, ref.slice("refs/heads/".length));
    observed.add(id);
    if (!runs.length) {
      if (Date.parse(now) - Date.parse(record.publishedAt) >= holdSeconds * 1000) {
        record.status = "blocked";
        recoveryRequired.push(id);
        if (
          options.recoverNoRun?.batchId === id &&
          options.recoverNoRun.reason.trim().length >= 8 &&
          (await getHeadroom()).allowed
        ) {
          record.status = "recovered";
          record.recoveryReason = options.recoverNoRun.reason.trim().slice(0, 2000);
          settled[id] = sha;
          recovered = id;
        } else occupied = true;
      } else occupied = true;
    } else if (runs.some((r) => r.status !== "completed")) occupied = true;
    else {
      record.status = "terminal";
      record.run = [...runs].sort((a, b) => b.id - a.id || b.attempt - a.attempt)[0]!;
      settled[id] = sha;
    }
    const cohort = report.cohorts.find((c) => c.manifest?.batchId === manifest.batchId);
    if (cohort && comparisons.length < historyLimit)
      comparisons.push(
        compareOutcome(cohort, [...runs].sort((a, b) => b.id - a.id || b.attempt - a.attempt)[0]),
      );
  }
  for (const [id, record] of Object.entries(records)) {
    if (
      settled[id] ||
      (observed.has(id) && refs.get(`refs/heads/${TRAFFIC_PREFIX}${id}`) === record.tipSha)
    )
      continue;
    record.status = "blocked";
    if (!recoveryRequired.includes(id)) recoveryRequired.push(id);
    // A disappeared/retargeted known publication is not proof that its CI stopped.
    occupied = true;
  }
  ledger.trafficShadow.published = [...seen].sort();
  ledger.trafficShadow.publishedBindings = [...seenBindings].sort();
  const terminalRecords = Object.entries(records)
    .filter(([, record]) => ["terminal", "recovered"].includes(record.status))
    .sort((a, b) => b[1].publishedAt.localeCompare(a[1].publishedAt));
  for (const [id] of terminalRecords.slice(historyLimit)) delete records[id];
  const result = (
    action: TrafficPublication["action"],
    reason: string,
    batchId: string | null,
  ): TrafficPublication => ({
    action,
    reason,
    batchId,
    comparisons,
    quarantined,
    quarantineCount,
    recoveryRequired,
    headroom,
  });
  const state = async () => {
    // Identical next OIDs make Git omit the ref update before checking its
    // lease. Each transaction must therefore have a distinct changing fence,
    // even when concurrent publishers observe the same clock and candidate.
    ledger = {
      ...ledger,
      epoch: ledger.epoch + 1,
      owner: `merged-traffic-shadow:${randomUUID()}`,
      expiresAt: now,
    };
    return git.stateCommit(ledger, stateSha, now);
  };
  const wait = async (reason: string): Promise<TrafficPublication> => {
    if (canonical(ledger) !== original) {
      if (!publisher.saveState) throw new Error("State-only traffic CAS adapter required");
      await publisher.saveState(stateSha, await state());
    }
    return result(recovered ? "recovered" : "wait", reason, recovered);
  };
  if (recovered)
    return wait(
      "Explicit no-run infrastructure recovery recorded; no candidate published in this observation",
    );
  if (options.recoverNoRun)
    return wait(
      "Recovery not eligible: require expired no-run hold, explicit reason and fresh full-main headroom; never cancel a valid run",
    );
  if (deferred)
    return wait(
      `Bounded ref scan deferred ${deferred} candidates; no publication until observations complete`,
    );
  if (occupied)
    return wait(
      recoveryRequired.length
        ? "No-run infrastructure hold expired; explicit recovery required, never automatic cancellation or resubmission"
        : "One hosted traffic candidate slot occupied; bounded no-run hold and no cancellation",
    );
  const pending = report.cohorts.filter(
    (c) =>
      c.manifest &&
      !seen.has(c.manifest.batchId) &&
      c.manifest.pulls.every((p) => !seenBindings.has(p.binding.evidenceDigest)),
  );
  const chosen = pending.find((c) => c.adapterReady);
  if (!chosen?.manifest)
    return wait(
      pending.length
        ? "Waiting for a viable cohort whose pre-cohort base already contains the unchanged adapter; no overlays"
        : "No unseen candidates; restart deduplication retained",
    );
  // Recompute instead of trusting a saved report and recheck refs before CAS.
  if (
    canonical(await git.inspect(chosen.manifest.tipSha)) !== canonical(chosen.manifest) ||
    !(await adapterPresent(git, chosen.manifest.baseSha, chosen.manifest.tipSha))
  )
    throw new Error("Traffic manifest/adapter changed");
  if (!(await getHeadroom()).allowed) return wait(headroom!.reason);
  const fresh = await git.remoteRefs(remote);
  if (
    (fresh.get(TRAFFIC_STATE) ?? null) !== stateSha ||
    canonical(
      [...fresh].filter(([ref]) => ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)).sort(),
    ) !==
      canonical([...refs].filter(([ref]) => ref.startsWith(`refs/heads/${TRAFFIC_PREFIX}`)).sort())
  )
    return wait("CAS snapshot changed; re-observe");
  ledger.trafficShadow.published = [...seen, chosen.manifest.batchId].sort();
  ledger.trafficShadow.publishedBindings = [
    ...seenBindings,
    ...chosen.manifest.pulls.map((p) => p.binding.evidenceDigest),
  ].sort();
  records[chosen.manifest.batchId] = {
    tipSha: chosen.manifest.tipSha,
    publishedAt: now,
    status: "pending",
  };
  const nextSha = await state();
  await publisher.publish(stateSha, nextSha, chosen.manifest);
  return result(
    "published",
    chosen.equivalent
      ? "Queue-only candidate with reserved full-main headroom"
      : "Queue-only viable remainder with reserved headroom; historical outcome is NOT equivalent",
    chosen.manifest.batchId,
  );
}

export const TRAFFIC_LOG_LIMIT_BYTES = 2 * 1024 * 1024;
export const TRAFFIC_LOG_CHUNK_BYTES = 64 * 1024;

/** Existing structured stdout sinks provide retention; this performs no cloud API writes.
 * The supervisor must emit these records: it deliberately discards child stdout.
 * Encoding prevents embedded newlines from impersonating separate log entries.
 */
export function trafficEvidenceRecords(evidence: TrafficReport & { publication?: unknown }) {
  const bytes = Buffer.from(canonical(evidence));
  const reportDigest = digest(evidence);
  if (bytes.length > TRAFFIC_LOG_LIMIT_BYTES)
    return [
      {
        event: "traffic_report_overflow",
        reportDigest,
        bytes: bytes.length,
        limitBytes: TRAFFIC_LOG_LIMIT_BYTES,
        fullReportRetained: false,
      },
    ];
  const chunks = Math.ceil(bytes.length / TRAFFIC_LOG_CHUNK_BYTES);
  return Array.from({ length: chunks }, (_, index) => ({
    event: "traffic_report_chunk",
    reportDigest,
    observedAt: evidence.observedAt,
    index,
    chunks,
    bytes: bytes.length,
    encoding: "base64-json",
    data: bytes
      .subarray(index * TRAFFIC_LOG_CHUNK_BYTES, (index + 1) * TRAFFIC_LOG_CHUNK_BYTES)
      .toString("base64"),
  }));
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
      "recover-no-run": { type: "string" },
      "recovery-reason": { type: "string" },
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
  const cache = new TrafficCache(join(output, "traffic-cache"));
  const control = new TrafficReadControl(cache);
  const transport = control.wrap(fetch);
  const auth = new GitHubAuth({ ...env, BATCHER_MODE: mode }, transport);
  const reader = new CachedTrafficReader(settings, auth, transport, cache),
    remote = `https://github.com/${settings.repository}.git`;
  const recoverNoRun = values["recover-no-run"]
    ? { batchId: values["recover-no-run"], reason: values["recovery-reason"] ?? "" }
    : undefined;
  if (
    recoverNoRun &&
    (mode !== "shadow-ci" ||
      !/^[a-f0-9]{64}$/.test(recoverNoRun.batchId) ||
      recoverNoRun.reason.trim().length < 8)
  )
    throw new Error(
      "Explicit CI-shadow recovery requires a full batch ID and infrastructure-idle reason",
    );
  const once = values.once || env.TRAFFIC_SHADOW_ONCE === "true" || !!recoverNoRun;
  let stopping = false;
  let failures = 0;
  const isStopping = () => stopping;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      let sleepSeconds = Math.max(60, settings.pollSeconds);
      control.beginCycle();
      try {
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
                new TrafficPublisher(
                  settings,
                  new AtomicGitWriter(git, remote, TRAFFIC_STATE, "refs/heads/main"),
                ),
                {
                  cache,
                  ...(recoverNoRun ? { recoverNoRun } : {}),
                  headroom: () =>
                    readHeadroom(
                      reader,
                      Number(env.TRAFFIC_SHADOW_RUNNER_BUDGET) || undefined,
                      Number(env.TRAFFIC_SHADOW_MAIN_RESERVE) || undefined,
                      undefined,
                      {
                        providerJobLimit: capacitySetting(
                          env.TRAFFIC_SHADOW_PROVIDER_JOB_LIMIT,
                          DEFAULT_PROVIDER_JOB_LIMIT,
                        ),
                        otherRepositoryAllowance: capacitySetting(
                          env.TRAFFIC_SHADOW_OTHER_REPOSITORY_ALLOWANCE,
                          DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
                        ),
                      },
                    ),
                },
              )
            : null;
        await mkdir(output, { recursive: true });
        const filename = join(output, `traffic-${until.replaceAll(":", "-")}.json`);
        const evidence = {
          ...report,
          publication,
          readPolicy: {
            mutableCacheSeconds: 300,
            perCycle: 200,
            perHour: 600,
            sharedQuotaRemainingFloor: 1000,
            cachedSnapshotsMayLag: true,
          },
        };
        await writeFile(filename, canonical(evidence) + "\n", { mode: 0o600 });
        const temporary = join(output, `latest.${process.pid}.tmp`);
        await writeFile(temporary, canonical(evidence) + "\n", { mode: 0o600 });
        await rename(temporary, join(output, "latest.json"));
        console.log(
          JSON.stringify({
            file: filename,
            counts: report.counts,
            timingsMilliseconds: report.timingsMilliseconds,
            publication,
          }),
        );
        failures = 0;
        await cache.prune();
      } catch (error) {
        if (once) throw error;
        failures++;
        sleepSeconds = Math.max(
          sleepSeconds,
          error instanceof TrafficBackoff
            ? Math.ceil((error.retryAt - Date.now()) / 1000)
            : Math.min(900, 30 * 2 ** Math.min(failures, 5)),
        );
        await mkdir(output, { recursive: true });
        const failure = {
          observedAt: new Date().toISOString(),
          mode,
          retrySeconds: sleepSeconds,
          reason: error instanceof Error ? error.message : "Traffic observation failed",
          previousReportIsHistorical: true,
        };
        await writeFile(join(output, "observation-failure.json"), canonical(failure) + "\n", {
          mode: 0o600,
        });
        console.error(JSON.stringify(failure));
      }
      if (once) break;
      for (let i = 0; i < sleepSeconds && !isStopping(); i++) await Bun.sleep(1000);
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
