import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AtomicGitWriter, GitStore } from "../merge-batcher/git";
import { GitHubAuth, GitHubReader } from "../merge-batcher/github";
import { LiveReader } from "../merge-batcher/controller";
import { config as coreConfig } from "../merge-batcher/model";
import { type Run } from "../merge-batcher/model";
import { verifyResult } from "../merge-batcher/result";
import {
  ADAPTER_PATHS,
  adapterPresent,
  TRAFFIC_PREFIX,
  TRAFFIC_STATE,
  collectTraffic,
  compareOutcome,
  fifoCohorts,
  proxyPull,
  publishOneTraffic as publishRaw,
  TrafficPublisher,
  TrafficCache,
  TrafficReadControl,
  TrafficBackoff,
  CachedTrafficReader,
  readHeadroom,
  replayTraffic,
  trafficConfig,
  type MainCI,
  type MergedPull,
  type TrafficInput,
} from "./batch-traffic-shadow";

const roots: string[] = [];
const goodHeadroom = {
  allowed: true,
  reason: "fixture reservation",
  occupied: 0,
  reservedMain: 40,
  candidateSlots: 18,
  budget: 60,
};
function publishOneTraffic(...args: Parameters<typeof publishRaw>) {
  args[6] = { headroom: async () => goodHeadroom, ...args[6] };
  return publishRaw(...args);
}
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
  if (options.adapter)
    for (const path of ADAPTER_PATHS)
      files[path === "scripts" ? "scripts/merge-batcher/main.ts" : path] = "adapter fixture\n";
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
  const publisher = new TrafficPublisher(
    settings,
    new AtomicGitWriter(git, origin.dir, TRAFFIC_STATE, "refs/heads/main"),
  );
  return { root, origin, git, base, merge1, merge2, pulls, input, settings, publisher, files };
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
  test("post-base main ancestry is a historical replay artifact, not live queue infeasibility", async () => {
    const f = await fixture();
    const changed = { ...f.files, "one.txt": "changed after squash\n", "two.txt": "two\n" };
    const head = await f.origin.commit(
      await tree(f.origin, changed),
      [f.merge1],
      "later head",
      date(4),
    );
    const landing = await f.origin.commit(
      await tree(f.origin, changed),
      [f.merge1],
      "later squash (#2)",
      date(5),
    );
    await f.origin.exec(["update-ref", "refs/heads/main", landing]);
    await f.origin.exec(["update-ref", "refs/heads/later-head", head]);
    const report = await replayTraffic(f.git, f.origin.dir, {
      ...f.input,
      pulls: [f.pulls[0]!, { ...f.pulls[1]!, headSha: head, mergeSha: landing }],
    });
    const cohort = report.cohorts[0]!;
    const projection = cohort.historicalHeads.find((h) => h.number === 2)!;
    expect(projection.postBaseMainAncestors).toEqual([f.merge1]);
    expect(projection.onActualParent).toMatchObject({ clean: true, treeEqual: true });
    expect(cohort.exclusions.find((e) => e.number === 2)?.reason).toContain("replay artifact");
    expect(cohort.equivalent).toBe(false);
    expect(report.replayMeaning).toContain("NOT an arrival/service-time queue simulation");
  });
  test("coverage reports uncollected main landings separately from known intentional caps", async () => {
    const f = await fixture();
    const missing = await replayTraffic(f.git, f.origin.dir, { ...f.input, pulls: [f.pulls[0]!] });
    expect(missing.collectionCoverage.unrepresented.some((r) => r.sha === f.merge2)).toBe(true);
    expect(missing.collectionCoverage.status).toBe("unmapped-main-commits");
    const capped = await replayTraffic(f.git, f.origin.dir, {
      ...f.input,
      pulls: [f.pulls[1]!],
      omittedByCap: 1,
      observedMerges: f.pulls.map(({ number, mergeSha, mergedAt }) => ({
        number,
        mergeSha,
        mergedAt,
      })),
    });
    expect(capped.collectionCoverage.knownOmittedByCap).toBe(1);
    expect(capped.collectionCoverage.unrepresented.some((r) => r.sha === f.merge1)).toBe(false);
    expect(capped.collectionCoverage.limitation).toContain("not snapshot-consistent");
  });
  test("adapter pin covers whole core and CI scripts, including formerly omitted transitive entry points", async () => {
    const f = await fixture({ adapter: true });
    expect(await adapterPresent(f.origin, f.base, f.base)).toBe(true);
    for (const path of [
      "scripts/merge-batcher/controller.ts",
      "scripts/ci/impact.ts",
      "scripts/ci/profile-command.ts",
      "scripts/ci/run-unit-shard.ts",
      "scripts/run-test-shard.ts",
    ]) {
      const changed = await f.origin.commit(
        await tree(f.origin, { ...f.files, [path]: "changed verifier\n" }),
        [f.base],
        "control change",
        date(2),
      );
      expect(await adapterPresent(f.origin, f.base, changed)).toBe(false);
    }
  });
  test("core LiveReader ignores nested traffic refs under default queue and recognizes the explicit traffic prefix", async () => {
    const f = await fixture();
    const report = await replayTraffic(f.git, f.origin.dir, f.input);
    const manifest = report.cohorts[0]!.manifest!;
    await f.origin.fetch(f.git.dir, [manifest.tipSha]);
    await f.origin.exec([
      "update-ref",
      `refs/heads/${TRAFFIC_PREFIX}${manifest.batchId}`,
      manifest.tipSha,
    ]);
    const git = new GitStore(join(f.root, "interop.git"));
    await git.init();
    const fetchLocal = git.fetch.bind(git);
    git.remoteRefs = async () => f.git.remoteRefs(f.origin.dir);
    git.fetch = async (_remote: string, refs: string[]) => fetchLocal(f.origin.dir, refs);
    for (const branchPrefix of ["queue/", TRAFFIC_PREFIX]) {
      const settings = {
        ...coreConfig({ BATCHER_MODE: "shadow" }),
        branchPrefix,
        gitDir: git.dir,
        outputDir: join(f.root, "interop-output"),
        stateRef: "refs/heads/interop-state",
      };
      const reader = new GitHubReader(settings, new GitHubAuth({}), (async () => {
        throw Error("No provider calls allowed");
      }) as unknown as typeof fetch);
      reader.ready = async () => ({ ready: [], excluded: [] });
      reader.runs = reader.observedRuns = async () => [];
      const observation = await new LiveReader(reader, git, settings).observe();
      expect(observation.candidates).toHaveLength(branchPrefix === "queue/" ? 0 : 1);
    }
  });
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
    expect(report.counts.rebuiltRemainders).toBe(1);
    expect(report.cohorts[0]!.exclusions[0]).toMatchObject({
      number: 2,
      headSha: f.pulls[1]!.headSha,
    });
    expect(report.cohorts[0]!.manifest!.pulls.map((p) => p.number)).toEqual([1]);
    expect(report.cohorts[0]!.equivalent).toBe(false);
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

