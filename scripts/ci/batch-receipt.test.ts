import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderManifest, type Manifest } from "../batcher/model";
import {
  classifyMainPush,
  findFinalSha,
  githubReads,
  outputs,
  REQUIRED_BATCH_JOBS,
  type LocalPush,
  type Reads,
} from "./batch-receipt";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const REPO = "Cloudgeni-ai/opengeni";
const ID = "0123456789ab";
const BASE = sha(0xb0);
const TIP = sha(0x71);
const TREES = [sha(0x11), sha(0x12), sha(0x13)];

const manifest: Manifest = {
  schemaVersion: 2,
  id: ID,
  base: BASE,
  members: TREES.map((tree, i) => ({
    number: 100 + i,
    title: `Change ${i}`,
    head: sha(0x50 + i),
    tree,
  })),
  pending: [],
};

/** Main after the batch landed: member i is `i + 1` first parents above the base. */
function push(member: number, extra: Partial<LocalPush> = {}): LocalPush {
  return {
    repository: REPO,
    sha: sha(0xc0 + member),
    tree: TREES[member]!,
    message: `Change ${member} (#${100 + member})\n\nBatch: ${ID}`,
    runAttempt: 1,
    changedSince: (base) => (base === BASE ? ["apps/api/src/index.ts"] : null),
    firstParent: (n) => (n === member + 1 ? BASE : sha(0xd0 + n)),
    ...extra,
  };
}

