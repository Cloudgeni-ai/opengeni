import { describe, expect, test } from "bun:test";
import { capacitySetting, readHeadroom } from "../ci/batch-traffic-shadow";
import { GitHubAuth, GitHubReader } from "./github";
import {
  CANDIDATE_SLOTS,
  capacityDecision,
  config,
  DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
  DEFAULT_PROVIDER_JOB_LIMIT,
  MAIN_PRE_FANOUT_JOBS,
  observeMainQueue,
  runnerJobDemand,
  scanRunnerDemand,
  selfHostedJob,
} from "./model";

const MAIN = { head_branch: "main", path: ".github/workflows/ci.yml", event: "push" };
const OTHER = { head_branch: "feature", path: ".github/workflows/other.yml", event: "push" };
const NOW = Date.parse("2026-10-22T08:00:00Z");
const iso = (secondsBeforeNow: number) => new Date(NOW - secondsBeforeNow * 1000).toISOString();
type Run = Record<string, unknown> & { id: number; status: string };
const page = (jobs: unknown[]) => ({ total_count: jobs.length, jobs });
const many = (count: number, status: string, extra: object = {}) =>
  Array.from({ length: count }, () => ({ status, ...extra }));

/** Repository-scoped provider: every request must stay under the configured repository. */
function provider(runs: Run[], jobs: Record<number, unknown[]>) {
  const requests: string[] = [];
  const get = async (path: string) => {
    requests.push(path);
    const m = /^actions\/runs\/(\d+)\/jobs\?/.exec(path);
    if (m) return page(jobs[Number(m[1])] ?? []);
    const status = new URLSearchParams(path.split("?")[1]).get("status");
    const listed = runs.filter((run) => run.status === status);
    return { total_count: listed.length, workflow_runs: listed };
  };
  return { requests, get };
}
const production = { runnerBudget: 52, mainReserve: 30 };
const defaults = {
  providerJobLimit: DEFAULT_PROVIDER_JOB_LIMIT,
  otherRepositoryAllowance: DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
};
const idleMain = { runId: 1, queuedJobs: 0, oldestQueuedSeconds: null, maxStartWaitSeconds: null };
const idleMainRuns = { mainQueuedJobs: 0, preFanoutMainRuns: [] as number[] };
/** The 3 jobs ci.yml creates before plan completes, already finished (fan-out instantiated). */
const prePlan = () => many(MAIN_PRE_FANOUT_JOBS, "completed");

