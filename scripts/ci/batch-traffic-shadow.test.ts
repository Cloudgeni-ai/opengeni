import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AtomicGitWriter, GitStore } from "../merge-batcher/git";
import { GitHubAuth, GitHubReader } from "../merge-batcher/github";
import { QueueOnlyPublisher } from "../merge-batcher/shadow-ci";
import { type Run } from "../merge-batcher/model";
import { verifyResult } from "../merge-batcher/result";
import {
  ADAPTER_PATHS,
  TRAFFIC_PREFIX,
  TRAFFIC_STATE,
  collectTraffic,
  compareOutcome,
  fifoCohorts,
  proxyPull,
  publishOneTraffic,
  replayTraffic,
  trafficConfig,
  type MainCI,
  type MergedPull,
  type TrafficInput,
} from "./batch-traffic-shadow";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const date = (n: number) => `2026-10-21T10:${String(n).padStart(2, "0")}:00.000Z`;
async function tree(git: GitStore, files: Record<string, string>): Promise<string> {
  const groups = new Map<string, Record<string, string>>(),
    entries: string[] = [];
  for (const [path, content] of Object.entries(files).sort()) {
    const slash = path.indexOf("/");
    if (slash >= 0) {
      const name = path.slice(0, slash);
      const group = groups.get(name) ?? {};
      group[path.slice(slash + 1)] = content;
      groups.set(name, group);
    } else
      entries.push(
        `100644 blob ${await git.exec(["hash-object", "-w", "--stdin"], content)}\t${path}`,
      );
  }
  for (const [name, group] of groups)
    entries.push(`040000 tree ${await tree(git, group)}\t${name}`);
  return git.exec(["mktree"], entries.sort().join("\n") + "\n");
}
async function fixture(options: { conflict?: boolean; adapter?: boolean; gap?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "traffic-shadow-test-"));
  roots.push(root);
  const origin = new GitStore(join(root, "origin.git")),
    git = new GitStore(join(root, "cache.git"));
  await origin.init();
  await git.init();
  const files: Record<string, string> = { "base.txt": "base\n" };
  if (options.adapter) for (const path of ADAPTER_PATHS) files[path] = "adapter fixture\n";
  const base = await origin.commit(await tree(origin, files), [], "base", date(0));
  const firstFiles = {
    ...files,
    "one.txt": "one\n",
    ...(options.conflict ? { "base.txt": "first\n" } : {}),
  };
  const head1 = await origin.commit(await tree(origin, firstFiles), [base], "one", date(1));
  const head2 = await origin.commit(
    await tree(origin, {
      ...files,
      "two.txt": "two\n",
      ...(options.conflict ? { "base.txt": "second\n" } : {}),
    }),
    [base],
    "two",
    date(2),
  );
  // A squash followed by a true merge; replay must preserve trees, not commit hashes.
  const merge1 = await origin.commit(await tree(origin, firstFiles), [base], "squash one", date(3));
  const middle = options.gap
    ? await origin.commit(
        await tree(origin, { ...firstFiles, "gap.txt": "unselected\n" }),
        [merge1],
        "direct",
        date(4),
      )
    : merge1;
  const merge2 = await origin.commit(
    await tree(origin, {
      ...firstFiles,
      "two.txt": "two\n",
      ...(options.conflict ? { "base.txt": "resolved\n" } : {}),
      ...(options.gap ? { "gap.txt": "unselected\n" } : {}),
    }),
    [middle, head2],
    "merge two",
    date(5),
  );
  await origin.exec(["update-ref", "refs/heads/main", merge2]);
  await origin.exec(["update-ref", "refs/heads/one", head1]);
  await origin.exec(["update-ref", "refs/heads/two", head2]);
  const pull = (number: number, headSha: string, mergeSha: string, minute: number): MergedPull => ({
    number,
    headSha,
    headRef: `pr-${number}`,
    mergeSha,
    mergedAt: date(minute),
    createdAt: date(0),
    readiness: {
      kind: "merged-at-proxy",
      at: date(minute),
      admissionEvidence: false,
      reviewEvidence: false,
    },
  });
  const pulls = [pull(1, head1, merge1, 3), pull(2, head2, merge2, 5)];
  const input: TrafficInput = {
    since: date(0),
    until: date(10),
    pulls,
    runs: [],
    observedMerged: 2,
    omittedByCap: 0,
  };
  const settings = trafficConfig({}, "shadow-ci", git.dir, root);
  const publisher = new QueueOnlyPublisher(
    settings,
    new AtomicGitWriter(git, origin.dir, TRAFFIC_STATE, "refs/heads/main"),
  );
  return { root, origin, git, base, merge1, merge2, pulls, input, settings, publisher };
}
function run(tip: string, branch: string, patch: Partial<Run> = {}): Run {
  return {
    id: 1,
    attempt: 1,
    headSha: tip,
    branch,
    workflow: ".github/workflows/batch-ci.yml",
    status: "completed",
    outcome: "success",
    trusted: true,
    retryable: false,
    completedAt: date(8),
    ...patch,
  };
}