function ciRun(extra: Record<string, unknown> = {}) {
  return {
    id: 900,
    run_attempt: 1,
    head_sha: TIP,
    head_branch: `batch/${ID}`,
    event: "push",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPO}/actions/runs/900`,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...extra,
  };
}

const passingJobs = () =>
  REQUIRED_BATCH_JOBS.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  }));

function reads(extra: Partial<Reads> = {}): Reads {
  return {
    runs: async () => [ciRun()],
    commit: async (commit) => {
      if (commit !== TIP) throw new Error(`unexpected commit ${commit}`);
      return { tree: TREES.at(-1)!, message: renderManifest(manifest) };
    },
    jobs: async () => passingJobs(),
    planMode: async () => "full",
    mainCommitWithTree: async () => null,
    ...extra,
  };
}

describe("classifyMainPush", () => {
  test("the last member reproduces the tested tip tree and is attested", async () => {
    const receipt = await classifyMainPush(push(2), reads());
    expect(receipt.kind).toBe("attested");
    if (receipt.kind === "full") throw new Error("unreachable");
    expect(receipt.batch).toEqual({
      id: ID,
      branch: `batch/${ID}`,
      runId: 900,
      runAttempt: 1,
      headSha: TIP,
      tree: TREES[2]!,
      url: `https://github.com/${REPO}/actions/runs/900/attempts/1`,
      member: 3,
      members: 3,
    });
    expect(outputs(receipt, sha(0xc2))).toEqual({
      final_sha: sha(0xc2),
      kind: "attested",
      attested: "true",
      batch_run_id: "900",
      batch_run_attempt: "1",
      batch_head_sha: TIP,
      batch_branch: `batch/${ID}`,
      batch_url: `https://github.com/${REPO}/actions/runs/900/attempts/1`,
      tree: TREES[2]!,
    });
  });

  test("earlier members are intermediate, never attested", async () => {
    for (const member of [0, 1]) {
      const receipt = await classifyMainPush(push(member), reads());
      expect(receipt.kind).toBe("intermediate");
      expect(outputs(receipt).attested).toBe("false");
    }
  });

  test("a batch that passed after a failed-job retry is attested at that attempt", async () => {
    const receipt = await classifyMainPush(
      push(2),
      reads({
        runs: async () => [ciRun({ run_attempt: 2 })],
        jobs: async () => passingJobs().map((job, i) => ({ ...job, run_attempt: i === 1 ? 2 : 1 })),
      }),
    );
    expect(receipt.kind).toBe("attested");
    expect(outputs(receipt).batch_run_attempt).toBe("2");
  });

  const fullCases: [string, LocalPush, Partial<Reads>][] = [
    ["a re-run", push(2, { runAttempt: 2 }), {}],
    ["a Version merge", push(2, { message: `chore: version packages\n\nBatch: ${ID}` }), {}],
    ["a direct push", push(2, { message: "Change 2 (#102)" }), {}],
    ["two batch markers", push(2, { message: `x\n\nBatch: ${ID}\nBatch: ${ID}` }), {}],
    [
      "a batch landing CI definitions",
      push(2, { changedSince: () => [".github/workflows/ci.yml"] }),
      {},
    ],
    ["a batch landing a CI script", push(2, { changedSince: () => ["scripts/ci/impact.ts"] }), {}],
    [
      "a batch landing batcher code",
      push(2, { changedSince: () => ["scripts/batcher/pass.ts"] }),
      {},
    ],
    ["unknown landed paths", push(2, { changedSince: () => null }), {}],
    ["a tree the batch never had", push(2, { tree: sha(0x99) }), {}],
    ["members not landed on the batch base", push(2, { firstParent: () => sha(0xee) }), {}],
    ["no batch run", push(2), { runs: async () => [] }],
    [
      "two tested tips",
      push(2),
      { runs: async () => [ciRun(), ciRun({ id: 901, head_sha: sha(0x72) })] },
    ],
    ["a failed batch run", push(2), { runs: async () => [ciRun({ conclusion: "failure" })] }],
    [
      "a running batch run",
      push(2),
      { runs: async () => [ciRun({ status: "in_progress", conclusion: null })] },
    ],
    [
      "a run from another repository",
      push(2),
      { runs: async () => [ciRun({ head_repository: { full_name: "x/y" } })] },
    ],
    [
      "a run of another workflow",
      push(2),
      { runs: async () => [ciRun({ path: ".github/workflows/pr-ci.yml" })] },
    ],
    [
      "a tip that is not the manifest's candidate",
      push(2),
      { commit: async () => ({ tree: sha(0x98), message: renderManifest(manifest) }) },
    ],
    [
      "a tip for another batch",
      push(2),
      {
        commit: async () => ({
          tree: TREES[2]!,
          message: renderManifest({ ...manifest, id: "ba0000000000" }),
        }),
      },
    ],
    [
      "a tip without a manifest",
      push(2),
      { commit: async () => ({ tree: TREES[2]!, message: "batch" }) },
    ],
    ["a missing required job", push(2), { jobs: async () => passingJobs().slice(1) }],
    [
      "a skipped image aggregate",
      push(2),
      {
        jobs: async () =>
          passingJobs().map((job) =>
            job.name === "Workload image builds" ? { ...job, conclusion: "skipped" } : job,
          ),
      },
    ],
    [
      "a duplicated required job",
      push(2),
      { jobs: async () => [...passingJobs(), passingJobs()[0]!] },
    ],
    [
      "a job from a later attempt than the run",
      push(2),
      { jobs: async () => passingJobs().map((job) => ({ ...job, run_attempt: 2 })) },
    ],
    ["an impacted plan", push(2), { planMode: async () => "impacted" }],
    ["a missing plan", push(2), { planMode: async () => null }],
  ];
  for (const [name, local, overrides] of fullCases) {
    test(`${name} runs main CI in full`, async () => {
      const receipt = await classifyMainPush(local, reads(overrides));
      expect(receipt.kind).toBe("full");
      expect(outputs(receipt, sha(1))).toMatchObject({
        kind: "full",
        attested: "false",
        batch_run_id: "",
        tree: "",
        final_sha: "",
      });
    });
  }

  test("tests and Markdown beside CI scripts do not block a receipt", async () => {
    const receipt = await classifyMainPush(
      push(2, { changedSince: () => ["scripts/ci/impact.test.ts", "scripts/batcher/README.md"] }),
      reads(),
    );
    expect(receipt.kind).toBe("attested");
  });
});