describe("traffic recovery and bounded reads", () => {
  test("quarantines malformed refs and rebuilds a conflicting remainder without claiming equivalence", async () => {
    const f = await fixture({ adapter: true, conflict: true });
    await f.origin.exec(["update-ref", `refs/heads/${TRAFFIC_PREFIX}bad-name`, f.base]);
    await f.origin.exec(["update-ref", `refs/heads/${TRAFFIC_PREFIX}${"a".repeat(64)}`, f.base]);
    const report = await replayTraffic(f.git, f.origin.dir, f.input);
    const result = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      f.publisher,
    );
    expect(result.action).toBe("published");
    expect(result.quarantineCount).toBe(2);
    expect(result.reason).toContain("NOT equivalent");
    expect(
      compareOutcome(
        report.cohorts[0]!,
        run(report.cohorts[0]!.manifest!.tipSha, `${TRAFFIC_PREFIX}${result.batchId}`),
      ).comparable,
    ).toBe(false);
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.merge2);
  });
  test("no-run deadline survives restart, requires explicit recovery and never recovers active CI", async () => {
    const f = await fixture({ adapter: true });
    const report = await replayTraffic(f.git, f.origin.dir, f.input, 1);
    const reader = { runs: async () => [] };
    const first = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { now: date(10), noRunHoldSeconds: 60 },
    );
    const id = first.batchId!;
    const early = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { now: date(10), noRunHoldSeconds: 60 },
    );
    expect(early.recoveryRequired).toEqual([]);
    const expired = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { now: date(12), noRunHoldSeconds: 60 },
    );
    expect(expired.action).toBe("wait");
    expect(expired.recoveryRequired).toEqual([id]);
    const recovery = { batchId: id, reason: "Operator verified infrastructure idle" };
    const active = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async (m, b) => [run(m.tipSha, b, { status: "in_progress", outcome: "unknown" })] },
      f.origin.dir,
      report,
      f.publisher,
      { now: date(13), noRunHoldSeconds: 60, recoverNoRun: recovery },
    );
    expect(active.action).toBe("wait");
    const denied = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      {
        now: date(14),
        noRunHoldSeconds: 60,
        recoverNoRun: recovery,
        headroom: async () => ({ ...goodHeadroom, allowed: false }),
      },
    );
    expect(denied.action).toBe("wait");
    const recovered = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { now: date(15), noRunHoldSeconds: 60, recoverNoRun: recovery },
    );
    expect(recovered.action).toBe("recovered");
    expect(
      [...(await f.git.remoteRefs(f.origin.dir)).keys()].filter((r) =>
        r.startsWith(`refs/heads/${TRAFFIC_PREFIX}`),
      ),
    ).toHaveLength(1);
    const next = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { now: date(16) },
    );
    expect(next.action).toBe("published");
    expect(next.batchId).not.toBe(id);
  });
  test("ambiguous successful push reconciles without a second candidate; transport errors never cancel", async () => {
    const f = await fixture({ adapter: true });
    const report = await replayTraffic(f.git, f.origin.dir, f.input, 1);
    await expect(
      publishOneTraffic(f.settings, f.git, { runs: async () => [] }, f.origin.dir, report, {
        publish: async (...args) => {
          await f.publisher.publish(...args);
          throw new Error("lost acknowledgement");
        },
      }),
    ).rejects.toThrow("lost acknowledgement");
    const refs = await f.git.remoteRefs(f.origin.dir);
    const result = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      f.publisher,
    );
    expect(result.action).toBe("wait");
    await expect(
      publishOneTraffic(
        f.settings,
        f.git,
        {
          runs: async () => {
            throw new Error("provider unavailable");
          },
        },
        f.origin.dir,
        report,
        f.publisher,
      ),
    ).rejects.toThrow("provider unavailable");
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(refs);
  });
  test("bounded scans make durable progress and settled history consumes no run queries", async () => {
    const f = await fixture({ adapter: true });
    const report = await replayTraffic(f.git, f.origin.dir, f.input, 1);
    for (const c of report.cohorts) {
      await f.origin.fetch(f.git.dir, [c.manifest!.tipSha]);
      await f.origin.exec([
        "update-ref",
        `refs/heads/${TRAFFIC_PREFIX}${c.manifest!.batchId}`,
        c.manifest!.tipSha,
      ]);
    }
    let queries = 0;
    const reader = {
      runs: async (m: Parameters<GitHubReader["runs"]>[0], b: string) => {
        queries++;
        return [run(m.tipSha, b)];
      },
    };
    const first = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { maxScans: 1, historyLimit: 1 },
    );
    expect(first.reason).toContain("Bounded ref scan");
    expect(queries).toBe(1);
    const second = await publishOneTraffic(
      f.settings,
      f.git,
      reader,
      f.origin.dir,
      report,
      f.publisher,
      { maxScans: 1, historyLimit: 1 },
    );
    expect(second.reason).toContain("deduplication");
    expect(queries).toBe(2);
    await publishOneTraffic(f.settings, f.git, reader, f.origin.dir, report, f.publisher, {
      maxScans: 1,
      historyLimit: 1,
    });
    expect(queries).toBe(2);
  });
  test("missing known candidate ref holds publication rather than assuming CI stopped", async () => {
    const f = await fixture({ adapter: true });
    const report = await replayTraffic(f.git, f.origin.dir, f.input, 1);
    const first = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      f.publisher,
    );
    await f.origin.exec(["update-ref", "-d", `refs/heads/${TRAFFIC_PREFIX}${first.batchId}`]);
    const result = await publishOneTraffic(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      f.publisher,
    );
    expect(result.action).toBe("wait");
    expect(result.recoveryRequired).toEqual([first.batchId!]);
  });
  test("publication defaults to no headroom and reserves main before allocating a candidate", async () => {
    const f = await fixture({ adapter: true });
    const report = await replayTraffic(f.git, f.origin.dir, f.input);
    const before = await f.git.remoteRefs(f.origin.dir);
    const result = await publishRaw(
      f.settings,
      f.git,
      { runs: async () => [] },
      f.origin.dir,
      report,
      f.publisher,
    );
    expect(result.action).toBe("wait");
    expect(result.headroom?.allowed).toBe(false);
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(before);
    const reader = {
      fresh: async (path: string) =>
        path.includes("/jobs?")
          ? { total_count: 2, jobs: [{ status: "in_progress" }, { status: "queued" }] }
          : {
              total_count: 1,
              workflow_runs: [
                { id: 1, path: ".github/workflows/ci.yml", event: "push", head_branch: "main" },
              ],
            },
    };
    expect((await readHeadroom(reader, undefined, undefined)).allowed).toBe(false);
    expect((await readHeadroom(reader, 57, 40)).allowed).toBe(false);
    expect(await readHeadroom(reader, 58, 40)).toMatchObject({
      allowed: true,
      occupied: 2,
      reservedMain: 40,
    });
    expect(
      (
        await readHeadroom(
          { fresh: async () => ({ total_count: 101, workflow_runs: [] }) },
          100,
          40,
        )
      ).allowed,
    ).toBe(false);
    expect(
      (
        await readHeadroom(
          {
            fresh: async () => ({
              total_count: 1,
              workflow_runs: [{ id: 1, path: ".github/workflows/batch-ci.yml" }],
            }),
          },
          100,
          40,
        )
      ).allowed,
    ).toBe(false);
  });
  describe("traffic headroom counts runner-holding jobs, not run placeholders", () => {
    // Provider wire JSON, deliberately including malformed pages.
    type WirePage = Record<string, any> | unknown[];
    const MAIN = { path: ".github/workflows/ci.yml", event: "push", head_branch: "main" };
    const OTHER = { path: ".github/workflows/other.yml", event: "push", head_branch: "feature" };
    const jobs = (...statuses: unknown[]) =>
      statuses.map((status) => (status === undefined ? {} : { status }));
    const page = (list: unknown[]) => ({ total_count: list.length, jobs: list });
    const scan = (
      runs: Array<Record<string, unknown>>,
      jobPages: Record<number, WirePage>,
      runPage?: () => WirePage,
    ) => ({
      fresh: async (path: string): Promise<WirePage> => {
        const match = /^actions\/runs\/(\d+)\/jobs\?/.exec(path);
        if (match) return jobPages[Number(match[1])] ?? {};
        if (runPage) return runPage();
        const status = new URLSearchParams(path.split("?")[1]).get("status");
        const listed = runs.filter((entry) => entry.status === status);
        return { total_count: listed.length, workflow_runs: listed };
      },
    });
    test.each([
      ["zero-job run held by its concurrency group", [], 0, true],
      ["approval-waiting jobs", ["waiting", "waiting", "waiting", "waiting"], 0, true],
      ["concurrency-pending jobs", ["pending", "pending", "pending"], 0, true],
      ["completed jobs", ["completed", "completed"], 0, true],
      ["two runner-holding jobs", ["queued", "in_progress", "completed"], 2, true],
      ["three runner-holding jobs", ["queued", "in_progress", "requested"], 3, false],
      [
        "mixed matrix counts each runner-holding job",
        ["in_progress", "in_progress", "queued", "waiting", "pending", "completed"],
        3,
        false,
      ],
    ] as const)("%s", async (_name, statuses, demand, allowed) => {
      const reader = scan([{ id: 2, status: "queued", ...OTHER }], {
        2: page(jobs(...statuses)),
      });
      expect(await readHeadroom(reader, 60, 40)).toMatchObject({
        allowed,
        occupied: demand,
        reservedMain: 40,
        candidateSlots: 18,
        budget: 60,
      });
    });
    test("main and non-main allocations are independent", async () => {
      const reader = scan(
        [
          { id: 1, status: "in_progress", ...MAIN },
          { id: 2, status: "waiting", ...MAIN },
          { id: 3, status: "queued", ...MAIN, head_branch: "production" },
          { id: 4, status: "queued", ...MAIN, event: "pull_request" },
          { id: 5, status: "pending", ...OTHER },
        ],
        {
          1: page(jobs(...Array(45).fill("in_progress"), "waiting", "completed")),
          2: page([]),
          3: page(jobs("queued", "waiting")),
          4: page(jobs("queued", "pending", "completed")),
          5: page(jobs("in_progress")),
        },
      );
      // Main demand 45 exceeds the 40 reserve; production and PR ci.yml runs are other demand.
      expect(await readHeadroom(reader, 66, 40)).toMatchObject({
        allowed: true,
        occupied: 48,
        reservedMain: 45,
      });
      expect((await readHeadroom(reader, 65, 40)).allowed).toBe(false);
      const quiet = scan([{ id: 1, status: "queued", ...MAIN }], {
        1: page(jobs("waiting", "waiting")),
      });
      expect(await readHeadroom(quiet, 58, 40)).toMatchObject({
        allowed: true,
        occupied: 0,
        reservedMain: 40,
      });
      expect((await readHeadroom(quiet, 57, 40)).allowed).toBe(false);
    });
    test.each([
      ["unknown job status", page(jobs("in_progress", "action_required")), "Unrecognized"],
      ["missing job status", page(jobs("queued", undefined)), "Unrecognized"],
      [
        "complete job page above the 100-row bound",
        { total_count: 101, jobs: jobs(...Array(101).fill("completed")) },
        "incomplete",
      ],
      ["truncated job page", { total_count: 2, jobs: jobs("queued") }, "incomplete"],
      ["malformed job page", { total_count: 0 }, "incomplete"],
      ["array job page", [], "incomplete"],
    ] as const)("%s holds", async (_name, jobPage, reason) => {
      const result = await readHeadroom(
        scan([{ id: 2, status: "queued", ...OTHER }], { 2: jobPage }),
        1000,
        40,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(reason);
    });
    test("run scan boundaries still hold with idle jobs", async () => {
      const idle = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, page([])]));
      const many = Array.from({ length: 33 }, (_, i) => ({
        id: i + 1,
        status: "queued",
        ...OTHER,
      }));
      const tooMany = await readHeadroom(scan(many, idle), 1000, 40);
      expect(tooMany.allowed).toBe(false);
      expect(tooMany.reason).toContain("Too many");
      const truncated = await readHeadroom(
        scan([], idle, () => ({ total_count: 1, workflow_runs: [] })),
        1000,
        40,
      );
      expect(truncated).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("incomplete"),
      });
      const oversized = await readHeadroom(
        scan([], idle, () => ({
          total_count: 101,
          workflow_runs: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, status: "queued" })),
        })),
        1000,
        40,
      );
      expect(oversized).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("exceeds bounded scan"),
      });
      const batch = await readHeadroom(
        scan([{ id: 7, status: "waiting", ...OTHER, path: ".github/workflows/batch-ci.yml" }], {
          7: page([]),
        }),
        1000,
        40,
      );
      expect(batch).toMatchObject({ allowed: false, reason: expect.stringContaining("Batch CI") });
      await expect(
        readHeadroom(scan([{ id: 0, status: "queued", ...OTHER }], idle), 1000, 40),
      ).rejects.toThrow("Invalid traffic number");
    });
  });
  test("persistent rate backoff and hourly budget prevent restart storms", async () => {
    const f = await fixture();
    let now = 100000,
      calls = 0;
    const cache = new TrafficCache(join(f.root, "rate"), () => now);
    const control = new TrafficReadControl(cache, 2, 2, 1000);
    const transport = control.wrap((async () => {
      calls++;
      return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
    }) as unknown as typeof fetch);
    await expect(transport("https://api.github.com/test")).rejects.toBeInstanceOf(TrafficBackoff);
    const next = new TrafficReadControl(cache, 2, 2, 1000).wrap((async () => {
      calls++;
      return Response.json({});
    }) as unknown as typeof fetch);
    await expect(next("https://api.github.com/test")).rejects.toBeInstanceOf(TrafficBackoff);
    expect(calls).toBe(1);
    now += 120001;
    await next("https://api.github.com/test");
    await expect(next("https://api.github.com/test")).rejects.toBeInstanceOf(TrafficBackoff);
    expect(calls).toBe(2);
    now += 3600000;
    await next("https://api.github.com/test");
    expect(calls).toBe(3);
  });
  test("low shared quota blocks the next read; completed-attempt cache is immutable and fresh bypasses TTL", async () => {
    const f = await fixture();
    let now = 100000,
      calls = 0;
    const cache = new TrafficCache(join(f.root, "cache"), () => now);
    const transport = (async (url: string | URL | Request) => {
      calls++;
      return Response.json(
        String(url).endsWith("/attempts/1")
          ? { id: 1, run_attempt: 1, status: "completed" }
          : { jobs: [{ status: "completed" }] },
      );
    }) as typeof fetch;
    const reader = new CachedTrafficReader(f.settings, new GitHubAuth({}), transport, cache);
    expect(reader.trafficCache).toBe(cache);
    expect(reader.cache).not.toBe(cache);
    expect(typeof reader.cache.set).toBe("function");
    await reader.get("actions/runs/1/attempts/1/jobs?per_page=100");
    now += 3600000;
    await reader.get("actions/runs/1/attempts/1/jobs?per_page=100");
    expect(calls).toBe(2);
    await reader.get("pulls?page=1");
    await reader.get("pulls?page=1");
    expect(calls).toBe(3);
    await reader.fresh("pulls?page=1");
    expect(calls).toBe(4);
    now += 300001;
    await reader.get("pulls?page=1");
    expect(calls).toBe(5);
    const wrapped = new TrafficReadControl(cache).wrap((async () =>
      Response.json(
        {},
        { headers: { "x-ratelimit-remaining": "999" } },
      )) as unknown as typeof fetch);
    await wrapped("https://api.github.com/test");
    await expect(wrapped("https://api.github.com/test")).rejects.toBeInstanceOf(TrafficBackoff);
  });
  test("completed jobs from a still-active attempt expire instead of freezing incomplete evidence", async () => {
    const f = await fixture();
    let now = 100000,
      calls = 0;
    const cache = new TrafficCache(join(f.root, "active-attempt"), () => now);
    const reader = new CachedTrafficReader(
      f.settings,
      new GitHubAuth({}),
      (async (url: string | URL | Request) => {
        calls++;
        return Response.json(
          String(url).endsWith("/attempts/1")
            ? { id: 1, run_attempt: 1, status: "in_progress" }
            : { jobs: [{ status: "completed" }] },
        );
      }) as typeof fetch,
      cache,
    );
    await reader.get("actions/runs/1/attempts/1/jobs?per_page=100");
    now += 300001;
    await reader.get("actions/runs/1/attempts/1/jobs?per_page=100");
    expect(calls).toBe(4);
  });
  test("parallel rate-limited callers serialize backoff and transport failures consume budget", async () => {
    const f = await fixture();
    let calls = 0;
    const cache = new TrafficCache(join(f.root, "parallel-rate"));
    const control = new TrafficReadControl(cache);
    const transport = control.wrap((async () => {
      calls++;
      return new Response("limited", { status: 429 });
    }) as unknown as typeof fetch);
    const results = await Promise.allSettled([
      transport("https://api.github.com/a"),
      transport("https://api.github.com/b"),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    const otherCache = new TrafficCache(join(f.root, "network-failure"));
    const failure = new TrafficReadControl(otherCache, 1).wrap((async () => {
      calls++;
      throw new Error("network");
    }) as unknown as typeof fetch);
    await expect(failure("https://api.github.com/a")).rejects.toBeInstanceOf(TrafficBackoff);
    await expect(failure("https://api.github.com/a")).rejects.toThrow("Hourly");
    expect(calls).toBe(2);
  });
  test("immutable verified receipt cache is bound to the exact batch, tip, run and attempt", async () => {
    const f = await fixture();
    const report = await replayTraffic(f.git, f.origin.dir, f.input);
    const manifest = report.cohorts[0]!.manifest!;
    const cache = new TrafficCache(join(f.root, "receipts"));
    const verified = { outcome: "success" as const, retryable: false, reason: "verified fixture" };
    await cache.put(
      `result:${f.settings.repository}:${manifest.batchId}:${manifest.tipSha}:10:1`,
      verified,
      null,
    );
    let calls = 0;
    const reader = new CachedTrafficReader(
      f.settings,
      new GitHubAuth({}),
      (async (url: string | URL | Request) => {
        expect(String(url)).toContain("/actions/runs/10/artifacts");
        calls++;
        return Response.json({ artifacts: [] });
      }) as typeof fetch,
      cache,
    );
    expect(await reader.resultArtifact(manifest, 10, 1)).toEqual(verified);
    expect(calls).toBe(0);
    expect(await reader.resultArtifact(manifest, 10, 2)).toBeNull();
    expect(await reader.resultArtifact({ ...manifest, tipSha: f.base }, 10, 1)).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });
  test("traffic reader runs() keeps base verified-run cache and traffic GET cache separate", async () => {
    const f = await fixture();
    const report = await replayTraffic(f.git, f.origin.dir, f.input);
    const manifest = report.cohorts[0]!.manifest!;
    const branch = `${TRAFFIC_PREFIX}${manifest.batchId}`;
    const trafficCache = new TrafficCache(join(f.root, "reader-cache"));
    // A previously verified receipt avoids artifact download; the run listing
    // below is the only mocked provider response.
    const verified = { outcome: "success" as const, retryable: false, reason: "verified fixture" };
    await trafficCache.put(
      `result:${f.settings.repository}:${manifest.batchId}:${manifest.tipSha}:10:1`,
      verified,
      null,
    );
    const listed: string[] = [];
    const transport = (async (url: string | URL | Request) => {
      const target = String(url);
      if (!target.includes(`/actions/workflows/batch-ci.yml/runs?branch=`))
        throw new Error(`Unexpected provider call ${target}`);
      listed.push(target);
      return Response.json({
        workflow_runs: [
          {
            id: 10,
            run_attempt: 1,
            head_sha: manifest.tipSha,
            head_branch: branch,
            path: f.settings.workflow,
            event: "push",
            status: "completed",
            conclusion: "success",
            run_started_at: date(6),
            updated_at: date(8),
          },
        ],
      });
    }) as typeof fetch;
    const reader = new CachedTrafficReader(f.settings, new GitHubAuth({}), transport, trafficCache);
    expect(reader.trafficCache).toBe(trafficCache);
    const first = await reader.runs(manifest, branch);
    expect(first).toEqual([
      {
        id: 10,
        attempt: 1,
        headSha: manifest.tipSha,
        branch,
        workflow: f.settings.workflow,
        status: "completed",
        outcome: "success",
        trusted: true,
        retryable: false,
        startedAt: date(6),
        completedAt: date(8),
      },
    ]);
    expect(listed).toHaveLength(1);
    // The inherited core path stores the trusted terminal run in the base DiskCache.
    const verifiedKey = `verified:${manifest.tipSha}:${manifest.batchId}:10:1`;
    expect(await reader.cache.get(verifiedKey)).toEqual({ run: first[0], conclusion: "success" });
    expect(await Bun.file(reader.cache.path).exists()).toBe(true);
    expect(await trafficCache.get(verifiedKey)).toBeNull();
    // The listing is served from the traffic GET cache: no further provider call.
    expect(await reader.runs(manifest, branch)).toEqual(first);
    expect(listed).toHaveLength(1);
    // A restarted reader recovers both on-disk caches without any provider call.
    const restarted = new CachedTrafficReader(
      f.settings,
      new GitHubAuth({}),
      (async () => {
        throw new Error("No provider calls allowed");
      }) as unknown as typeof fetch,
      new TrafficCache(join(f.root, "reader-cache")),
    );
    expect(await restarted.runs(manifest, branch)).toEqual(first);
    expect(await restarted.cache.get(verifiedKey)).toEqual({
      run: first[0],
      conclusion: "success",
    });
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
    const publisher = new TrafficPublisher(
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
    const afterDone = await f.git.remoteRefs(f.origin.dir);
    expect(afterDone.get("refs/heads/main")).toBe(f.merge2);
    expect([...afterDone].filter(([r]) => r !== TRAFFIC_STATE)).toEqual(
      [...refs].filter(([r]) => r !== TRAFFIC_STATE),
    );
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
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(afterDone);
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
          { now: date(10) },
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
  test("same-clock publishers past the final pre-push check get distinct fences and one atomic winner", async () => {
    const f = await fixture({ adapter: true }),
      report = await replayTraffic(f.git, f.origin.dir, f.input, 1),
      before = await f.git.remoteRefs(f.origin.dir);
    // Hold each push until both publishers have completed every remote
    // observation, including the writer's final stale-snapshot check. Then
    // release the pushes one at a time so the second sees the first's result.
    const pushedStates: string[] = [],
      landedStates: string[] = [];
    let arrive!: () => void;
    const bothArrived = new Promise<void>((resolve) => (arrive = resolve));
    let serial = Promise.resolve();
    const writerGit = new GitStore(f.git.dir);
    const exec = writerGit.exec.bind(writerGit);
    writerGit.exec = async (args: string[], input?: string, env?: Record<string, string>) => {
      if (args[0] !== "push") return exec(args, input, env);
      const next = args.find((arg) => arg.endsWith(`:${TRAFFIC_STATE}`))!.split(":")[0]!;
      pushedStates.push(next);
      if (pushedStates.length === 2) arrive();
      await bothArrived;
      const previous = serial;
      let done!: () => void;
      serial = new Promise<void>((resolve) => (done = resolve));
      await previous;
      try {
        const output = await exec(args, input, env);
        landedStates.push(next);
        return output;
      } finally {
        done();
      }
    };
    const publisher = new TrafficPublisher(
      f.settings,
      new AtomicGitWriter(writerGit, f.origin.dir, TRAFFIC_STATE, "refs/heads/main"),
    );
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        publishOneTraffic(
          f.settings,
          f.git,
          { runs: async () => [] },
          f.origin.dir,
          report,
          publisher,
          { now: date(10) },
        ),
      ),
    );
    // Identical state commits would let Git report the loser as "up to date"
    // before checking its lease, so both calls would claim publication.
    expect(pushedStates).toHaveLength(2);
    expect(pushedStates[0]).not.toBe(pushedStates[1]);
    expect(landedStates).toHaveLength(1);
    const winners = outcomes.flatMap((o) =>
      o.status === "fulfilled" && o.value.action === "published" ? [o.value] : [],
    );
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const after = await f.git.remoteRefs(f.origin.dir);
    expect(after.get(TRAFFIC_STATE)).toBe(landedStates[0]!);
    expect(after.get("refs/heads/main")).toBe(before.get("refs/heads/main")!);
    expect([...after.keys()].filter((r) => r.startsWith(`refs/heads/${TRAFFIC_PREFIX}`))).toEqual([
      `refs/heads/${TRAFFIC_PREFIX}${winners[0]!.batchId}`,
    ]);
  }, 30_000);
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