describe("merged traffic replay", () => {
  test("real squash/merge history reconstructs equivalent trees; remote refs unchanged", async () => {
    const f = await fixture(),
      before = await f.git.remoteRefs(f.origin.dir);
    const report = await replayTraffic(f.git, f.origin.dir, f.input, 16);
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(before);
    expect(report.counts).toMatchObject({ built: 1, equivalent: 1, conflicts: 0, adapterReady: 0 });
    expect(report.cohorts[0]!.baseSha).toBe(f.base);
    expect(report.cohorts[0]!.members.map((m) => m.actualShape)).toEqual([
      "single-parent-squash-or-rebase",
      "exact-head-merge",
    ]);
    expect(report.cohorts[0]!.manifest!.tipSha).not.toBe(f.merge2);
    expect(report.readinessMeaning).toContain("PROXY");
    expect(proxyPull(f.pulls[0]!).binding.evidenceId).toContain("NOT-ADMISSION-OR-REVIEW");
  });
  test("FIFO ties follow main order, dedup is deterministic, Version stays singleton and cap <=16", async () => {
    const f = await fixture(),
      [one, two] = f.pulls;
    const tied = { ...two!, mergedAt: one!.mergedAt };
    const order = new Map([
      [one!.mergeSha, 1],
      [two!.mergeSha, 2],
    ]);
    expect(
      fifoCohorts([tied, one!, one!], 16, order)
        .flat()
        .map((p) => p.number),
    ).toEqual([1, 2]);
    expect(
      fifoCohorts([one!, { ...two!, headRef: "changeset-release/main" }], 16, order).map(
        (c) => c.length,
      ),
    ).toEqual([1, 1]);
    expect(() => fifoCohorts(f.pulls, 17, order)).toThrow();
    expect(() => fifoCohorts([one!, { ...one!, headSha: two!.headSha }], 2, order)).toThrow(
      "Conflicting duplicate",
    );
    const a = await replayTraffic(f.git, f.origin.dir, f.input, 16),
      b = await replayTraffic(f.git, f.origin.dir, f.input, 16);
    expect(a.cohorts[0]!.manifest).toEqual(b.cohorts[0]!.manifest);
  });
  test("real conflicts are composition disagreements, not unique culprit verdicts", async () => {
    const f = await fixture({ conflict: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input);
    expect(report.counts.conflicts).toBe(1);
    expect(report.cohorts[0]!.conflictAt).toBe(2);
    expect(report.cohorts[0]!.reason).toContain("not proof");
    expect(compareOutcome(report.cohorts[0]!, undefined).uniqueCulprit).toBeNull();
  });
  test("gaps and unretained older projections are not silently equivalent", async () => {
    const f = await fixture({ gap: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input);
    expect(report.cohorts[0]!.compositionComplete).toBe(false);
    expect(report.cohorts[0]!.equivalent).toBe(false);
    const old = await replayTraffic(f.git, f.origin.dir, {
      ...f.input,
      pulls: [{ ...f.pulls[0]!, mergeSha: "f".repeat(40) }],
    });
    expect(old.counts.unavailable).toBe(1);
  });
  test("collects real provider fields, excludes unmerged/out-of-window PRs, GET-only and job timing", async () => {
    const f = await fixture(),
      calls: string[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const parsed = new URL(String(url));
      calls.push(parsed.pathname);
      if (parsed.pathname.endsWith("/pulls"))
        return Response.json(
          [...f.pulls]
            .reverse()
            .map((p) => ({
              number: p.number,
              created_at: p.createdAt,
              updated_at: p.mergedAt,
              merged_at: p.mergedAt,
              merge_commit_sha: p.mergeSha,
              base: { ref: "main", repo: { full_name: "Cloudgeni-ai/opengeni" } },
              head: { sha: p.headSha, ref: p.headRef },
            }))
            .concat([{ number: 90, merged_at: null } as any]),
        );
      if (parsed.pathname.includes("/attempts/"))
        return Response.json({
          jobs: [{ status: "completed", started_at: date(6), completed_at: date(7) }],
        });
      return Response.json({
        workflow_runs: [
          {
            id: Number(parsed.searchParams.get("head_sha") === f.merge1 ? 1 : 2),
            run_attempt: 1,
            head_sha: parsed.searchParams.get("head_sha"),
            head_branch: "main",
            path: ".github/workflows/ci.yml",
            event: "push",
            status: "completed",
            conclusion: "cancelled",
            created_at: date(5),
            updated_at: date(59),
          },
        ],
      });
    }) as typeof fetch;
    const reader = new GitHubReader(f.settings, new GitHubAuth({}), transport);
    const input = await collectTraffic(reader, date(0), date(10), 1);
    expect(input.observedMerged).toBe(2);
    expect(input.omittedByCap).toBe(1);
    expect(input.pulls[0]!.number).toBe(2);
    expect(input.pulls[0]!.readiness).toMatchObject({
      kind: "merged-at-proxy",
      admissionEvidence: false,
      reviewEvidence: false,
    });
    expect(input.runs[0]).toMatchObject({
      conclusion: "cancelled",
      durationSeconds: 60,
      completedAt: date(7),
      timingSource: "current-attempt-jobs",
    });
    expect(calls.some((p) => p.includes("/attempts/1/jobs"))).toBe(true);
  });
});

describe("restricted optional traffic CI", () => {
  test("old base waits with zero publications, never overlays the adapter", async () => {
    const f = await fixture(),
      report = await replayTraffic(f.git, f.origin.dir, f.input);
    const result = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      {
        publish: async () => {
          throw new Error("must not publish");
        },
      },
    );
    expect(result.action).toBe("wait");
    expect(result.reason).toContain("no overlays");
  });
  test("one local publication is CAS-fenced, restart-deduplicated and never changes main", async () => {
    const f = await fixture({ adapter: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input);
    const read = { runs: async () => [] };
    const first = await publishOneTraffic(
      f.settings,
      f.git,
      read,
      f.origin.dir,
      report,
      f.publisher,
    );
    expect(first.action).toBe("published");
    const refs = await f.git.remoteRefs(f.origin.dir);
    expect(refs.get("refs/heads/main")).toBe(f.merge2);
    expect([...refs.keys()].filter((r) => r.startsWith("refs/heads/queue/"))).toEqual([
      `refs/heads/${TRAFFIC_PREFIX}${first.batchId}`,
    ]);
    expect(refs.has(TRAFFIC_STATE)).toBe(true);
    const restart = new GitStore(join(f.root, "restart.git"));
    await restart.init();
    const publisher = new QueueOnlyPublisher(
      f.settings,
      new AtomicGitWriter(restart, f.origin.dir, TRAFFIC_STATE, "refs/heads/main"),
    );
    const wait = await publishOneTraffic(
      f.settings,
      restart,
      read,
      f.origin.dir,
      report,
      publisher,
    );
    expect(wait.action).toBe("wait");
    expect(wait.reason).toContain("slot occupied");
    const done = await publishOneTraffic(
      f.settings,
      restart,
      { runs: async (m, branch) => [run(m.tipSha, branch)] },
      f.origin.dir,
      report,
      publisher,
    );
    expect(done.reason).toContain("deduplication");
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(refs);
    const regrouped = await replayTraffic(restart, f.origin.dir, f.input, 1);
    const noRepeat = await publishOneTraffic(
      f.settings,
      restart,
      { runs: async (m, branch) => [run(m.tipSha, branch)] },
      f.origin.dir,
      regrouped,
      publisher,
    );
    expect(noRepeat.reason).toContain("deduplication");
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(refs);
  });
  test("concurrent publishers cannot consume two hosted slots", async () => {
    const f = await fixture({ adapter: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input, 1);
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        publishOneTraffic(
          f.settings,
          f.git,
          { runs: async () => [] },
          f.origin.dir,
          report,
          f.publisher,
        ),
      ),
    );
    expect(
      outcomes.filter((o) => o.status === "fulfilled" && o.value.action === "published"),
    ).toHaveLength(1);
    expect(
      [...(await f.git.remoteRefs(f.origin.dir)).keys()].filter((r) =>
        r.startsWith(`refs/heads/${TRAFFIC_PREFIX}`),
      ),
    ).toHaveLength(1);
  });
  test("namespace/config changes cannot publish into live or main", async () => {
    const f = await fixture({ adapter: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input);
    for (const patch of [
      { branchPrefix: "queue/live/" },
      { stateRef: "refs/heads/main" },
      { maxInflight: 2 },
    ])
      await expect(
        publishOneTraffic(
          { ...f.settings, ...patch },
          f.git,
          { runs: async () => [] },
          f.origin.dir,
          report,
          f.publisher,
        ),
      ).rejects.toThrow("Restricted");
    expect(
      trafficConfig(
        { BATCHER_MODE: "active", BATCHER_BRANCH_PREFIX: "queue/live/" },
        "shadow",
        f.git.dir,
        f.root,
      ).mode,
    ).toBe("shadow");
  });
  test("comparison requires exact trusted outcomes and equivalent trees; cancellation/infra never culpable", async () => {
    const f = await fixture(),
      report = await replayTraffic(f.git, f.origin.dir, f.input),
      cohort = report.cohorts[0]!;
    cohort.mainRuns = [
      {
        id: 3,
        attempt: 1,
        headSha: cohort.actualTipSha,
        status: "completed",
        conclusion: "success",
      } as MainCI,
    ];
    const good = run(cohort.manifest!.tipSha, `${TRAFFIC_PREFIX}${cohort.manifest!.batchId}`);
    expect(compareOutcome(cohort, good).agreement).toBe(true);
    for (const patch of [
      { headSha: f.base },
      { trusted: false },
      { outcome: "cancelled" as const },
      { outcome: "infrastructure" as const },
    ]) {
      const comparison = compareOutcome(cohort, { ...good, ...patch });
      expect(comparison.comparable).toBe(false);
      expect(comparison.uniqueCulprit).toBeNull();
    }
    expect(compareOutcome({ ...cohort, equivalent: false }, good).comparable).toBe(false);
    expect(
      verifyResult(
        { schemaVersion: 1, batchId: cohort.manifest!.batchId, headSha: f.base },
        cohort.manifest!,
        1,
        1,
      ),
    ).toBeNull();
  });
});
