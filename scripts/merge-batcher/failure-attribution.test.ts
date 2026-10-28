import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memberPaths } from "./controller";
import { GitStore } from "./git";
import {
  ATTRIBUTED_FAILURE,
  config,
  digest,
  emptyLedger,
  type Candidate,
  type FailureDiagnostic,
  type Manifest,
  type Observation,
  type Pull,
  type Run,
} from "./model";
import { attributeFailure, infrastructureRetryReason, plan } from "./planner";
import { verifyResult } from "./result";

const NOW = "2026-10-21T11:00:00.000Z";
const SHA = "a".repeat(40);
const cfg = config({});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function pull(number: number): Pull {
  return {
    number,
    headSha: String(number).repeat(40).slice(0, 40),
    headRef: `feature-${number}`,
    binding: {
      eventId: `event-${number}`,
      at: new Date(Date.parse(NOW) + number * 1000).toISOString(),
      source: "queue-ready",
      evidenceId: `${number}`,
      evidenceDigest: digest(number),
    },
  };
}
function candidate(
  numbers: number[],
  changed: string[][] | undefined,
  recoveryOf: string | null = null,
): Candidate {
  const pulls = numbers.map(pull);
  const spec = {
    schemaVersion: 1 as const,
    baseSha: SHA,
    predecessor: null,
    recoveryOf,
    createdAt: NOW,
    pulls,
  };
  const batchId = digest(spec);
  const manifest: Manifest = {
    ...spec,
    batchId,
    tipSha: digest(batchId).slice(0, 40),
    pulls: pulls.map((p) => ({ ...p, mergeSha: digest(p).slice(0, 40) })),
  };
  return {
    manifest,
    branch: `queue/${batchId}`,
    runs: [],
    containedInBase: false,
    ...(changed ? { memberPaths: changed } : {}),
  };
}
function failed(c: Candidate, diagnostics: FailureDiagnostic[], attempt = 1): Run {
  return {
    id: 100,
    attempt,
    headSha: c.manifest.tipSha,
    branch: c.branch,
    workflow: cfg.workflow,
    status: "completed",
    outcome: "code_failure",
    trusted: true,
    retryable: true,
    failedClasses: ["source"],
    diagnostics,
    completedAt: NOW,
  };
}
function observation(ready: Pull[], candidates: Candidate[]): Observation {
  return {
    now: "2026-10-21T12:00:00.000Z",
    baseSha: SHA,
    baseCI: { sha: SHA, status: "green", runId: 50, attempt: 1, reason: "fixture" },
    ready,
    excluded: [],
    candidates,
    stateSha: null,
    ledger: emptyLedger(),
  };
}
const hygiene: FailureDiagnostic = {
  job: "source",
  check: "guard:public-hygiene",
  paths: ["apps/web/notice.xml"],
  excerpt: "apps/web/notice.xml:9 — retired milestone label",
};

test("a deterministic failure naming one member's file ejects it without rerun or bisection", () => {
  const c = candidate([1, 2, 3], [["a.ts"], ["apps/web/notice.xml", "b.ts"], ["c.ts"]]);
  c.runs = [failed(c, [hygiene])];
  expect(infrastructureRetryReason(c, c.runs[0]!, cfg)).toBeNull();
  // The base verdict is irrelevant to a file only this member changed.
  const o = observation([pull(1), pull(2), pull(3)], [c]);
  o.baseCI = { sha: SHA, status: "unknown", runId: null, attempt: null, reason: "pending" };
  const action = plan(o, cfg);
  expect(action.kind).toBe("record");
  if (action.kind !== "record") throw new Error("expected record");
  expect(action.ledger.invalidated).toEqual([c.manifest.batchId]);
  expect(action.ledger.recovery).toEqual([]);
  expect(action.ledger.ejected).toHaveLength(1);
  const [ejection] = action.ledger.ejected;
  expect(ejection!.pull).toEqual(pull(2));
  expect(ejection!.reason.startsWith(ATTRIBUTED_FAILURE)).toBe(true);
  expect(ejection!.reason).toContain("guard:public-hygiene failed in Batch CI run 100 attempt 1");
  expect(ejection!.reason).toContain("apps/web/notice.xml:9 — retired milestone label");
  // The ejection is announced once, then the rest are rebuilt without it.
  o.ledger = action.ledger;
  const announce = plan(o, cfg);
  expect(announce).toMatchObject({ kind: "announce" });
  o.ledger.ejected[0]!.announced = true;
  const rebuild = plan(o, cfg);
  expect(rebuild.kind).toBe("build");
  if (rebuild.kind !== "build") throw new Error("expected build");
  expect(rebuild.spec.pulls.map((p) => p.number)).toEqual([1, 3]);
});