describe("hosted capacity decision", () => {
  test("documented defaults: 60-job pool, 28 other-repository allowance, 18 candidate slots", () => {
    expect([
      DEFAULT_PROVIDER_JOB_LIMIT,
      DEFAULT_OTHER_REPOSITORY_ALLOWANCE,
      CANDIDATE_SLOTS,
    ]).toEqual([60, 28, 18]);
    const settings = config({});
    expect(settings).toMatchObject({ providerJobLimit: 60, otherRepositoryAllowance: 28 });
    expect(
      config({ BATCHER_PROVIDER_JOB_LIMIT: "70", BATCHER_OTHER_REPOSITORY_ALLOWANCE: "0" }),
    ).toMatchObject({ providerJobLimit: 70, otherRepositoryAllowance: 0 });
    for (const value of ["-1", "1.5", "", "x"])
      expect(() => config({ BATCHER_OTHER_REPOSITORY_ALLOWANCE: value })).toThrow(
        "Invalid BATCHER_OTHER_REPOSITORY_ALLOWANCE",
      );
    for (const value of ["0", "-1", "x"])
      expect(() => config({ BATCHER_PROVIDER_JOB_LIMIT: value })).toThrow(
        "Invalid BATCHER_PROVIDER_JOB_LIMIT",
      );
  });

  test("observed repository demand must fit 60 - 28 - 18 = 14 jobs", () => {
    const decide = (mainDemand: number, otherDemand: number) =>
      capacityDecision({
        mainDemand,
        otherDemand,
        latestMain: null,
        ...idleMainRuns,
        ...production,
        ...defaults,
      });
    expect(decide(10, 4)).toMatchObject({
      allowed: true,
      reservedMain: 30,
      capacity: { providerRequired: 60, hold: null },
    });
    expect(decide(11, 4)).toMatchObject({
      allowed: false,
      capacity: { providerRequired: 61, hold: "provider-limit" },
    });
    expect(decide(14, 0).allowed).toBe(true);
    expect(decide(15, 0).capacity.hold).toBe("provider-limit");
  });

  test("the unchanged 52/30/18 repository allocation still applies first", () => {
    // other 5 + max(30, 0) + 18 = 53 > 52 even though 5 + 28 + 18 = 51 fits 60.
    expect(
      capacityDecision({
        mainDemand: 0,
        otherDemand: 5,
        latestMain: null,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }),
    ).toMatchObject({
      allowed: false,
      capacity: { providerRequired: 51, hold: "repository-budget" },
    });
    expect(
      capacityDecision({
        mainDemand: 0,
        otherDemand: 4,
        latestMain: null,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }).allowed,
    ).toBe(true);
  });

  test("jobs waiting for runners on the newest main run hold before any arithmetic", () => {
    const queued = { runId: 9, queuedJobs: 1, oldestQueuedSeconds: 3, maxStartWaitSeconds: 0 };
    expect(
      capacityDecision({
        mainDemand: 1,
        otherDemand: 0,
        latestMain: queued,
        ...idleMainRuns,
        mainQueuedJobs: 1,
        ...production,
        ...defaults,
      }),
    ).toMatchObject({ allowed: false, capacity: { hold: "main-queued", latestMain: queued } });
    expect(
      capacityDecision({
        mainDemand: 1,
        otherDemand: 0,
        latestMain: idleMain,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }).allowed,
    ).toBe(true);
  });

  test("invalid or impossible limits fail closed", () => {
    const decide = (providerJobLimit: number, otherRepositoryAllowance: number) =>
      capacityDecision({
        mainDemand: 0,
        otherDemand: 0,
        latestMain: null,
        ...idleMainRuns,
        ...production,
        providerJobLimit,
        otherRepositoryAllowance,
      });
    for (const [limit, allowance] of [
      [Number.NaN, 28],
      [60, Number.NaN],
      [0, 0],
      [60, -1],
      [60, 61],
      [60.5, 28],
    ])
      expect(decide(limit!, allowance!)).toMatchObject({
        allowed: false,
        capacity: { hold: "invalid-capacity", providerRequired: null },
      });
    // Valid but unsatisfiable: allowance + 18 alone exceeds the limit, so nothing is admitted.
    expect(decide(45, 28)).toMatchObject({
      allowed: false,
      capacity: { providerRequired: 46, hold: "provider-limit" },
    });
  });

  test("negative controls: measured publications the old repository-only gate admitted", () => {
    // 08:16:52 UTC October 22: main 26, other 3 runner-holding jobs in opengeni.
    const old = (main: number, other: number) => other + Math.max(30, main) + 18 <= 52;
    expect(old(26, 3)).toBe(true);
    expect(
      capacityDecision({
        mainDemand: 26,
        otherDemand: 3,
        latestMain: idleMain,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }),
    ).toMatchObject({ allowed: false, capacity: { providerRequired: 75, hold: "provider-limit" } });
    // 05:29:32 UTC: main 17, other 0. Old gate admitted; 17 + 28 + 18 = 63 > 60 now holds.
    expect(old(17, 0)).toBe(true);
    expect(
      capacityDecision({
        mainDemand: 17,
        otherDemand: 0,
        latestMain: idleMain,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }).capacity.hold,
    ).toBe("provider-limit");
    // 07:37:04 UTC: main 1, other 1. Both gates admit.
    expect(old(1, 1)).toBe(true);
    expect(
      capacityDecision({
        mainDemand: 1,
        otherDemand: 1,
        latestMain: idleMain,
        ...idleMainRuns,
        ...production,
        ...defaults,
      }).allowed,
    ).toBe(true);
  });
});

describe("newest main landing queue observation", () => {
  test("measures queued age and start waits from job timestamps", () => {
    expect(
      observeMainQueue(
        7,
        [
          { status: "queued", created_at: iso(90) },
          { status: "requested", created_at: iso(30) },
          { status: "in_progress", created_at: iso(400), started_at: iso(180) },
          { status: "completed", created_at: iso(500), started_at: iso(495) },
          { status: "waiting", created_at: iso(900) },
          { status: "pending", created_at: iso(900) },
        ],
        NOW,
      ),
    ).toEqual({ runId: 7, queuedJobs: 2, oldestQueuedSeconds: 90, maxStartWaitSeconds: 220 });
  });

  test("unparseable timestamps never shorten a wait or remove a queued job", () => {
    expect(
      observeMainQueue(
        7,
        [
          { status: "queued", created_at: iso(10) },
          { status: "queued", created_at: "not-a-time" },
          { status: "in_progress", created_at: iso(5), started_at: "bad" },
          { status: "in_progress", created_at: iso(5), started_at: iso(10) },
        ],
        NOW,
      ),
    ).toEqual({ runId: 7, queuedJobs: 2, oldestQueuedSeconds: null, maxStartWaitSeconds: null });
  });

  test("queued jobs on any main run hold, including an older rerun; production and PR runs are other demand", async () => {
    const runs: Run[] = [
      { id: 100, status: "in_progress", ...MAIN },
      { id: 90, status: "queued", ...MAIN }, // old main rerun keeps its original ID
      { id: 200, status: "queued", ...MAIN, head_branch: "production" },
      { id: 201, status: "queued", ...MAIN, event: "pull_request" },
    ];
    const p = provider(runs, {
      100: [...prePlan(), { status: "in_progress", created_at: iso(60), started_at: iso(58) }],
      90: [...prePlan(), { status: "queued", created_at: iso(30) }],
      200: [{ status: "queued", created_at: iso(30) }],
      201: [{ status: "queued", created_at: iso(30) }],
    });
    const scan = await scanRunnerDemand({
      get: p.get,
      batchWorkflow: ".github/workflows/batch-ci.yml",
      baseBranch: "main",
      now: () => NOW,
    });
    expect(scan).toMatchObject({
      ok: true,
      mainDemand: 2,
      otherDemand: 2,
      latestMain: { runId: 100, queuedJobs: 0, oldestQueuedSeconds: null, maxStartWaitSeconds: 2 },
      mainQueuedJobs: 1,
      preFanoutMainRuns: [],
    });
    if (!scan.ok) throw new Error("scan held");
    // Arithmetic alone fits (50 <= 52 and 50 <= 60), but a main job waits for a runner.
    expect(capacityDecision({ ...scan, ...production, ...defaults }).capacity).toMatchObject({
      hold: "main-queued",
      providerRequired: 50,
    });
    // Once the older rerun's job starts, admission proceeds.
    const started = provider(runs, {
      100: [...prePlan(), { status: "in_progress" }],
      90: [...prePlan(), { status: "in_progress" }],
      200: [{ status: "queued" }],
      201: [{ status: "queued" }],
    });
    const after = await scanRunnerDemand({
      get: started.get,
      batchWorkflow: ".github/workflows/batch-ci.yml",
      baseBranch: "main",
    });
    if (!after.ok) throw new Error("scan held");
    expect(capacityDecision({ ...after, ...production, ...defaults }).allowed).toBe(true);
  });
});

