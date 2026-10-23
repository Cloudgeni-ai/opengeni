import { createSign } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { validateExecutionPlan, type ExecutionPlan } from "./base-comparison";
import { admit, type Comment, type PullInput, type ReadyEvent } from "./evidence";
import {
  type Config,
  type Manifest,
  type Outcome,
  type Pull,
  type Run,
  type Headroom,
  type FollowupRequest,
  type FollowupPull,
  type BaseCiEvidence,
} from "./model";
import { verifyResult, type VerifiedResult } from "./result";
import type { MainOutcome } from "./shadow-ci";
import { join } from "node:path";
import { DiskCache } from "./cache";
import {
  capacityDecision,
  type CapacityHold,
  digest,
  MAX_RUNNER_RELEVANT_RUNS,
  MAX_SCANNED_ACTIVE_RUNS,
  scanRunnerDemand,
  type RunnerScanHold,
} from "./model";

type Json = Record<string, any>; // Wire JSON is checked at the adapter boundary, not trusted as domain state.
const HEADROOM_HOLD_REASONS: Record<RunnerScanHold, string> = {
  "incomplete-runs": "Incomplete or oversized active workflow observation",
  "invalid-run": "Invalid active run identity",
  "batch-slot": "Another Batch CI run occupies the single candidate slot",
  "scan-bound": `Active workflows exceed the bounded ${MAX_SCANNED_ACTIVE_RUNS}-run job scan`,
  "runner-run-bound": `Active workflows exceed bounded ${MAX_RUNNER_RELEVANT_RUNS}-run observation (excluding proven approval-only runs)`,
  "incomplete-jobs": "Incomplete or oversized current job observation",
  "unknown-job-status": "Unrecognized job status in current job observation",
  deadline: "Active workflow observation exceeded its scan deadline",
};
const CAPACITY_HOLD_REASONS: Record<CapacityHold, string> = {
  "main-pre-fanout": "A full-main CI run has not instantiated its fan-out yet",
  "main-queued": "A full-main CI run has jobs waiting for hosted runners",
  "repository-budget": "Insufficient observed runner headroom after full-main reserve",
  "provider-limit":
    "Observed repository jobs plus other-repository allowance and 18 candidate slots exceed the hosted job limit",
  "invalid-capacity": "Invalid hosted job limit or other-repository allowance",
};
export function isControlPlanePath(path: unknown): boolean {
  return (
    typeof path === "string" &&
    (path === ".github/workflows/batch-ci.yml" ||
      path.startsWith("scripts/ci/batch-") ||
      path.startsWith("scripts/merge-batcher/") ||
      /^scripts\/ci\/(?:impact|run-unit-shard|profile-command|shared-pg)(?:[./-]|$)/.test(path) ||
      path === ".bun-version" ||
      path === "packages/testing/src/shared-pg.ts")
  );
}
export interface PullSnapshot {
  number: number;
  headSha: string;
  branchHeadSha: string | null;
  headRef: string;
  headRepository: string | null;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha?: string | null;
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(`GitHub ${operation} failed (${status}); response body suppressed`);
  }
}
export class GitHubAuth {
  private cached: { token: string; expires: number } | null = null;
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async token(): Promise<string> {
    if (this.env.GH_TOKEN) return this.env.GH_TOKEN;
    if (this.env.GITHUB_TOKEN) return this.env.GITHUB_TOKEN;
    if (this.cached && this.cached.expires > Date.now() + 60_000) return this.cached.token;
    const {
      GITHUB_APP_ID: app,
      GITHUB_APP_INSTALLATION_ID: installation,
      GITHUB_APP_PRIVATE_KEY: key,
    } = this.env;
    if (!app || !installation || !key) return "";
    if (!/^\d+$/.test(app) || !/^\d+$/.test(installation))
      throw new Error("Invalid GitHub App configuration");
    const now = Math.floor(Date.now() / 1000);
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const message = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: app })}`;
    const signature = createSign("RSA-SHA256").update(message).sign(key, "base64url");
    // Authentication only; repository mutation permissions are NOT requested in shadow.
    const permissions =
      this.env.BATCHER_MODE === "active"
        ? {
            contents: "write",
            workflows: "write",
            actions: "write",
            pull_requests: "write",
            issues: "write",
          }
        : this.env.BATCHER_MODE === "shadow-ci"
          ? {
              contents: "write",
              workflows: "write",
              actions: "read",
              pull_requests: "read",
              issues: "read",
            }
          : { contents: "read", actions: "read", pull_requests: "read", issues: "read" };
    const response = await this.transport(
      `https://api.github.com/app/installations/${installation}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${message}.${signature}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ permissions }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new ProviderError(response.status, "App authentication");
    const data = (await response.json()) as Json;
    if (typeof data.token !== "string" || !Number.isFinite(Date.parse(data.expires_at)))
      throw new Error("Invalid App token response");
    this.cached = { token: data.token, expires: Date.parse(data.expires_at) };
    return this.cached.token;
  }
  async gitEnv(): Promise<Record<string, string>> {
    const token = await this.token();
    return token
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }
      : {};
  }
}