test("ambiguous deterministic failures skip the rerun but keep base hold and bisection", () => {
  for (const changed of [
    [["apps/web/notice.xml"], ["apps/web/notice.xml"]],
    [["a.ts"], ["b.ts"]],
    undefined,
  ]) {
    const c = candidate([1, 2], changed);
    c.runs = [failed(c, [hygiene])];
    expect(attributeFailure(c, c.runs[0]!)).toBeNull();
    const o = observation([pull(1), pull(2)], [c]);
    const action = plan(o, cfg);
    expect(action.kind).toBe("record");
    if (action.kind !== "record") throw new Error("expected record");
    expect(action.reason).toBe("split failed cohort without retry or member blame");
    expect(action.ledger.ejected).toEqual([]);
    o.baseCI = { sha: SHA, status: "unknown", runId: null, attempt: null, reason: "pending" };
    expect(plan(o, cfg).kind).toBe("wait");
  }
});

test("unit-test files attribute only after the unchanged rerun reproduced the failure", () => {
  const unit: FailureDiagnostic = {
    job: "unit-3",
    check: "unit",
    paths: ["apps/api/test/voice.test.ts"],
    excerpt: "unit test file failed: apps/api/test/voice.test.ts",
  };
  const c = candidate([1, 2], [["apps/api/test/voice.test.ts"], ["b.ts"]]);
  c.runs = [failed(c, [unit])];
  expect(plan(observation([pull(1), pull(2)], [c]), cfg).kind).toBe("retry");
  c.runs.push(failed(c, [unit], 2));
  const action = plan(observation([pull(1), pull(2)], [c]), cfg);
  expect(action.kind).toBe("record");
  if (action.kind !== "record") throw new Error("expected record");
  expect(action.ledger.ejected.map((e) => e.pull.number)).toEqual([1]);
  // Reproduced unit failures still respect the exact-base comparison.
  const held = observation([pull(1), pull(2)], [c]);
  held.baseCI = { sha: SHA, status: "unknown", runId: null, attempt: null, reason: "pending" };
  expect(plan(held, cfg).kind).toBe("wait");
});

test("a recovery group keeps the remaining members in its sequential place", () => {
  const cohort = digest("cohort");
  const c = candidate([1, 2, 3], [["x.ts"], ["y.ts"], ["apps/web/notice.xml"]], cohort);
  c.runs = [failed(c, [hygiene])];
  const o = observation([pull(1), pull(2), pull(3), pull(4)], [c]);
  o.ledger.recovery = [{ batchId: cohort, pulls: [pull(4)] }];
  const action = plan(o, cfg);
  if (action.kind !== "record") throw new Error("expected record");
  expect(action.ledger.ejected.map((e) => e.pull.number)).toEqual([3]);
  expect(action.ledger.recovery.map((g) => [g.batchId, g.pulls.map((p) => p.number)])).toEqual([
    [cohort, [1, 2]],
    [cohort, [4]],
  ]);
});