describe("batcher reader admission (stage.json headroom)", () => {
  const reader = (
    runs: Run[],
    jobs: Record<number, unknown[]>,
    env: Record<string, string> = {},
  ) => {
    const cfg = config({
      BATCHER_MODE: "active",
      BATCHER_RUNNER_BUDGET: "52",
      BATCHER_MAIN_RESERVE: "30",
      ...env,
    });
    const urls: string[] = [];
    const p = provider(runs, jobs);
    const transport = (async (url: string | URL | Request) => {
      const text = String(url);
      urls.push(text);
      const prefix = `https://api.github.com/repos/${cfg.repository}/`;
      if (!text.startsWith(prefix)) return new Response("forbidden", { status: 403 });
      return Response.json(await p.get(text.slice(prefix.length)));
    }) as unknown as typeof fetch;
    return { github: new GitHubReader(cfg, new GitHubAuth({}), transport), urls, cfg };
  };

  test("main fan-out and queued jobs are visible without withholding live submission", async () => {
    const main: Run = { id: 500, status: "queued", ...MAIN };
    const fanout = (queued: number, running: number) => ({
      500: [
        ...prePlan(),
        ...many(queued, "queued", { created_at: iso(120) }),
        ...many(running, "in_progress", { created_at: iso(200), started_at: iso(190) }),
      ],
    });
    // Batch 1 pattern: main CI fanned out while shards held runners; 13 jobs waited.
    const waiting = reader([main], fanout(13, 1));
    expect(await waiting.github.mainBusy()).toBe(false);
    expect(waiting.github.lastHeadroom).toMatchObject({
      allowed: true,
      capacityInformational: true,
      occupied: 14,
      reason: expect.stringContaining("A full-main CI run has jobs waiting for hosted runners"),
      capacity: { hold: "main-queued", latestMain: { runId: 500, queuedJobs: 13 } },
    });
    expect(waiting.github.lastHeadroom?.capacity?.latestMain?.oldestQueuedSeconds).toBeGreaterThan(
      100,
    );
    // Runners started but main still holds 14 jobs: the provider pool, not the queue, holds.
    main.status = "in_progress";
    const started = reader([main], fanout(0, 14));
    expect(await started.github.mainBusy()).toBe(false);
    expect(started.github.lastHeadroom?.capacity).toMatchObject({
      hold: null,
      providerRequired: 60,
    });
    const large = reader([main], fanout(0, 15));
    expect(await large.github.mainBusy()).toBe(false);
    expect(large.github.lastHeadroom?.capacity?.hold).toBe("provider-limit");
    // Main finished its fan-out tail: admitted again.
    const tail = reader([main], fanout(0, 3));
    expect(await tail.github.mainBusy()).toBe(false);
    expect(tail.github.lastHeadroom?.reason).toContain("provider slots");
  });

  test("an approval-only newest main run is not runner demand and does not hold", async () => {
    const approval: Run = { id: 600, status: "waiting", ...MAIN };
    const r = reader([approval], { 600: [{ status: "waiting" }, { status: "completed" }] });
    expect(await r.github.mainBusy()).toBe(false);
    expect(r.github.lastHeadroom).toMatchObject({
      approvalOnlyRuns: 1,
      occupied: 0,
      capacity: { hold: null, latestMain: { runId: 600, queuedJobs: 0 } },
    });
    // Approval granted and jobs queue for runners: the next observation holds.
    // Approval granted: the admission job queues; the fan-out is not yet
    // instantiated, so the run is pre-fan-out and holds.
    const granted = reader([approval], { 600: [{ status: "queued", created_at: iso(2) }] });
    expect(await granted.github.mainBusy()).toBe(false);
    expect(granted.github.lastHeadroom?.capacity).toMatchObject({
      hold: "main-pre-fanout",
      preFanoutMainRuns: [600],
      mainQueuedJobs: 1,
    });
  });

  test("other repositories are never read; the allowance stands in for them", async () => {
    const r = reader([{ id: 1, status: "in_progress", ...OTHER }], { 1: many(3, "in_progress") });
    expect(await r.github.mainBusy()).toBe(false);
    expect(
      r.urls.every((url) => url.startsWith(`https://api.github.com/repos/${r.cfg.repository}/`)),
    ).toBe(true);
    expect(r.github.lastHeadroom?.capacity).toMatchObject({
      providerJobLimit: 60,
      otherRepositoryAllowance: 28,
      providerRequired: 3 + 28 + 18,
    });
    // A larger configured allowance tightens admission; a provider error still holds by throwing.
    const strict = reader(
      [{ id: 1, status: "in_progress", ...OTHER }],
      { 1: many(3, "in_progress") },
      {
        BATCHER_OTHER_REPOSITORY_ALLOWANCE: "40",
      },
    );
    expect(await strict.github.mainBusy()).toBe(false);
    expect(strict.github.lastHeadroom?.capacity?.hold).toBe("provider-limit");
  });

  test("incomplete scans still hold before any capacity arithmetic", async () => {
    const r = reader([], {});
    const oversized = new GitHubReader(r.cfg, new GitHubAuth({}), (async () =>
      Response.json({ total_count: 101, workflow_runs: [] })) as unknown as typeof fetch);
    expect(await oversized.mainBusy()).toBe(true);
    expect(oversized.lastHeadroom?.capacity).toBeUndefined();
  });
});

