import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Main CI may run its heavy Linux jobs on GCP self-hosted ephemeral runners
// (docs/gcp-main-ci-runners.md). This repository is public, so the
// self-hosted label must only ever be requested by trusted main-path runs of
// ci.yml, never by pull_request runs or any other workflow, and a stale pool
// must fall back to GitHub-hosted runners.
const LABEL = "opengeni-main-gcp";
const POOL_RUNS_ON =
  "${{ needs.plan.outputs.runner_pool == 'gcp' && " +
  `fromJSON('["self-hosted","linux","x64","${LABEL}"]') || 'ubuntu-latest' }}`;
// Coordination jobs stay GitHub-hosted: plan chooses the pool, and the others
// either run before plan or are short aggregates. api-image signs the agent
// with public-release credentials on main pushes, which stay on hosted runners.
const HOSTED_JOBS = [
  "api-image",
  "automation-admission",
  "automation-report",
  "full-green",
  "merge-content",
  "plan",
  "test",
];

const workflowFiles = readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f));
const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
const jobs = ci.jobs as Record<string, any>;
const needsOf = (job: any): string[] => (job.needs === undefined ? [] : [job.needs].flat());
const selectStep = jobs.plan.steps[0];

test("only ci.yml requests the GCP main runner label", () => {
  const users = workflowFiles.filter((f) =>
    readFileSync(`.github/workflows/${f}`, "utf8").includes(LABEL),
  );
  expect(users).toEqual(["ci.yml"]);
  for (const f of readdirSync(".github/actions")) {
    const dir = `.github/actions/${f}`;
    for (const file of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      expect(readFileSync(`${dir}/${file}`, "utf8")).not.toContain(LABEL);
    }
  }
});

test("no other workflow can select a self-hosted runner", () => {
  for (const f of workflowFiles.filter((name) => name !== "ci.yml")) {
    const workflow = Bun.YAML.parse(readFileSync(`.github/workflows/${f}`, "utf8")) as any;
    for (const [name, job] of Object.entries((workflow?.jobs ?? {}) as Record<string, any>)) {
      const runsOn = JSON.stringify(job?.["runs-on"] ?? null);
      expect({ file: f, job: name, selfHosted: runsOn.includes("self-hosted") }).toEqual({
        file: f,
        job: name,
        selfHosted: false,
      });
    }
  }
});

test("ci.yml jobs either stay hosted or follow plan's runner pool", () => {
  const withRunner = Object.entries(jobs).filter(([, job]) => job["runs-on"] !== undefined);
  const hosted = withRunner
    .filter(([, job]) => job["runs-on"] === "ubuntu-latest")
    .map(([name]) => name);
  const pooled = withRunner.filter(([, job]) => job["runs-on"] === POOL_RUNS_ON);
  expect(hosted.sort()).toEqual(HOSTED_JOBS);
  expect(pooled.length + hosted.length).toBe(withRunner.length);
  expect(pooled.length).toBeGreaterThan(15);
  // needs.plan.outputs is only readable by jobs that depend on plan directly.
  for (const [name, job] of pooled)
    expect({ job: name, needsPlan: needsOf(job).includes("plan") }).toEqual({
      job: name,
      needsPlan: true,
    });
  const raw = readFileSync(".github/workflows/ci.yml", "utf8");
  expect(raw.split(LABEL).length - 1).toBe(pooled.length);
});

test("plan selects the pool from the trusted main path, the switch and the heartbeat", () => {
  expect(jobs.plan.outputs.runner_pool).toBe("${{ steps.runner_pool.outputs.pool }}");
  expect(selectStep.id).toBe("runner_pool");
  expect(selectStep.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    MAIN_CI_RUNNER: "${{ vars.MAIN_CI_RUNNER }}",
    GCP_RUNNER_HEARTBEAT: "${{ vars.GCP_RUNNER_HEARTBEAT }}",
    TRUSTED_MAIN_PATH:
      "${{ github.repository == 'Cloudgeni-ai/opengeni' && github.ref == 'refs/heads/main' && " +
      "(github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}",
  });
  expect(Object.keys(ci.on)).toContain("pull_request");
});

test("the pool selection falls back to GitHub-hosted runners", () => {
  const dir = mkdtempSync(join(tmpdir(), "gcp-pool-"));
  // Stub gh: prints STUB_STARTED as the attempt's run_started_at, or fails when it is "fail".
  writeFileSync(
    join(dir, "gh"),
    '#!/usr/bin/env bash\n[ "$STUB_STARTED" = fail ] && exit 1\nprintf "%s\\n" "$STUB_STARTED"\n',
  );
  chmodSync(join(dir, "gh"), 0o755);
  const now = Math.floor(Date.now() / 1000);
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const select = (env: Record<string, string>) => {
    const output = join(dir, `out-${Math.random()}`);
    const result = spawnSync("bash", ["-c", selectStep.run], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        ...env,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return readFileSync(output, "utf8").trim();
  };
  try {
    const fresh = {
      TRUSTED_MAIN_PATH: "true",
      MAIN_CI_RUNNER: "gcp",
      GCP_RUNNER_HEARTBEAT: String(now - 30),
      STUB_STARTED: iso(now - 20),
    };
    expect(select(fresh)).toBe("pool=gcp");
    expect(select({ ...fresh, TRUSTED_MAIN_PATH: "false" })).toBe("pool=hosted");
    expect(select({ ...fresh, MAIN_CI_RUNNER: "hosted" })).toBe("pool=hosted");
    expect(select({ ...fresh, MAIN_CI_RUNNER: "" })).toBe("pool=hosted");
    expect(select({ ...fresh, GCP_RUNNER_HEARTBEAT: String(now - 600) })).toBe("pool=hosted");
    expect(select({ ...fresh, GCP_RUNNER_HEARTBEAT: "" })).toBe("pool=hosted");
    expect(select({ ...fresh, GCP_RUNNER_HEARTBEAT: "1; echo pool=gcp" })).toBe("pool=hosted");
    // vars are captured at run creation: a plan job queued for 15 minutes still sees
    // the heartbeat from the attempt's start and keeps the GCP pool.
    const queued = {
      ...fresh,
      STUB_STARTED: iso(now - 900),
      GCP_RUNNER_HEARTBEAT: String(now - 930),
    };
    expect(select(queued)).toBe("pool=gcp");
    expect(select({ ...queued, GCP_RUNNER_HEARTBEAT: String(now - 1500) })).toBe("pool=hosted");
    // Without the attempt's start time, the heartbeat is judged against now.
    expect(select({ ...queued, STUB_STARTED: "fail" })).toBe("pool=hosted");
    expect(select({ ...fresh, STUB_STARTED: "fail" })).toBe("pool=gcp");
    expect(select({ ...fresh, STUB_STARTED: "" })).toBe("pool=gcp");
    expect(select({ ...queued, STUB_STARTED: "" })).toBe("pool=hosted");
    expect(select({ ...queued, STUB_STARTED: "yesterday" })).toBe("pool=hosted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