test("a deterministic singleton failure parks immediately without a rerun", () => {
  const c = candidate([1], [["apps/web/notice.xml"]]);
  c.runs = [failed(c, [hygiene])];
  const action = plan(observation([pull(1)], [c]), cfg);
  expect(action).toMatchObject({ kind: "record" });
  if (action.kind !== "record") throw new Error("expected record");
  expect(action.ledger.parked?.map((p) => p.pull.number)).toEqual([1]);
  expect(action.ledger.ejected).toEqual([]);
});

test("verified results carry only well-formed diagnostics from code-failure tasks", () => {
  const c = candidate([1], undefined);
  const identity = {
    schemaVersion: 1,
    batchId: c.manifest.batchId,
    headSha: c.manifest.tipSha,
    runId: "100",
    runAttempt: 1,
  };
  const task = (job: string, exitCode: number, diagnostic?: unknown) => ({
    ...identity,
    job,
    exitCode,
    outcome: exitCode ? "code_failure" : "success",
    retryable: exitCode !== 0,
    startedAt: NOW,
    finishedAt: NOW,
    ...(diagnostic ? { diagnostic } : {}),
  });
  const result = (tasks: unknown[]) => ({
    ...identity,
    outcome: "code_failure",
    retryable: true,
    reason: "fixture",
    expectedJobs: ["plan", "source", "unit-0"],
    jobs: { plan: "success", source: "failure", units: "failure" },
    tasks,
  });
  const source = { check: "guard:public-hygiene", paths: ["b.md", "a.md"], excerpt: "a.md:1 `x`" };
  const unit = { check: "unit", paths: ["t.test.ts"], excerpt: "unit test file failed" };
  expect(
    verifyResult(
      result([task("plan", 0), task("source", 1, source), task("unit-0", 1, unit)]),
      c.manifest,
      100,
      1,
    )?.diagnostics,
  ).toEqual([
    {
      job: "source",
      check: "guard:public-hygiene",
      paths: ["a.md", "b.md"],
      excerpt: "a.md:1  x ",
    },
    { job: "unit-0", ...unit },
  ]);
  for (const bad of [
    { ...source, paths: ["../etc/passwd"] },
    { ...source, paths: ["/abs.ts"] },
    { ...source, check: "unit" },
    { ...source, check: "Not A Check" },
    { ...source, excerpt: 3 },
  ])
    expect(
      verifyResult(
        result([task("plan", 0), task("source", 1, bad), task("unit-0", 1)]),
        c.manifest,
        100,
        1,
      )?.diagnostics,
    ).toBeUndefined();
  // A unit task cannot claim a deterministic source check.
  expect(
    verifyResult(
      result([task("plan", 0), task("source", 1), task("unit-0", 1, source)]),
      c.manifest,
      100,
      1,
    )?.diagnostics,
  ).toBeUndefined();
});

test("member paths are what each member's merge changed in the candidate chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "batcher-attribution-"));
  roots.push(root);
  const git = new GitStore(join(root, "cache.git"));
  await git.init();
  const tree = async (files: Record<string, string>) => {
    const entries: string[] = [];
    for (const [name, text] of Object.entries(files).sort())
      entries.push(
        `100644 blob ${await git.exec(["hash-object", "-w", "--stdin"], text)}\t${name}`,
      );
    return git.exec(["mktree"], `${entries.join("\n")}\n`);
  };
  const base = await git.commit(await tree({ shared: "base" }), [], "base", NOW);
  const one = await git.commit(await tree({ shared: "base", one: "1" }), [base], "one", NOW);
  const two = await git.commit(await tree({ shared: "two" }), [base], "two", NOW);
  const manifest = await git.build({
    schemaVersion: 1,
    baseSha: base,
    predecessor: null,
    recoveryOf: null,
    createdAt: NOW,
    pulls: [
      { ...pull(1), headSha: one },
      { ...pull(2), headSha: two },
    ],
  });
  expect(await memberPaths(git, manifest)).toEqual([["one"], ["shared"]]);
});