describe("traffic-shadow reader admission", () => {
  const traffic = (runs: Run[], jobs: Record<number, unknown[]>) => {
    const p = provider(runs, jobs);
    return { fresh: p.get };
  };
  test("same decision, documented defaults and fail-closed settings", async () => {
    const quiet = traffic([{ id: 3, status: "in_progress", ...MAIN }], {
      3: [...prePlan(), ...many(2, "in_progress")],
    });
    expect(await readHeadroom(quiet, 52, 30)).toMatchObject({
      allowed: true,
      capacity: { providerJobLimit: 60, otherRepositoryAllowance: 28, providerRequired: 48 },
    });
    const queued = traffic([{ id: 3, status: "queued", ...MAIN }], {
      3: [...prePlan(), { status: "queued", created_at: iso(5) }],
    });
    expect(await readHeadroom(queued, 52, 30)).toMatchObject({
      allowed: false,
      reason: "A full-main CI run has jobs waiting for hosted runners",
    });
    const busy = traffic([{ id: 3, status: "in_progress", ...MAIN }], {
      3: many(26, "in_progress"),
    });
    expect(await readHeadroom(busy, 52, 30)).toMatchObject({
      allowed: false,
      capacity: { hold: "provider-limit", providerRequired: 72 },
    });
    expect(capacitySetting(undefined, 28)).toBe(28);
    expect(capacitySetting("0", 28)).toBe(0);
    for (const raw of ["", " ", "-1", "2.5", "many"]) expect(capacitySetting(raw, 28)).toBeNaN();
    expect(
      await readHeadroom(quiet, 52, 30, undefined, {
        providerJobLimit: capacitySetting("sixty", 60),
        otherRepositoryAllowance: 28,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "Invalid hosted job limit or other-repository allowance",
      capacity: { hold: "invalid-capacity" },
    });
  });
});

describe("main before fan-out and queued main jobs hold (review of 7779ef9)", () => {
  const scan = (runs: Run[], jobs: Record<number, unknown[]>) =>
    scanRunnerDemand({
      get: provider(runs, jobs).get,
      batchWorkflow: ".github/workflows/batch-ci.yml",
      baseBranch: "main",
      now: () => NOW,
    });
  const decide = async (runs: Run[], jobs: Record<number, unknown[]>) => {
    const s = await scan(runs, jobs);
    if (!s.ok) throw new Error(`held ${s.hold}`);
    return capacityDecision({ ...s, ...production, ...defaults });
  };
  /** Both production readers over the same repository-scoped provider. */
  const both = async (runs: Run[], jobs: Record<number, unknown[]>) => {
    const cfg = config({
      BATCHER_MODE: "active",
      BATCHER_RUNNER_BUDGET: "52",
      BATCHER_MAIN_RESERVE: "30",
    });
    const prefix = `https://api.github.com/repos/${cfg.repository}/`;
    const p = provider(runs, jobs);
    const transport = (async (url: string | URL | Request) =>
      Response.json(await p.get(String(url).slice(prefix.length)))) as unknown as typeof fetch;
    const github = new GitHubReader(cfg, new GitHubAuth({}), transport);
    const busy = await github.mainBusy();
    const traffic = await readHeadroom({ fresh: provider(runs, jobs).get }, 52, 30);
    return { busy, batcher: github.lastHeadroom, traffic };
  };
  const planPhase = (id: number) => ({
    [id]: many(MAIN_PRE_FANOUT_JOBS, "in_progress", { created_at: iso(10), started_at: iso(8) }),
  });

  test("A1: plan-phase main is informational live and holds traffic-shadow", async () => {
    const runs: Run[] = [{ id: 700, status: "in_progress", ...MAIN }];
    const d = await decide(runs, planPhase(700));
    // 7779ef9 admitted here: demand 3 fits, then the ~45 runner-holding fan-out
    // jobs plus the admitted candidate's 17 exceed 60.
    expect(3 + DEFAULT_OTHER_REPOSITORY_ALLOWANCE + CANDIDATE_SLOTS).toBeLessThanOrEqual(60);
    expect(45 + 17).toBeGreaterThan(DEFAULT_PROVIDER_JOB_LIMIT);
    expect(d.capacity).toMatchObject({ hold: "main-pre-fanout", preFanoutMainRuns: [700] });
    const r = await both(runs, planPhase(700));
    expect(r.busy).toBe(false);
    expect(r.batcher).toMatchObject({
      allowed: true,
      capacityInformational: true,
      reason: expect.stringContaining("A full-main CI run has not instantiated its fan-out yet"),
      capacity: { hold: "main-pre-fanout", preFanoutMainRuns: [700] },
    });
    expect(r.traffic).toMatchObject({
      allowed: false,
      reason: "A full-main CI run has not instantiated its fan-out yet",
      capacity: { hold: "main-pre-fanout", preFanoutMainRuns: [700] },
    });
  });

  test("A2: job-less main is informational live and holds traffic-shadow", async () => {
    const runs: Run[] = [{ id: 701, status: "queued", ...MAIN }];
    const d = await decide(runs, { 701: [] });
    expect(d.capacity).toMatchObject({
      hold: "main-pre-fanout",
      preFanoutMainRuns: [701],
      latestMain: { runId: 701, queuedJobs: 0 },
    });
    const r = await both(runs, { 701: [] });
    expect(r.busy).toBe(false);
    expect(r.batcher?.capacity?.hold).toBe("main-pre-fanout");
    expect(r.traffic).toMatchObject({ allowed: false, capacity: { hold: "main-pre-fanout" } });
  });

  test("a concurrency-pending job-less main run fails closed until it materializes", async () => {
    const d = await decide([{ id: 702, status: "pending", ...MAIN }], { 702: [] });
    expect(d.capacity.hold).toBe("main-pre-fanout");
    // A job-less run listed as waiting is not proven approval-only either.
    const w = await decide([{ id: 703, status: "waiting", ...MAIN }], { 703: [] });
    expect(w.capacity.hold).toBe("main-pre-fanout");
  });

  test("A3: older main jobs waiting for runners hold even when a newer main exists", async () => {
    const runs: Run[] = [
      { id: 800, status: "in_progress", ...MAIN },
      { id: 790, status: "in_progress", ...MAIN },
    ];
    const queued790 = { 790: [...prePlan(), ...many(6, "queued", { created_at: iso(300) })] };
    // Newer run still in its plan phase: pre-fan-out ranks first.
    const pre = await decide(runs, { ...planPhase(800), ...queued790 });
    expect(pre.capacity).toMatchObject({
      hold: "main-pre-fanout",
      preFanoutMainRuns: [800],
      mainQueuedJobs: 6,
    });
    // Newer run fanned out with no queued job; the older run's queue alone holds.
    const fanned = { 800: [...prePlan(), ...many(4, "in_progress")], ...queued790 };
    const d = await decide(runs, fanned);
    expect(d.capacity).toMatchObject({
      hold: "main-queued",
      preFanoutMainRuns: [],
      mainQueuedJobs: 6,
      latestMain: { runId: 800, queuedJobs: 0 },
    });
    const r = await both(runs, fanned);
    expect(r.busy).toBe(false);
    expect(r.batcher).toMatchObject({
      allowed: true,
      capacityInformational: true,
      reason: expect.stringContaining("A full-main CI run has jobs waiting for hosted runners"),
      capacity: { hold: "main-queued", mainQueuedJobs: 6 },
    });
    expect(r.traffic).toMatchObject({ allowed: false, capacity: { hold: "main-queued" } });
  });

  test("a requested main job counts as waiting for a runner", async () => {
    const d = await decide([{ id: 810, status: "in_progress", ...MAIN }], {
      810: [...prePlan(), ...many(2, "in_progress"), { status: "requested" }],
    });
    expect(d.capacity).toMatchObject({ hold: "main-queued", mainQueuedJobs: 1 });
  });

  test("historical approval-only main runs never freeze admission, beside an active main too", async () => {
    const runs: Run[] = [
      { id: 50, status: "waiting", ...MAIN },
      { id: 51, status: "waiting", ...MAIN },
    ];
    const jobs = {
      50: [{ status: "waiting" }],
      51: [{ status: "waiting" }, { status: "completed" }, { status: "pending" }],
    };
    const d = await decide(runs, jobs);
    expect(d.allowed).toBe(true);
    expect(d.capacity).toMatchObject({ hold: null, preFanoutMainRuns: [], mainQueuedJobs: 0 });
    const withActive = await both([...runs, { id: 900, status: "in_progress", ...MAIN }], {
      ...jobs,
      900: [...prePlan(), ...many(4, "in_progress")],
    });
    expect(withActive.busy).toBe(false);
    expect(withActive.batcher).toMatchObject({ approvalOnlyRuns: 2, occupied: 4 });
    expect(withActive.traffic).toMatchObject({ allowed: true });
    // An approved old rerun whose admission job queues becomes pre-fan-out and holds.
    const approved = await decide([{ id: 50, status: "queued", ...MAIN }], {
      50: [{ status: "queued", created_at: iso(1) }],
    });
    expect(approved.capacity).toMatchObject({
      hold: "main-pre-fanout",
      preFanoutMainRuns: [50],
      mainQueuedJobs: 1,
    });
  });

  test("pre-fan-out -> fanned out -> drained tail: admitted only once demand fits", async () => {
    const runs: Run[] = [{ id: 950, status: "in_progress", ...MAIN }];
    expect((await decide(runs, planPhase(950))).capacity.hold).toBe("main-pre-fanout");
    const fanned = await decide(runs, { 950: [...prePlan(), ...many(45, "in_progress")] });
    // Full fan-out (45 runner-holding jobs) exceeds 52/30/18 before the pool check.
    expect(fanned.capacity).toMatchObject({ hold: "repository-budget", preFanoutMainRuns: [] });
    const shrinking = await decide(runs, {
      950: [...prePlan(), ...many(25, "completed"), ...many(20, "in_progress")],
    });
    expect(shrinking.capacity).toMatchObject({ hold: "provider-limit", providerRequired: 66 });
    const tail = await decide(runs, {
      950: [...prePlan(), ...many(50, "completed"), ...many(2, "in_progress")],
    });
    expect(tail.allowed).toBe(true);
    expect(tail.capacity.providerRequired).toBe(2 + 28 + 18);
  });

  test("the pure decision fails closed on malformed main observations", () => {
    const base = {
      mainDemand: 0,
      otherDemand: 0,
      latestMain: idleMain,
      ...production,
      ...defaults,
    };
    const hold = (extra: object) =>
      capacityDecision({ ...base, ...idleMainRuns, ...extra } as Parameters<
        typeof capacityDecision
      >[0]).capacity.hold;
    expect(hold({})).toBeNull();
    expect(hold({ preFanoutMainRuns: undefined })).toBe("main-pre-fanout");
    expect(hold({ preFanoutMainRuns: [1] })).toBe("main-pre-fanout");
    for (const bad of [undefined, Number.NaN, -1, 1.5, 2]) {
      expect(hold({ mainQueuedJobs: bad })).toBe("main-queued");
    }
    // Invalid capacity still outranks the main holds.
    expect(hold({ preFanoutMainRuns: [1], providerJobLimit: Number.NaN })).toBe("invalid-capacity");
  });

  test("reader re-reads on every call and reports newly queued main jobs", async () => {
    const cfg = config({
      BATCHER_MODE: "active",
      BATCHER_RUNNER_BUDGET: "52",
      BATCHER_MAIN_RESERVE: "30",
    });
    let jobs: unknown[] = [...prePlan(), ...many(1, "in_progress")];
    const prefix = `https://api.github.com/repos/${cfg.repository}/`;
    const transport = (async (url: string | URL | Request) => {
      const p = provider([{ id: 1, status: "in_progress", ...MAIN }], { 1: jobs });
      return Response.json(await p.get(String(url).slice(prefix.length)));
    }) as unknown as typeof fetch;
    const r = new GitHubReader(cfg, new GitHubAuth({}), transport);
    expect(await r.mainBusy()).toBe(false);
    jobs = [...prePlan(), ...many(2, "queued", { created_at: iso(5) })];
    expect(await r.mainBusy()).toBe(false);
    expect(r.lastHeadroom?.capacity?.hold).toBe("main-queued");
  });

  test("MAIN_PRE_FANOUT_JOBS matches the ci.yml jobs that do not need plan, plus plan", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text(),
    ) as { jobs: Record<string, { needs?: string | string[] }> };
    const needs = (name: string): string[] => {
      const raw = workflow.jobs[name]?.needs;
      return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    };
    const memo = new Map<string, boolean>();
    const needsPlan = (name: string): boolean => {
      if (!memo.has(name)) {
        memo.set(name, false);
        memo.set(
          name,
          needs(name).some((dep) => dep === "plan" || needsPlan(dep)),
        );
      }
      return memo.get(name)!;
    };
    const early = Object.keys(workflow.jobs)
      .filter((name) => !needsPlan(name))
      .sort();
    expect(early).toEqual(["automation-admission", "merge-content", "plan"]);
    expect(early.length).toBe(MAIN_PRE_FANOUT_JOBS);
  });
});

