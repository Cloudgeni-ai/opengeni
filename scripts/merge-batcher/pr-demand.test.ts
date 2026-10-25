import { expect, test } from "bun:test";
import { config, scanRunnerDemand } from "./model";
import { GitHubAuth, GitHubReader } from "./github";
import { readHeadroom } from "../ci/batch-traffic-shadow";

const pr = (id: number) => ({
  id,
  status: "pending",
  event: "pull_request",
  path: ".github/workflows/pr-ci.yml",
});
function scan(runs: Record<string, unknown>[], excludePrCiDemand = true) {
  const jobs: string[] = [];
  return {
    jobs,
    result: scanRunnerDemand({
      baseBranch: "main",
      batchWorkflow: ".github/workflows/batch-ci.yml",
      excludePrCiDemand,
      get: async (path) => {
        if (path.includes("/jobs?")) {
          jobs.push(path);
          return { total_count: 1, jobs: [{ status: "queued" }] };
        }
        const status = new URLSearchParams(path.split("?")[1]).get("status");
        const listed = runs.filter((run) => run.status === status);
        return { total_count: listed.length, workflow_runs: listed };
      },
    }),
  };
}

test("recognized PR backlog does not consume Batch capacity or scan slots", async () => {
  const probe = scan(Array.from({ length: 65 }, (_, i) => pr(i + 1)));
  expect(await probe.result).toMatchObject({ ok: true, otherDemand: 0, scannedRuns: 0 });
  expect(probe.jobs).toEqual([]);
  expect(
    await scan(
      Array.from({ length: 65 }, (_, i) => pr(i + 1)),
      false,
    ).result,
  ).toMatchObject({ ok: true, otherDemand: 65, scannedRuns: 65 });
});

test("an active Batch still holds even among excluded PR runs", async () => {
  expect(
    await scan([pr(1), { ...pr(2), path: ".github/workflows/batch-ci.yml", event: "push" }]).result,
  ).toMatchObject({ ok: false, hold: "batch-slot" });
});

test("unknown workflow or event is not treated as recognized PR demand", async () => {
  for (const run of [
    { ...pr(1), path: ".github/workflows/other.yml" },
    { ...pr(1), event: "unknown" },
    { ...pr(1), event: "push" },
    { ...pr(1), event: "pull_request_target" },
    { ...pr(1), path: ".github/workflows/pr-ci.yml@refs/heads/main" },
    { ...pr(1), path: "other/.github/workflows/pr-ci.yml" },
  ]) {
    const probe = scan([run]);
    expect(await probe.result).toMatchObject({ ok: true, otherDemand: 1, scannedRuns: 1 });
    expect(probe.jobs).toHaveLength(1);
  }
});

test("live reader excludes PR demand but traffic-shadow still observes it", async () => {
  const runs = Array.from({ length: 20 }, (_, i) => pr(i + 1));
  const get = async (path: string) => {
    if (path.includes("/jobs?")) return { total_count: 1, jobs: [{ status: "queued" }] };
    const status = new URLSearchParams(path.split("?")[1]).get("status");
    const listed = runs.filter((run) => run.status === status);
    return { total_count: listed.length, workflow_runs: listed };
  };
  const cfg = config({
    BATCHER_MODE: "active",
    BATCHER_RUNNER_BUDGET: "52",
    BATCHER_MAIN_RESERVE: "30",
  });
  const prefix = `https://api.github.com/repos/${cfg.repository}/`;
  const transport = (async (url: string | URL | Request) => {
    expect(String(url).startsWith(prefix)).toBe(true);
    return Response.json(await get(String(url).slice(prefix.length)));
  }) as typeof fetch;
  const live = new GitHubReader(cfg, new GitHubAuth({}), transport);
  expect(await live.mainBusy()).toBe(false);
  expect(live.lastHeadroom).toMatchObject({ allowed: true, occupied: 0 });
  expect(await readHeadroom({ fresh: get }, 52, 30)).toMatchObject({
    allowed: false,
    occupied: 20,
  });
});

test("incomplete inventories remain held rather than assumed PR-only", async () => {
  expect(await scan(Array.from({ length: 101 }, (_, i) => pr(i + 1))).result).toMatchObject({
    ok: false,
    hold: "incomplete-runs",
  });
});