describe("findFinalSha", () => {
  test("waits for the batch's final tree to land on main", async () => {
    let calls = 0;
    const slept: number[] = [];
    const found = await findFinalSha(
      {
        mainCommitWithTree: async (tree) => {
          calls++;
          if (calls === 1) throw new Error("GitHub 502");
          return calls === 3 && tree === TREES[2] ? sha(0xc2) : null;
        },
      },
      TREES[2]!,
      5,
      async (ms) => {
        slept.push(ms);
      },
    );
    expect(found).toBe(sha(0xc2));
    expect(slept).toEqual([15_000, 15_000]);
  });

  test("gives up without failing when the final tree never lands", async () => {
    const found = await findFinalSha(
      { mainCommitWithTree: async () => null },
      TREES[2]!,
      3,
      async () => {},
    );
    expect(found).toBeNull();
  });
});

describe("githubReads", () => {
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("lists every page and refuses an incomplete listing", async () => {
    const urls: string[] = [];
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `job ${n}-${i}` }));
    const fetcher = (async (url: string) => {
      urls.push(url);
      const n = Number(new URL(url).searchParams.get("page"));
      return response({ total_count: 150, jobs: page(n, n === 1 ? 100 : 50) });
    }) as unknown as typeof fetch;
    const jobs = await githubReads(REPO, "t", fetcher).jobs(900);
    expect(jobs).toHaveLength(150);
    expect(urls[0]).toContain("actions/runs/900/jobs?filter=latest&per_page=100&page=1");

    const short = (async () =>
      response({ total_count: 150, jobs: page(1, 20) })) as unknown as typeof fetch;
    await expect(githubReads(REPO, "t", short).jobs(900)).rejects.toThrow("incomplete listing");
  });

  test("finds the recent main commit with a tree", async () => {
    const fetcher = (async (url: string) => {
      expect(url).toContain("commits?sha=main&per_page=30");
      return response([
        { sha: sha(0xc3), commit: { tree: { sha: sha(0x99) } } },
        { sha: sha(0xc2), commit: { tree: { sha: TREES[2] } } },
      ]);
    }) as unknown as typeof fetch;
    expect(await githubReads(REPO, "t", fetcher).mainCommitWithTree(TREES[2]!)).toBe(sha(0xc2));
    expect(await githubReads(REPO, "t", fetcher).mainCommitWithTree(sha(0x42))).toBeNull();
  });

  test("an API error throws, which the entry point turns into a full run", async () => {
    const fetcher = (async () => response({ message: "nope" }, 502)) as unknown as typeof fetch;
    await expect(githubReads(REPO, "t", fetcher).runs(`batch/${ID}`)).rejects.toThrow("GitHub 502");
  });

  test("a missing, duplicated, foreign or expired impact plan reads as no plan", async () => {
    const artifact = (extra: Record<string, unknown> = {}) => ({
      name: "ci-impact-plan",
      expired: false,
      archive_download_url: "https://api.github.com/archive",
      workflow_run: { head_sha: TIP },
      ...extra,
    });
    const downloads: string[] = [];
    const listing = (artifacts: unknown[]) =>
      (async (url: string) => {
        if (url.includes("/artifacts?"))
          return response({ total_count: artifacts.length, artifacts });
        downloads.push(url);
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch;
    for (const artifacts of [
      [],
      [artifact(), artifact()],
      [artifact({ workflow_run: { head_sha: sha(0x72) } })],
      [artifact({ expired: true })],
    ])
      expect(await githubReads(REPO, "t", listing(artifacts)).planMode(900, TIP)).toBeNull();
    expect(downloads).toEqual([]);
  });

  test("the plan archive redirect never receives the token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("/artifacts?"))
        return response({
          total_count: 1,
          artifacts: [
            {
              name: "ci-impact-plan",
              expired: false,
              archive_download_url: "https://api.github.com/archive",
              workflow_run: { head_sha: TIP },
            },
          ],
        });
      if (url === "https://api.github.com/archive")
        return new Response(null, {
          status: 302,
          headers: { location: "https://storage.example/zip" },
        });
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    expect(await githubReads(REPO, "t", fetcher).planMode(900, TIP)).toBeNull();
    expect(calls.find((call) => call.url === "https://storage.example/zip")?.auth).toBeNull();
    expect(calls.find((call) => call.url === "https://api.github.com/archive")?.auth).toBe(
      "Bearer t",
    );
  });

  test("an unreachable listing throws, which the entry point turns into a full run", async () => {
    const fetcher = (async () => response({ message: "nope" }, 503)) as unknown as typeof fetch;
    await expect(githubReads(REPO, "t", fetcher).jobs(900)).rejects.toThrow("GitHub 503");
  });
});