describe("hosted-pool accounting counts only GitHub-hosted jobs", () => {
  const HOSTED = { labels: ["ubuntu-latest"] };
  const SELF = { labels: ["self-hosted", "linux", "x64", "opengeni-main-gcp"] };
  const BATCH = {
    head_branch: "queue/live/b1",
    path: ".github/workflows/batch-ci.yml",
    event: "push",
  };
  const scan = (runs: Run[], jobs: Record<number, unknown[]>, maxInflight = 1) =>
    scanRunnerDemand({
      get: provider(runs, jobs).get,
      batchWorkflow: ".github/workflows/batch-ci.yml",
      baseBranch: "main",
      maxInflight,
      now: () => NOW,
    });
  const live = async (runs: Run[], jobs: Record<number, unknown[]>) => {
    const cfg = config({
      BATCHER_MODE: "active",
      BATCHER_RUNNER_BUDGET: "52",
      BATCHER_MAIN_RESERVE: "30",
    });
    const prefix = `https://api.github.com/repos/${cfg.repository}/`;
    const p = provider(runs, jobs);
    const transport = (async (url: string | URL | Request) =>
      Response.json(await p.get(String(url).slice(prefix.length)))) as unknown as typeof fetch;
    const github = new GitHubReader(cfg, new GitHubAuth({}), transport);
    await github.mainBusy();
    return github.lastHeadroom;
  };
  /** A fanned-out main run: the 3 early jobs plus the given fan-out. */
  const fannedMain = (...fanout: unknown[][]) => [...prePlan(), ...fanout.flat()];

  test("runnerJobDemand skips self-hosted jobs but still validates their status", () => {
    const mixed = [
      { status: "queued", ...HOSTED },
      { status: "in_progress", ...HOSTED },
      { status: "requested", ...HOSTED },
      { status: "queued", ...SELF },
      { status: "in_progress", ...SELF },
      { status: "requested", ...SELF },
      { status: "in_progress", labels: ["Self-Hosted", "opengeni-batch-gcp"] },
      { status: "completed", ...SELF },
    ];
    expect(runnerJobDemand(mixed)).toBe(3);
    expect(runnerJobDemand(mixed.filter((job) => selfHostedJob(job)))).toBe(0);
    // Unknown or missing status fails closed even on a self-hosted job.
    expect(runnerJobDemand([...mixed, { status: "surprise", ...SELF }])).toBeNull();
    expect(runnerJobDemand([...mixed, { ...SELF }])).toBeNull();
    expect(selfHostedJob({ status: "queued", ...SELF })).toBe(true);
    expect(selfHostedJob({ status: "queued", ...HOSTED })).toBe(false);
  });

  test("a full scan still holds on an unknown status of a self-hosted main job", async () => {
    const runs: Run[] = [{ id: 1050, status: "in_progress", ...MAIN }];
    for (const odd of [{ status: "surprise", ...SELF }, { ...SELF }]) {
      const s = await scan(runs, { 1050: fannedMain(many(10, "in_progress", SELF), [odd]) });
      expect(s).toMatchObject({ ok: false, hold: "unknown-job-status" });
    }
  });

  test("missing or non-array labels count as hosted demand (conservative)", async () => {
    const unlabelled = [
      { status: "queued" },
      { status: "queued", labels: null },
      { status: "queued", labels: "self-hosted" },
      { status: "queued", labels: { 0: "self-hosted" } },
      { status: "queued", labels: [] },
      { status: "queued", labels: [1, null, "self-hosted-ish"] },
    ];
    for (const job of unlabelled) expect(selfHostedJob(job)).toBe(false);
    expect(runnerJobDemand(unlabelled)).toBe(unlabelled.length);
    const runs: Run[] = [{ id: 1100, status: "in_progress", ...MAIN }];
    const s = await scan(runs, {
      1100: fannedMain(
        many(20, "in_progress", SELF),
        unlabelled.map((job) => ({ ...job, created_at: iso(30) })),
      ),
    });
    if (!s.ok) throw new Error(`held ${s.hold}`);
    expect(s).toMatchObject({
      mainDemand: unlabelled.length,
      mainQueuedJobs: unlabelled.length,
      latestMain: { runId: 1100, queuedJobs: unlabelled.length, oldestQueuedSeconds: 30 },
    });
    expect(capacityDecision({ ...s, ...production, ...defaults }).capacity.hold).toBe(
      "main-queued",
    );
  });

  test("queued and running self-hosted main jobs neither hold nor consume the hosted pool", async () => {
    const runs: Run[] = [{ id: 1200, status: "in_progress", ...MAIN }];
    // The full ~46-job fan-out on opengeni-main-gcp, 30 of them still waiting for a GCP runner.
    const jobs = {
      1200: fannedMain(
        many(30, "queued", { ...SELF, created_at: iso(300) }),
        many(16, "in_progress", { ...SELF, created_at: iso(400), started_at: iso(100) }),
      ),
    };
    const s = await scan(runs, jobs);
    if (!s.ok) throw new Error(`held ${s.hold}`);
    expect(s).toMatchObject({
      mainDemand: 0,
      otherDemand: 0,
      mainQueuedJobs: 0,
      preFanoutMainRuns: [],
      latestMain: {
        runId: 1200,
        queuedJobs: 0,
        oldestQueuedSeconds: null,
        maxStartWaitSeconds: null,
      },
    });
    const d = capacityDecision({ ...s, ...production, ...defaults });
    expect(d).toMatchObject({
      allowed: true,
      reservedMain: 30,
      capacity: { hold: null, providerRequired: 0 + 28 + 18, mainQueuedJobs: 0 },
    });
    // Both production readers agree: no main-queued hold and no hosted occupancy.
    const headroom = await live(runs, jobs);
    expect(headroom).toMatchObject({
      allowed: true,
      occupied: 0,
      mainDemand: 0,
      capacity: { hold: null, mainQueuedJobs: 0, latestMain: { queuedJobs: 0 } },
    });
    expect(await readHeadroom({ fresh: provider(runs, jobs).get }, 52, 30)).toMatchObject({
      allowed: true,
      capacity: { hold: null, providerRequired: 46 },
    });
    // The same fan-out on hosted runners holds, as before.
    const hosted = {
      1200: fannedMain(
        many(30, "queued", { ...HOSTED, created_at: iso(300) }),
        many(16, "in_progress", HOSTED),
      ),
    };
    const h = await scan(runs, hosted);
    if (!h.ok) throw new Error(`held ${h.hold}`);
    expect(h).toMatchObject({ mainDemand: 46, mainQueuedJobs: 30 });
    expect(capacityDecision({ ...h, ...production, ...defaults }).capacity.hold).toBe(
      "main-queued",
    );
  });

  test("mixed hosted and self-hosted jobs: only hosted ones are main, other and Batch demand", async () => {
    const runs: Run[] = [
      { id: 1300, status: "in_progress", ...MAIN },
      { id: 1290, status: "in_progress", ...MAIN }, // older rerun, self-hosted queue only
      { id: 1400, status: "in_progress", ...OTHER },
      { id: 1500, status: "in_progress", ...BATCH },
    ];
    const jobs = {
      1300: fannedMain(
        many(40, "in_progress", SELF),
        many(5, "queued", { ...SELF, created_at: iso(500) }),
        many(2, "in_progress", { ...HOSTED, created_at: iso(90), started_at: iso(60) }),
      ),
      1290: fannedMain(many(4, "queued", { ...SELF, created_at: iso(900) })),
      1400: [...many(3, "in_progress", HOSTED), ...many(6, "in_progress", SELF)],
      1500: [
        ...many(2, "in_progress", HOSTED),
        ...many(17, "in_progress", { labels: ["self-hosted", "opengeni-batch-gcp"] }),
      ],
    };
    const s = await scan(runs, jobs, 2);
    if (!s.ok) throw new Error(`held ${s.hold}`);
    expect(s).toMatchObject({
      mainDemand: 2,
      otherDemand: 3 + 2,
      observedBatchDemand: 2,
      // The per-candidate hosted reservation floor is unchanged.
      reservedBatchDemand: CANDIDATE_SLOTS,
      occupiedBatchSlots: 1,
      mainQueuedJobs: 0,
      preFanoutMainRuns: [],
      latestMain: {
        runId: 1300,
        queuedJobs: 0,
        oldestQueuedSeconds: null,
        maxStartWaitSeconds: 30,
      },
    });
    const d = capacityDecision({ ...s, ...production, ...defaults });
    // Effective other = 5 - 2 + 18 = 21, so 21 + max(30, 2) + 18 = 69 > 52 holds
    // first; the provider pool would need 2 + 21 + 28 + 18 = 69 hosted jobs.
    expect(d.capacity).toMatchObject({ hold: "repository-budget", providerRequired: 69 });
    // A single hosted main job waiting for a runner still holds beside self-hosted ones.
    const queued = {
      ...jobs,
      1290: fannedMain(many(4, "queued", { ...SELF, created_at: iso(900) }), [
        { status: "queued", ...HOSTED, created_at: iso(45) },
      ]),
    };
    const q = await scan(runs, queued, 2);
    if (!q.ok) throw new Error(`held ${q.hold}`);
    expect(q).toMatchObject({ mainDemand: 3, mainQueuedJobs: 1 });
    expect(capacityDecision({ ...q, ...production, ...defaults }).capacity.hold).toBe(
      "main-queued",
    );
  });

  test("pre-fan-out stays label-agnostic: a self-hosted plan phase is not proof about the fan-out", async () => {
    const runs: Run[] = [{ id: 1600, status: "in_progress", ...MAIN }];
    const s = await scan(runs, {
      1600: many(MAIN_PRE_FANOUT_JOBS, "in_progress", { ...SELF, created_at: iso(10) }),
    });
    if (!s.ok) throw new Error(`held ${s.hold}`);
    expect(s).toMatchObject({ mainDemand: 0, mainQueuedJobs: 0, preFanoutMainRuns: [1600] });
    expect(capacityDecision({ ...s, ...production, ...defaults }).capacity.hold).toBe(
      "main-pre-fanout",
    );
  });
});