// Only GET and GraphQL query operations exist on this class. The shadow runner
// receives this read adapter, never the mutation adapter.
export class GitHubReader {
  lastHeadroom: Headroom | null = null;
  readonly cache: DiskCache;
  private blockedUntil = 0;
  constructor(
    readonly config: Config,
    readonly auth: GitHubAuth,
    readonly transport: typeof fetch = fetch,
  ) {
    this.cache = new DiskCache(
      join(config.outputDir, `provider-cache-${digest(config.repository)}.json`),
    );
  }
  private checkRateLimit(response: Response): void {
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    ) {
      const seconds = Math.min(
        3600,
        Math.max(
          60,
          Number(response.headers.get("retry-after")) ||
            Number(response.headers.get("x-ratelimit-reset")) - Date.now() / 1000 ||
            300,
        ),
      );
      this.blockedUntil = Date.now() + seconds * 1000;
      throw new ProviderError(response.status, "rate limited read", Math.ceil(seconds));
    }
  }
  async get(path: string): Promise<Json | Json[]> {
    return this.getFromRepository(this.config.repository, path);
  }
  async getFromRepository(repository: string, path: string): Promise<Json | Json[]> {
    if (Date.now() < this.blockedUntil)
      throw new ProviderError(
        429,
        "read backoff",
        Math.ceil((this.blockedUntil - Date.now()) / 1000),
      );
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid source repository");
    const token = await this.auth.token();
    const response = await this.transport(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    this.checkRateLimit(response);
    if (!response.ok) throw new ProviderError(response.status, "read");
    return response.json() as Promise<Json | Json[]>;
  }
  async pages(path: string, key?: string): Promise<Json[]> {
    const all: Json[] = [];
    for (let page = 1; page <= 1000; page++) {
      const data = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const list: unknown = key ? (data as Json)[key] : data;
      if (!Array.isArray(list)) throw new Error("Malformed GitHub page");
      all.push(...list);
      if (list.length < 100) return all;
    }
    throw new Error("GitHub pagination incomplete; refusing partial observation");
  }
  async pullSnapshot(number: number): Promise<PullSnapshot> {
    const pull = (await this.get(`pulls/${number}`)) as Json;
    const repository =
      typeof pull.head?.repo?.full_name === "string" ? pull.head.repo.full_name : null;
    let branchHeadSha: string | null = null;
    if (repository && typeof pull.head?.ref === "string") {
      try {
        const ref = (await this.getFromRepository(
          repository,
          `git/ref/heads/${encodeURIComponent(pull.head.ref)}`,
        )) as Json;
        if (/^[a-f0-9]{40}$/.test(ref.object?.sha)) branchHeadSha = ref.object.sha;
      } catch (error) {
        if (!(error instanceof ProviderError && error.status === 404)) throw error;
      }
    }
    if (!/^[a-f0-9]{40}$/.test(pull.head?.sha) || !["open", "closed"].includes(pull.state))
      throw new Error("Invalid pull snapshot");
    return {
      number,
      headSha: pull.head.sha,
      branchHeadSha,
      headRef: pull.head.ref,
      headRepository: repository,
      state: pull.state,
      merged: Boolean(pull.merged),
      mergeCommitSha: /^[a-f0-9]{40}$/.test(pull.merge_commit_sha) ? pull.merge_commit_sha : null,
    };
  }
  async hasComment(number: number, marker: string): Promise<boolean> {
    return (await this.pages(`issues/${number}/comments`)).some(
      (comment) => typeof comment.body === "string" && comment.body.includes(marker),
    );
  }
  async currentAttempt(run: Run): Promise<{ attempt: number; status: string }> {
    const data = (await this.get(`actions/runs/${run.id}`)) as Json;
    if (
      data.head_sha !== run.headSha ||
      data.head_branch !== run.branch ||
      data.path !== run.workflow ||
      data.event !== "push" ||
      Number(data.id) !== run.id ||
      !Number.isSafeInteger(data.run_attempt)
    )
      throw new Error("Retry run identity changed");
    return { attempt: data.run_attempt, status: data.status };
  }
  async mainBusy(): Promise<boolean> {
    this.lastHeadroom = await this.headroom();
    return !this.lastHeadroom.allowed;
  }
  async headroom(): Promise<Headroom> {
    const result: Headroom = {
      allowed: false,
      reason: "Configure allocated repository runner budget and full-main reserve",
      budget: this.config.runnerBudget,
      occupied: 0,
      reservedMain: this.config.mainReserve ?? 0,
      candidateSlots: 18,
    };
    if (!this.config.runnerBudget || !this.config.mainReserve) return result;
    const scan = await scanRunnerDemand({
      get: (path) => this.get(path),
      batchWorkflow: this.config.workflow,
      baseBranch: this.config.baseBranch,
    });
    result.scannedRuns = scan.scannedRuns;
    result.approvalOnlyRuns = scan.approvalOnlyRuns;
    if (!scan.ok) return { ...result, reason: HEADROOM_HOLD_REASONS[scan.hold] };
    const { mainDemand, otherDemand } = scan;
    result.mainDemand = mainDemand;
    result.occupied = mainDemand + otherDemand;
    const decision = capacityDecision({
      mainDemand,
      otherDemand,
      latestMain: scan.latestMain,
      mainQueuedJobs: scan.mainQueuedJobs,
      preFanoutMainRuns: scan.preFanoutMainRuns,
      runnerBudget: this.config.runnerBudget,
      mainReserve: this.config.mainReserve,
      providerJobLimit: this.config.providerJobLimit,
      otherRepositoryAllowance: this.config.otherRepositoryAllowance,
    });
    result.reservedMain = decision.reservedMain;
    result.capacity = decision.capacity;
    result.allowed = decision.allowed;
    result.reason = decision.capacity.hold
      ? CAPACITY_HOLD_REASONS[decision.capacity.hold]
      : "Observed jobs plus full-main reserve and 18 candidate slots fit the configured budget and hosted job limit";
    return result;
  }
  async findFollowup(request: FollowupRequest): Promise<FollowupPull | null> {
    const owner = request.sourceRepository.split("/")[0]!;
    const pulls = await this.pages(
      `pulls?state=all&base=${encodeURIComponent(this.config.baseBranch)}&head=${encodeURIComponent(`${owner}:${request.sourceRef}`)}`,
    );
    const matches = pulls.filter(
      (p) =>
        p.number !== request.original &&
        p.head?.repo?.full_name === request.sourceRepository &&
        p.head?.ref === request.sourceRef &&
        p.base?.ref === this.config.baseBranch &&
        /^[a-f0-9]{40}$/.test(p.head?.sha) &&
        Number.isSafeInteger(p.number) &&
        (p.state === "open" || p.state === "closed"),
    );
    const match =
      matches.find((p) => p.state === "open" && p.head.sha === request.headSha) ??
      matches.find((p) => p.state === "open") ??
      matches.find((p) => typeof p.body === "string" && p.body.includes(request.marker));
    return match
      ? {
          number: match.number,
          headSha: match.head.sha,
          state: match.state,
          merged: Boolean(match.merged_at ?? match.merged),
        }
      : null;
  }
  async timeline(number: number): Promise<ReadyEvent[]> {
    const [owner, name] = this.config.repository.split("/");
    const events: ReadyEvent[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const token = await this.auth.token();
      const response = await this.transport("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query ReadyTimeline($owner:String!,$name:String!,$number:Int!,$cursor:String) {
            repository(owner:$owner,name:$name) {
              pullRequest(number:$number) {
                timelineItems(first:100,after:$cursor,itemTypes:[AUTO_MERGE_ENABLED_EVENT,AUTO_MERGE_DISABLED_EVENT,LABELED_EVENT,UNLABELED_EVENT]) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    __typename
                    ... on AutoMergeEnabledEvent { id createdAt }
                    ... on AutoMergeDisabledEvent { id createdAt }
                    ... on LabeledEvent { id createdAt label { name } }
                    ... on UnlabeledEvent { id createdAt label { name } }
                  }
                }
              }
            }
          }`,
          variables: { owner, name, number, cursor },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      this.checkRateLimit(response);
      if (!response.ok) throw new ProviderError(response.status, "ready timeline");
      const data = (await response.json()) as Json;
      const timeline = data.data?.repository?.pullRequest?.timelineItems;
      if (data.errors || !timeline?.nodes || !timeline.pageInfo)
        throw new Error("Ready-event timeline unavailable");
      for (const node of timeline.nodes as Json[]) {
        const kind = node.__typename as string;
        if (kind === "AutoMergeEnabledEvent" || kind === "AutoMergeDisabledEvent")
          events.push({
            id: node.id,
            at: node.createdAt,
            source: "auto-merge",
            enabled: kind === "AutoMergeEnabledEvent",
          });
        if (
          (kind === "LabeledEvent" || kind === "UnlabeledEvent") &&
          node.label?.name === "queue-ready"
        )
          events.push({
            id: node.id,
            at: node.createdAt,
            source: "queue-ready",
            enabled: kind === "LabeledEvent",
          });
      }
      if (!timeline.pageInfo.hasNextPage) return events;
      if (typeof timeline.pageInfo.endCursor !== "string" || timeline.pageInfo.endCursor === cursor)
        throw new Error("Timeline pagination stalled");
      cursor = timeline.pageInfo.endCursor;
    }
    throw new Error("Timeline pagination incomplete");
  }
  async ready(): Promise<{ ready: Pull[]; excluded: { number: number; reason: string }[] }> {
    const pulls = await this.pages(
      `pulls?state=open&base=${encodeURIComponent(this.config.baseBranch)}`,
    );
    const ready: Pull[] = [],
      excluded: { number: number; reason: string }[] = [];
    for (const pull of pulls) {
      const number = Number(pull.number);
      const queueReady =
        Array.isArray(pull.labels) && pull.labels.some((l: Json) => l.name === "queue-ready");
      if (!pull.auto_merge && !queueReady) {
        excluded.push({ number, reason: "no ready signal" });
        continue;
      }
      let events: ReadyEvent[];
      try {
        events = await this.timeline(number);
      } catch (error) {
        // An unavailable/malformed per-PR timeline is an explicit admission exclusion.
        // Authentication/rate-limit failures abort the whole observation instead.
        if (error instanceof ProviderError) throw error;
        excluded.push({ number, reason: "actual ready-event timeline unavailable" });
        continue;
      }
      const comments = (await this.pages(`issues/${number}/comments`)).map(
        (x): Comment => ({
          id: String(x.id),
          body: x.body,
          updatedAt: x.updated_at,
          authorAssociation: x.author_association,
        }),
      );
      const files = await this.pages(`pulls/${number}/files`);
      const controlPlane = files.some((file) =>
        [file.filename, file.previous_filename].some(isControlPlanePath),
      );
      const input: PullInput = {
        controlPlane,
        number,
        headSha: pull.head?.sha ?? "",
        headRef: pull.head?.ref ?? "",
        draft: Boolean(pull.draft),
        autoMerge: Boolean(pull.auto_merge),
        queueReady,
        events,
        comments,
      };
      const admission = admit(input);
      if (admission.ready) ready.push(admission.ready);
      else excluded.push({ number, reason: admission.reason });
    }
    return { ready, excluded };
  }
  async runs(manifest: Manifest, branch: string): Promise<Run[]> {
    const raw = await this.pages(
      `actions/workflows/batch-ci.yml/runs?branch=${encodeURIComponent(branch)}&event=push`,
      "workflow_runs",
    );
    const result: Run[] = [];
    for (const run of raw) {
      if (
        run.head_sha !== manifest.tipSha ||
        run.head_branch !== branch ||
        run.path !== this.config.workflow ||
        run.event !== "push"
      )
        continue;
      const count = Number(run.run_attempt);
      if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
        throw new Error("Invalid workflow attempt count");
      for (let attempt = 1; attempt <= count; attempt++) {
        // Preserve immutable green-cache compatibility; old negative cache
        // entries did not carry the positive infrastructure-only retry evidence.
        const key = `verified:${manifest.tipSha}:${manifest.batchId}:${run.id}:${attempt}`;
        const cached = await this.cache.get<{
          run: Run;
          conclusion: unknown;
          retryPolicyVersion?: number;
        }>(key);
        if (
          cached &&
          (cached.run.outcome === "success" || cached.retryPolicyVersion === 2) &&
          (attempt < count || (run.status === "completed" && cached.conclusion === run.conclusion))
        ) {
          result.push(cached.run);
          continue;
        }
        const details =
          attempt === count
            ? run
            : ((await this.get(`actions/runs/${run.id}/attempts/${attempt}`)) as Json);
        const exact =
          details.head_sha === manifest.tipSha &&
          details.head_branch === branch &&
          details.path === this.config.workflow &&
          details.event === "push" &&
          Number(details.run_attempt) === attempt &&
          Number(details.id) === Number(run.id);
        if (!exact) continue;
        const status =
          details.status === "completed"
            ? "completed"
            : details.status === "in_progress"
              ? "in_progress"
              : "queued";
        let outcome: Outcome = details.conclusion === "cancelled" ? "cancelled" : "infrastructure";
        let trusted = false;
        let retryable = false;
        let infrastructureRetryReason: Run["infrastructureRetryReason"];
        if (status === "completed" && details.conclusion !== "cancelled") {
          const attested = await this.resultArtifact(manifest, Number(run.id), attempt);
          if (
            attested &&
            details.conclusion !== "cancelled" &&
            (attested.outcome !== "success" || details.conclusion === "success") &&
            (attested.outcome !== "code_failure" || details.conclusion === "failure")
          ) {
            outcome = attested.outcome;
            retryable = attested.retryable;
            trusted = true;
            if (outcome === "infrastructure" && attested.infrastructureOnly === true)
              infrastructureRetryReason = "verified-infrastructure";
          }
        }
        if (
          status === "completed" &&
          !trusted &&
          ["cancelled", "infrastructure"].includes(outcome)
        ) {
          // An invalid/ambiguous result artifact is never equivalent to no logs.
          const artifacts = await this.pages(`actions/runs/${run.id}/artifacts`, "artifacts");
          if (!artifacts.some((a) => a.name === `batch-result-${attempt}`)) {
            const jobs = await this.pages(
              `actions/runs/${run.id}/attempts/${attempt}/jobs`,
              "jobs",
            );
            if (
              jobs.every(
                (j) =>
                  j.status === "completed" &&
                  ["success", "cancelled", "skipped", "neutral"].includes(j.conclusion),
              )
            ) {
              if (outcome === "cancelled") infrastructureRetryReason = "provider-cancelled";
              else if (
                jobs.every(
                  (j) => j.started_at === null && Array.isArray(j.steps) && j.steps.length === 0,
                )
              )
                infrastructureRetryReason = "no-job-logs";
            }
          }
        }
        const verifiedRun: Run = {
          id: Number(run.id),
          attempt,
          headSha: manifest.tipSha,
          branch,
          workflow: this.config.workflow,
          status,
          outcome,
          trusted,
          retryable,
          ...(infrastructureRetryReason ? { infrastructureRetryReason } : {}),
          startedAt: details.run_started_at ?? null,
          completedAt: status === "completed" ? details.updated_at : null,
        };
        result.push(verifiedRun);
        if (status === "completed" && (trusted || outcome === "cancelled"))
          await this.cache.set(key, {
            run: verifiedRun,
            conclusion: details.conclusion,
            ...(verifiedRun.outcome === "success" ? {} : { retryPolicyVersion: 2 }),
          });
      }
    }
    return result;
  }
  async observedRuns(
    manifest: Manifest,
    branch: string,
    archived: boolean,
    allowRefresh = true,
  ): Promise<Run[]> {
    const key = `observation:${manifest.tipSha}:${branch}`;
    const cached = await this.cache.get<Run[]>(key, 900_000);
    // Empty histories need the same backoff as terminal histories. Retain even
    // nonterminal snapshots when a historical scan is deferred: stale queued
    // work must continue reserving capacity, never become an invented success.
    if (cached && archived && cached.every((r) => r.status === "completed")) return cached;
    if (!allowRefresh) return (await this.cache.get<Run[]>(key)) ?? [];
    const runs = await this.runs(manifest, branch);
    await this.cache.set(key, runs);
    return runs;
  }
  async baseCI(sha: string): Promise<BaseCiEvidence> {
    try {
      return await this.readBaseCI(sha);
    } catch {
      return {
        sha,
        status: "unknown",
        runId: null,
        attempt: null,
        reason: "Exact-base CI observation unavailable",
      };
    }
  }
  private async readBaseCI(sha: string): Promise<BaseCiEvidence> {
    const evidence: BaseCiEvidence = {
      sha,
      status: "unknown",
      runId: null,
      attempt: null,
      reason: "Missing exact-base main CI",
    };
    const rows = await this.pages(
      `actions/workflows/ci.yml/runs?branch=${encodeURIComponent(this.config.baseBranch)}&head_sha=${sha}&event=push`,
      "workflow_runs",
    );
    const exact = (r: Json) =>
      r.head_sha === sha &&
      r.head_branch === this.config.baseBranch &&
      r.path === ".github/workflows/ci.yml" &&
      r.event === "push";
    const run = rows.filter(exact).sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!run) return evidence;
    const id = Number(run.id),
      attempt = Number(run.run_attempt);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(attempt) || attempt < 1)
      return evidence;
    evidence.runId = id;
    evidence.attempt = attempt;
    const details = (await this.get(`actions/runs/${id}/attempts/${attempt}`)) as Json;
    if (
      !exact(details) ||
      Number(details.id) !== id ||
      Number(details.run_attempt) !== attempt ||
      details.status !== "completed"
    )
      return { ...evidence, reason: "Exact-base CI attempt is running or identity unavailable" };
    if (!["success", "failure"].includes(details.conclusion))
      return {
        ...evidence,
        reason: "Exact-base CI cancelled/skipped/unknown is not policy evidence",
      };
    if (details.conclusion === "failure") {
      evidence.status = "red";
      evidence.reason = "Exact-base main CI failed; no member attribution";
    } else {
      const artifacts = await this.pages(`actions/runs/${id}/artifacts`, "artifacts");
      const matches = artifacts.filter(
        (a) =>
          a.name === `full-green-main-${sha}` &&
          !a.expired &&
          a.size_in_bytes <= 1_000_000 &&
          a.workflow_run?.id === id &&
          a.workflow_run?.head_sha === sha &&
          Number.isFinite(Date.parse(a.created_at)) &&
          Number.isFinite(Date.parse(details.run_started_at)) &&
          Date.parse(a.created_at) >= Date.parse(details.run_started_at),
      );
      if (matches.length !== 1)
        return { ...evidence, reason: "Unique exact-base full-green artifact unavailable" };
      const artifact = matches[0]!;
      if (
        !Number.isFinite(Date.parse(artifact.created_at)) ||
        !Number.isFinite(Date.parse(details.run_started_at)) ||
        Date.parse(artifact.created_at) < Date.parse(details.run_started_at)
      )
        return {
          ...evidence,
          reason: "Full-green artifact predates current attempt or lacks timing",
        };
      const response = await this.transport(
        `https://api.github.com/repos/${this.config.repository}/actions/artifacts/${artifact.id}/zip`,
        {
          headers: { Authorization: `Bearer ${await this.auth.token()}` },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        },
      );
      this.checkRateLimit(response);
      let download = response;
      if (response.status === 302) {
        const target = new URL(response.headers.get("location") ?? "");
        if (target.protocol !== "https:") return evidence;
        download = await this.transport(target, { signal: AbortSignal.timeout(30_000) });
      }
      if (!download.ok) {
        this.checkRateLimit(download);
        return { ...evidence, reason: "Full-green artifact download unavailable" };
      }
      try {
        const receipt = JSON.parse(
          readResultZip(new Uint8Array(await download.arrayBuffer()), ["full-green-main.json"]),
        );
        if (
          receipt.schemaVersion !== 1 ||
          receipt.mode !== "full" ||
          receipt.sha !== sha ||
          receipt.runId !== String(id) ||
          receipt.runAttempt !== String(attempt) ||
          receipt.url !==
            `https://github.com/${this.config.repository}/actions/runs/${id}/attempts/${attempt}`
        )
          return {
            ...evidence,
            reason: "Full-green receipt does not bind exact full main attempt",
          };
        evidence.status = "green";
        evidence.reason = "Exact-tip full main CI receipt verified";
      } catch {
        return { ...evidence, reason: "Malformed full-green receipt" };
      }
    }
    // Do not preserve green across a rerun/new attempt or a newer run observed
    // during this read. No negative or positive baseline verdict is cached.
    const latest = (
      await this.pages(
        `actions/workflows/ci.yml/runs?branch=${encodeURIComponent(this.config.baseBranch)}&head_sha=${sha}&event=push`,
        "workflow_runs",
      )
    )
      .filter(exact)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (
      !latest ||
      Number(latest.id) !== id ||
      Number(latest.run_attempt) !== attempt ||
      latest.status !== "completed" ||
      latest.conclusion !== details.conclusion
    )
      return { ...evidence, status: "unknown", reason: "Main CI changed during evidence read" };
    return evidence;
  }
  async mainOutcomes(headSha: string): Promise<MainOutcome[]> {
    const key = `baseline:${headSha}`;
    const cached = await this.cache.get<MainOutcome[]>(key, 900_000);
    if (cached) return cached;
    const runs = await this.pages(
      `actions/workflows/ci.yml/runs?branch=${encodeURIComponent(this.config.baseBranch)}&head_sha=${headSha}&event=push`,
      "workflow_runs",
    );
    const result = runs
      .filter(
        (run) =>
          run.head_sha === headSha &&
          run.head_branch === this.config.baseBranch &&
          run.path === ".github/workflows/ci.yml" &&
          run.event === "push",
      )
      .map((run) => ({
        headSha,
        runId: Number(run.id),
        runAttempt: Number(run.run_attempt),
        conclusion: run.conclusion ?? null,
        startedAt: run.run_started_at ?? null,
        completedAt: run.status === "completed" ? run.updated_at : null,
      }));
    await this.cache.set(key, result);
    return result;
  }
  async resultArtifact(
    manifest: Manifest,
    runId: number,
    attempt: number,
  ): Promise<VerifiedResult | null> {
    const artifacts = await this.pages(`actions/runs/${runId}/artifacts`, "artifacts");
    const matches: VerifiedResult[] = [];
    for (const a of artifacts) {
      if (
        a.name !== `batch-result-${attempt}` ||
        a.expired ||
        a.size_in_bytes > 1_000_000 ||
        a.workflow_run?.id !== runId ||
        a.workflow_run?.head_sha !== manifest.tipSha
      )
        continue;
      const token = await this.auth.token();
      const response = await this.transport(
        `https://api.github.com/repos/${this.config.repository}/actions/artifacts/${a.id}/zip`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        },
      );
      let download = response;
      this.checkRateLimit(response);
      if (response.status === 302) {
        const target = new URL(response.headers.get("location") ?? "");
        if (target.protocol !== "https:") continue;
        // Never forward the repository credential to the artifact storage origin.
        download = await this.transport(target, { signal: AbortSignal.timeout(30_000) });
      }
      if (!download.ok) {
        this.checkRateLimit(download);
        if ([404, 410].includes(download.status)) continue;
        throw new ProviderError(download.status, "artifact download");
      }
      try {
        const body = readResultZip(new Uint8Array(await download.arrayBuffer()));
        const verified = verifyResult(JSON.parse(body), manifest, runId, attempt);
        if (verified) matches.push(verified);
      } catch {
        /* Malformed artifacts are unknown, never code-red. */
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  }
  /**
   * One named JSON entry of exactly one artifact of this exact run attempt and
   * tip. Missing, expired, oversized, duplicated or malformed artifacts are
   * unknown (null), never evidence. Provider errors other than 404/410 throw.
   */
  async runArtifactJson(input: {
    runId: number;
    headSha: string;
    artifact: string;
    entry: string;
    maxBytes: number;
  }): Promise<unknown> {
    const artifacts = (
      await this.pages(`actions/runs/${input.runId}/artifacts`, "artifacts")
    ).filter(
      (a) =>
        a.name === input.artifact &&
        a.workflow_run?.id === input.runId &&
        a.workflow_run?.head_sha === input.headSha,
    );
    if (artifacts.length !== 1) return null;
    const a = artifacts[0]!;
    if (a.expired || !(a.size_in_bytes <= input.maxBytes)) return null;
    const response = await this.transport(
      `https://api.github.com/repos/${this.config.repository}/actions/artifacts/${a.id}/zip`,
      {
        headers: { Authorization: `Bearer ${await this.auth.token()}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    this.checkRateLimit(response);
    let download = response;
    if (response.status === 302) {
      const target = new URL(response.headers.get("location") ?? "");
      if (target.protocol !== "https:") return null;
      // Never forward the repository credential to the artifact storage origin.
      download = await this.transport(target, { signal: AbortSignal.timeout(30_000) });
    }
    if (!download.ok) {
      this.checkRateLimit(download);
      if ([404, 410].includes(download.status)) return null;
      throw new ProviderError(download.status, "artifact download");
    }
    try {
      return JSON.parse(
        readResultZip(new Uint8Array(await download.arrayBuffer()), [input.entry], {
          archiveBytes: input.maxBytes,
          entryBytes: input.maxBytes,
        }),
      );
    } catch {
      return null;
    }
  }
  /**
   * The frozen execution plan a failed candidate ran, bound to its exact run
   * attempt and to the planDigest of its verified comparison evidence.
   */
  async planArtifact(
    run: Pick<Run, "id" | "attempt" | "headSha">,
    planDigest: string,
  ): Promise<ExecutionPlan | null> {
    const raw = await this.runArtifactJson({
      runId: run.id,
      headSha: run.headSha,
      artifact: `batch-plan-${run.attempt}`,
      entry: "execution-plan.json",
      maxBytes: COMPARISON_ARTIFACT_BYTES,
    });
    try {
      const plan = validateExecutionPlan(raw);
      return digest(plan) === planDigest ? plan : null;
    } catch {
      return null;
    }
  }
  /** Raw result and comparison documents of one exact run attempt, for verifyEvidence. */
  async comparisonArtifacts(
    run: Pick<Run, "id" | "attempt" | "headSha">,
  ): Promise<{ result: unknown; evidence: unknown } | null> {
    const result = await this.runArtifactJson({
      runId: run.id,
      headSha: run.headSha,
      artifact: `batch-result-${run.attempt}`,
      entry: "batch-result.json",
      maxBytes: 1_000_000,
    });
    if (!result) return null;
    const evidence = await this.runArtifactJson({
      runId: run.id,
      headSha: run.headSha,
      artifact: `batch-comparison-${run.attempt}`,
      entry: "batch-comparison.json",
      maxBytes: COMPARISON_ARTIFACT_BYTES,
    });
    return evidence ? { result, evidence } : null;
  }
}

/** Bound for frozen plans and comparison evidence of a full-inventory batch. */
export const COMPARISON_ARTIFACT_BYTES = 8_000_000;

// Small bounded ZIP reader: no extraction paths, subprocesses, third-party APIs,
// or artifact-controlled filenames written to disk. Uses central-directory sizes.
export function readResultZip(
  bytes: Uint8Array,
  allowedNames = ["batch-result.json", "result.json"],
  limits: { archiveBytes: number; entryBytes: number } = {
    archiveBytes: 1_000_000,
    entryBytes: 65_536,
  },
): string {
  if (bytes.byteLength > limits.archiveBytes) throw new Error("Artifact too large");
  const b = Buffer.from(bytes);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) throw new Error("Invalid ZIP");
  const count = b.readUInt16LE(end + 10);
  if (count < 1 || count > 10) throw new Error("Invalid ZIP entry count");
  let position = b.readUInt32LE(end + 16);
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(position) !== 0x02014b50) throw new Error("Invalid directory");
    const flags = b.readUInt16LE(position + 8),
      compression = b.readUInt16LE(position + 10);
    const compressed = b.readUInt32LE(position + 20),
      size = b.readUInt32LE(position + 24);
    const nameLength = b.readUInt16LE(position + 28),
      extra = b.readUInt16LE(position + 30),
      comment = b.readUInt16LE(position + 32);
    const name = b.subarray(position + 46, position + 46 + nameLength).toString();
    const offset = b.readUInt32LE(position + 42);
    position += 46 + nameLength + extra + comment;
    if (!allowedNames.includes(name)) continue;
    if (
      flags & 1 ||
      size > limits.entryBytes ||
      compressed > limits.archiveBytes ||
      b.readUInt32LE(offset) !== 0x04034b50
    )
      throw new Error("Invalid result entry");
    const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
    if (start + compressed > b.length) throw new Error("Truncated ZIP");
    const data = b.subarray(start, start + compressed);
    const decoded =
      compression === 0
        ? data
        : compression === 8
          ? inflateRawSync(data, { maxOutputLength: limits.entryBytes })
          : null;
    if (!decoded || decoded.length !== size) throw new Error("Invalid compression");
    results.push(decoded.toString("utf8"));
  }
  if (results.length !== 1) throw new Error("Ambiguous result artifact");
  return results[0]!;
}

export interface Capabilities {
  atomicRefs: boolean;
  atomicReadyFence: boolean;
  fencedSideEffects: boolean;
  reason: string;
}
export const githubCapabilities: Capabilities = {
  atomicRefs: true,
  atomicReadyFence: false,
  fencedSideEffects: false,
  reason:
    "GitHub provides atomic Git ref updates, not atomic PR metadata or REST-effect fences. The active adapter uses exact-tested-snapshot semantics, final rereads, durable intents and post-land reconciliation; strict no-last-moment-head-race semantics are unavailable.",
};
export function requireActiveCapabilities(
  caps: Capabilities,
  contract?: "exact-tested-snapshot",
): void {
  if (
    !caps.atomicRefs ||
    (contract !== "exact-tested-snapshot" && (!caps.atomicReadyFence || !caps.fencedSideEffects))
  )
    throw new Error(caps.reason);
}

// Explicit write surface, not instantiated or reachable by the shadow runner.
// The active executor durably claims and reconciles these non-atomic REST effects.
export class GitHubMutations {
  constructor(readonly reader: GitHubReader) {}
  private async post(path: string, body: unknown): Promise<void> {
    if (this.reader.config.mode !== "active")
      throw new Error("Shadow mode forbids GitHub mutations");
    const token = await this.reader.auth.token();
    const response = await this.reader.transport(
      `https://api.github.com/repos/${this.reader.config.repository}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new ProviderError(response.status, "mutation");
  }
  async retry(run: Run): Promise<void> {
    if (
      run.status !== "completed" ||
      run.attempt !== 1 ||
      run.workflow !== ".github/workflows/batch-ci.yml" ||
      run.workflow !== this.reader.config.workflow ||
      !run.branch.startsWith(this.reader.config.branchPrefix) ||
      !/^[a-f0-9]{64}$/.test(run.branch.slice(this.reader.config.branchPrefix.length)) ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      !(
        (run.infrastructureRetryReason === "verified-infrastructure" &&
          run.trusted &&
          run.outcome === "infrastructure") ||
        (run.infrastructureRetryReason === "provider-cancelled" && run.outcome === "cancelled") ||
        (run.infrastructureRetryReason === "no-job-logs" && run.outcome === "infrastructure")
      )
    )
      throw new Error(
        "Only a first-attempt terminal candidate infrastructure failure may be retried",
      );
    await this.post(`actions/runs/${run.id}/rerun`, {});
  }
  async announce(number: number, body: string): Promise<void> {
    await this.post(`issues/${number}/comments`, { body });
  }
  async createFollowup(request: FollowupRequest): Promise<void> {
    const [owner, name] = request.sourceRepository.split("/");
    await this.post("pulls", {
      title: request.title,
      body: request.body,
      head: `${owner}:${request.sourceRef}`,
      ...(owner === this.reader.config.repository.split("/")[0] ? { head_repo: name } : {}),
      base: this.reader.config.baseBranch,
      draft: false,
    });
  }
}