describe("ci.yml records the batch result", () => {
  const ci = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8"),
  ) as any;
  const LANES = [
    "source-contracts",
    "unit-shards",
    "integration-shards",
    "e2e-shards",
    "test-suite",
    "browser-acceptance",
    "package-contracts",
    "browserd-real-e2e",
  ];

  /** Evaluate a checked-in `if:` with GitHub's status and string functions. */
  function evaluate(
    expression: string,
    context: Record<string, unknown>,
    cancelled = false,
  ): boolean {
    const body = expression
      .trim()
      .replace(/^\$\{\{/, "")
      .replace(/\}\}$/, "")
      .replace(/needs\.([a-z-]+)/g, (_m, key: string) => `needs[${JSON.stringify(key)}]`);
    return new Function(
      "github",
      "needs",
      "vars",
      "always",
      "cancelled",
      "startsWith",
      "contains",
      `return (${body});`,
    )(
      context.github,
      context.needs,
      context.vars ?? {},
      () => true,
      () => cancelled,
      (value: string, prefix: string) => String(value).startsWith(prefix),
      (value: string, part: string) => String(value).includes(part),
    ) as boolean;
  }

  const mainPush = (message = `Change (#1)\n\nBatch: ${ID}`, attempt = 1) => ({
    event_name: "push",
    ref: "refs/heads/main",
    run_attempt: attempt,
    event: { head_commit: { message } },
  });

  test("the receipt job runs only for main pushes and reads Actions", () => {
    const job = ci.jobs["batch-receipt"];
    expect(job.name).toBe("Batch receipt");
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    expect(evaluate(job.if, { github: mainPush(), needs: {} })).toBe(true);
    for (const github of [
      { event_name: "push", ref: `refs/heads/batch/${ID}` },
      { event_name: "pull_request", ref: "refs/pull/1/merge" },
      { event_name: "schedule", ref: "refs/heads/main" },
    ])
      expect(evaluate(job.if, { github, needs: {} })).toBe(false);
    const step = job.steps.find((s: any) => s.id === "receipt");
    expect(step.run).toBe("bun scripts/ci/batch-receipt.ts");
  });

  test("the cadence never cancels a batcher landing and keeps every other deferral", () => {
    const cadence = ci.jobs["main-ci-cadence"];
    expect(cadence.needs).toEqual(["batch-receipt"]);
    const receipt = (result: string, kind: string) => ({
      "batch-receipt": { result, outputs: { kind } },
    });
    const deferred = { MAIN_CI_DEFERRED: "true" };
    const run = (github: object, needs: object, vars: object = deferred) =>
      evaluate(cadence.if, { github, needs, vars });
    expect(run(mainPush(), receipt("success", "attested"))).toBe(false);
    expect(run(mainPush(), receipt("success", "intermediate"))).toBe(false);
    // Direct pushes and unreadable evidence stay deferred.
    expect(run(mainPush(), receipt("success", "full"))).toBe(true);
    expect(run(mainPush(), receipt("failure", ""))).toBe(true);
    expect(run(mainPush(), receipt("failure", "attested"))).toBe(true);
    // Unchanged: re-runs, Version merges and the variable switch.
    expect(run(mainPush(undefined, 2), receipt("success", "full"))).toBe(false);
    expect(run(mainPush("chore: version packages"), receipt("success", "full"))).toBe(false);
    expect(run(mainPush(), receipt("success", "full"), {})).toBe(false);
    expect(
      evaluate(
        cadence.if,
        { github: mainPush(), needs: receipt("success", "full"), vars: deferred },
        true,
      ),
    ).toBe(false);
  });

  test("an intermediate member runs nothing else and is never red", () => {
    const intermediate = {
      "batch-receipt": { result: "success", outputs: { kind: "intermediate" } },
    };
    const other = (kind: string, result = "success") => ({
      "batch-receipt": { result, outputs: { kind } },
    });
    const planNeeds = (receiptNeeds: object) => ({
      ...receiptNeeds,
      "main-ci-cadence": { result: "skipped" },
      "automation-admission": { result: "skipped" },
    });
    const run = (name: string, needs: object) =>
      evaluate(ci.jobs[name].if, { github: mainPush(), needs });
    expect(run("plan", planNeeds(intermediate))).toBe(false);
    expect(run("test", intermediate)).toBe(false);
    expect(run("merge-content", intermediate)).toBe(false);
    for (const receiptNeeds of [
      other("attested"),
      other("full"),
      other("", "failure"),
      other("intermediate", "failure"),
    ]) {
      expect(run("plan", planNeeds(receiptNeeds))).toBe(true);
      expect(run("test", receiptNeeds)).toBe(true);
      expect(run("merge-content", receiptNeeds)).toBe(true);
    }
    // Every other job needs a successful plan, which an intermediate never has.
    expect(ci.jobs.test.needs).toContain("batch-receipt");
    for (const [name, job] of Object.entries(ci.jobs) as [string, any][]) {
      if (
        [
          "automation-admission",
          "main-ci-cadence",
          "batch-receipt",
          "plan",
          "test",
          "merge-content",
          "automation-report",
        ].includes(name)
      )
        continue;
      expect(job.if, name).toContain("needs.plan.result == 'success'");
    }
    expect(ci.jobs["automation-report"].if).toContain("github.event_name == 'workflow_dispatch'");
  });

  test("an attested plan skips exactly the test lanes", () => {
    const plan = (attested: string) => ({
      result: "success",
      outputs: {
        attested,
        mode: "full",
        unit_count: "900",
        integration_count: "20",
        e2e_count: "60",
        browser_lane_count: "4",
        browserd_real_e2e: "true",
        build_count: "30",
        bake_images: "true",
      },
    });
    for (const name of LANES) {
      const needs = (attested: string) => ({
        plan: plan(attested),
        "automation-admission": { result: "skipped" },
      });
      expect(evaluate(ci.jobs[name].if, { github: mainPush(), needs: needs("false") }), name).toBe(
        true,
      );
      expect(evaluate(ci.jobs[name].if, { github: mainPush(), needs: needs("true") }), name).toBe(
        false,
      );
    }
    for (const name of [
      "deployment",
      "artifact-runtime",
      "api-image",
      "worker-image",
      "images",
      "full-green",
    ])
      expect(ci.jobs[name].if ?? "", name).not.toContain("attested");
  });

  test("the plan binds a receipt only for this exact main tree and full-green names the batch run", () => {
    const bind = ci.jobs.plan.steps.find((s: any) => s.id === "receipt");
    expect(bind.env.RESULT).toBe("${{ needs.batch-receipt.result }}");
    expect(bind.run).toContain('[ "$RESULT" = success ] && [ "$ATTESTED" = true ]');
    expect(bind.run).toContain('[ "$(git rev-parse "$GITHUB_SHA^{tree}")" = "$BATCH_TREE" ]');
    expect(bind.run).toContain('[ "$GITHUB_REF" = refs/heads/main ]');
    expect(ci.jobs.plan.outputs.attested).toBe("${{ steps.receipt.outputs.attested }}");
    const publish = ci.jobs["full-green"].steps.find(
      (s: any) => s.name === "Publish exact-SHA full CI evidence",
    );
    expect(publish.run).toContain('workflow:".github/workflows/ci.yml",batchBranch:$branch');
    expect(ci.jobs["full-green"].if).toContain("needs.plan.outputs.mode == 'full'");
  });

  test("a batch run plans the full suite and builds every image without pushing", () => {
    const planStep = ci.jobs.plan.steps.find((s: any) => s.id === "plan");
    expect(planStep.run).toMatch(
      /refs\/heads\/batch\/\* \]\]; then\n(?:\s*#.*\n)*\s*bun scripts\/ci\/impact\.ts --full --output impact-plan\.json/,
    );
    expect(planStep.run).toContain('[[ "$GITHUB_REF" == refs/heads/batch/* ]]; }; then');
    for (const name of Object.keys(ci.jobs).filter((job) => job.endsWith("-image"))) {
      const build = ci.jobs[name].steps.find((s: any) => s.with?.push !== undefined);
      expect(build.with.push, name).toBe(
        "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
      );
    }
  });
});
