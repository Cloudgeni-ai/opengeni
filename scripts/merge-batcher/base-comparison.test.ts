import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  aggregateBatchResult,
  buildComparisonEvidence,
  classifyBatchExit,
} from "../ci/batch-result";
import {
  absentFromBase,
  BASE_PURPOSE,
  BASE_TRAILER,
  baseBranch,
  baseSupport,
  BATCH_WORKFLOW,
  buildBase,
  classifyQueueRef,
  COMPARISON_SCHEMA,
  compareFailures,
  executionPlan,
  inspectBase,
  validateExecutionPlan,
  verifyBaseRun,
  verifyEvidence,
  type BaseRun,
  type ComparisonEvidence,
  type ExecutionPlan,
} from "./base-comparison";
import { GitStore } from "./git";
import { GitHubAuth, GitHubReader } from "./github";
import { canonical, config, digest, type Manifest } from "./model";
import { verifyResult, verifyRunResult } from "./result";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PLAN: ExecutionPlan = {
  schemaVersion: 1,
  unitTests: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"],
  typecheckProjects: ["packages/a"],
  guards: ["lint"],
  exampleBuildProjects: [],
  buildPackages: [],
};
const UNITS = [
  { category: "parallel", files: ["a.test.ts"] },
  { category: "parallel", files: ["b.test.ts"] },
  // One batched process is one identity; it is never expanded per file.
  { category: "parallel", files: ["c.test.ts", "d.test.ts"] },
];
const RECIPE: [string, string | null][] = [
  [".github/workflows/batch-ci.yml", "1".repeat(40)],
  ["bun.lock", "2".repeat(40)],
  ["scripts/ci/run-unit-shard.ts", "3".repeat(40)],
];
const SOURCE_ENV = {
  runnerOs: "Linux",
  runnerArch: "X64",
  imageOS: "ubuntu24",
  imageVersion: "20261019.1",
  bun: "1.4.3+abc",
  node: "v22.23.4",
  testMaxConcurrency: "4",
  typecheckConcurrency: "1",
  cargoBuildJobs: "2",
};
const UNIT_ENV = {
  ...SOURCE_ENV,
  filesPerProcess: "1",
  requireRealDb: "1",
  postgres: "PostgreSQL 18.1",
};
const BASE_SHA = "b".repeat(40);
const CANDIDATE = { batchId: "c".repeat(64), tipSha: "d".repeat(40), runId: 900, attempt: 1 };
const BASE_RUN_ID = "e".repeat(64);
const BASE_TIP = "f".repeat(40);

type Exits = Partial<Record<"a" | "b" | "cd", number | null>>;
function runDocuments(input: {
  purpose: "candidate" | typeof BASE_PURPOSE;
  batchId: string;
  headSha: string;
  runId: number;
  attempt: number;
  exits?: Exits;
  steps?: Partial<Record<"site-runtime" | "changeset" | "typecheck" | "guards", number | null>>;
  unitEnv?: Record<string, string | null>;
  plan?: ExecutionPlan;
}) {
  const identity = {
    batchId: input.batchId,
    headSha: input.headSha,
    runId: String(input.runId),
    runAttempt: input.attempt,
  };
  const exits = { a: 0, b: 0, cd: 0, ...input.exits };
  const steps = { "site-runtime": 0, changeset: 0, typecheck: 0, guards: 0, ...input.steps };
  const unitExit = [exits.a, exits.b, exits.cd].find((code) => code !== 0 && code !== null) ?? 0;
  const sourceExit = Object.values(steps).find((code) => code !== 0 && code !== null) ?? 0;
  const task = (job: string, exitCode: number, extra: object = {}) => ({
    schemaVersion: 1 as const,
    ...identity,
    job,
    exitCode,
    ...classifyBatchExit(exitCode),
    startedAt: "2026-10-22T12:00:00Z",
    finishedAt: "2026-10-22T12:01:00Z",
    ...extra,
  });
  const receipts = [
    task("plan", 0),
    task("source", sourceExit, {
      environment: SOURCE_ENV,
      steps: Object.entries(steps).map(([step, exitCode]) => ({ step, exitCode })),
    }),
    task("unit-0", unitExit, {
      environment: input.unitEnv ?? UNIT_ENV,
      units: [
        { ...UNITS[0]!, exitCode: exits.a },
        { ...UNITS[1]!, exitCode: exits.b },
        { ...UNITS[2]!, exitCode: exits.cd },
      ],
    }),
  ];
  const aggregated = aggregateBatchResult(identity, ["plan", "source", "unit-0"], receipts, {
    plan: "success",
    source: sourceExit ? "failure" : "success",
    units: unitExit ? "failure" : "success",
  });
  const plan = input.plan ?? PLAN;
  const evidence = buildComparisonEvidence({
    identity,
    unitShards: 1,
    receipts,
    verifiedJobs: aggregated.tasks.map((item) => item.job),
    batch: { purpose: input.purpose, baseSha: BASE_SHA, planDigest: digest(plan) },
    plan,
    inventory: {
      schemaVersion: 1,
      comparisonSchema: COMPARISON_SCHEMA,
      planDigest: digest(plan),
      shards: 1,
      absent: [],
      units: UNITS,
      recipePaths: RECIPE,
    },
  })!;
  const result: Record<string, unknown> = {
    ...aggregated,
    ...(input.purpose === BASE_PURPOSE ? { purpose: BASE_PURPOSE } : {}),
    comparison: {
      comparisonSchema: COMPARISON_SCHEMA,
      purpose: input.purpose,
      evidenceDigest: digest(evidence),
    },
  };
  return { result, evidence: JSON.parse(JSON.stringify(evidence)) as ComparisonEvidence };
}

function baseRun(evidence: ComparisonEvidence): BaseRun {
  return {
    baseRunId: BASE_RUN_ID,
    tipSha: BASE_TIP,
    manifest: {
      comparisonSchema: COMPARISON_SCHEMA,
      purpose: BASE_PURPOSE,
      baseSha: BASE_SHA,
      baseTreeSha: "9".repeat(40),
      planDigest: digest(PLAN),
      recipeDigest: evidence.recipeDigest!,
      plan: PLAN,
    },
  };
}
const PREFIX = "queue/live/";
function baseInput(documents: { result: unknown; evidence: unknown }, base?: BaseRun) {
  const run = {
    id: 901,
    attempt: 1,
    headSha: BASE_TIP,
    branch: baseBranch(PREFIX, BASE_RUN_ID),
    workflow: BATCH_WORKFLOW,
    status: "completed" as "queued" | "in_progress" | "completed",
  };
  return {
    prefix: PREFIX,
    workflow: BATCH_WORKFLOW,
    base: base ?? baseRun(documents.evidence as ComparisonEvidence),
    run,
    latestAttempt: 1,
    result: documents.result,
    evidence: documents.evidence,
  };
}
const candidateRun = (
  input: Omit<
    Parameters<typeof runDocuments>[0],
    keyof typeof CANDIDATE | "purpose" | "headSha"
  > = {},
) =>
  runDocuments({
    purpose: "candidate",
    batchId: CANDIDATE.batchId,
    headSha: CANDIDATE.tipSha,
    runId: CANDIDATE.runId,
    attempt: CANDIDATE.attempt,
    ...input,
  });
const baseDocuments = (
  input: Omit<
    Parameters<typeof runDocuments>[0],
    "purpose" | "batchId" | "headSha" | "runId" | "attempt"
  > = {},
) =>
  runDocuments({
    purpose: BASE_PURPOSE,
    batchId: BASE_RUN_ID,
    headSha: BASE_TIP,
    runId: 901,
    attempt: 1,
    ...input,
  });
function verifiedCandidate(documents: { result: unknown; evidence: unknown }) {
  const checked = verifyEvidence(documents.result, documents.evidence, {
    purpose: "candidate",
    batchId: CANDIDATE.batchId,
    headSha: CANDIDATE.tipSha,
    runId: CANDIDATE.runId,
    attempt: CANDIDATE.attempt,
    baseSha: BASE_SHA,
  });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.evidence;
}
function verifiedBase(documents: { result: unknown; evidence: unknown }) {
  const checked = verifyBaseRun(baseInput(documents));
  if (!checked.ok) throw new Error(checked.reason);
  return checked.evidence;
}
/** Re-binds a tampered document so only the semantic check under test can reject it. */
function rebound(documents: { result: Record<string, unknown>; evidence: ComparisonEvidence }) {
  const comparison = documents.result.comparison as Record<string, unknown>;
  return {
    result: {
      ...documents.result,
      comparison: { ...comparison, evidenceDigest: digest(documents.evidence) },
    },
    evidence: documents.evidence,
  };
}

describe("execution plan and queue namespace", () => {
  test("only executed plan fields are frozen, normalized and digested", () => {
    const plan = executionPlan({
      schemaVersion: 1,
      mode: "focused",
      head: "a".repeat(40),
      changedFiles: ["x"],
      unitTests: ["z.test.ts", "a.test.ts", "z.test.ts"],
      typecheckProjects: ["p"],
      guards: ["g"],
      exampleBuildProjects: [],
      buildPackages: [],
    });
    expect(plan.unitTests).toEqual(["a.test.ts", "z.test.ts"]);
    expect(Object.keys(plan).sort()).toEqual([
      "buildPackages",
      "exampleBuildProjects",
      "guards",
      "schemaVersion",
      "typecheckProjects",
      "unitTests",
    ]);
    expect(validateExecutionPlan(plan)).toEqual(plan);
    expect(() => validateExecutionPlan({ ...plan, head: "x" })).toThrow("unexpected fields");
    expect(() => validateExecutionPlan({ ...plan, unitTests: ["z", "a"] })).toThrow("normalized");
    expect(() => executionPlan({ ...plan, schemaVersion: 2 })).toThrow();
    expect(() => executionPlan({ ...plan, guards: [1] })).toThrow();
  });
  test("base refs are routed apart from candidates and unknown refs stay unowned", () => {
    const id = "a".repeat(64);
    expect(baseBranch(PREFIX, id)).toBe(`queue/live/base/${id}`);
    expect(classifyQueueRef(PREFIX, `refs/heads/queue/live/${id}`)).toEqual({
      purpose: "candidate",
      id,
    });
    expect(classifyQueueRef(PREFIX, `refs/heads/queue/live/base/${id}`)).toEqual({
      purpose: BASE_PURPOSE,
      id,
    });
    for (const ref of [
      `refs/heads/queue/live/base/${id}x`,
      `refs/heads/queue/live/base/${id.slice(1)}`,
      `refs/heads/queue/live/other/${id}`,
      `refs/heads/queue/shadow/${id}`,
    ])
      expect(classifyQueueRef(PREFIX, ref)).toBeNull();
    expect(() => baseBranch(PREFIX, "short")).toThrow();
  });
});

describe("deterministic base-purpose commits", () => {
  function repository(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "base-comparison-"));
    roots.push(root);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0200",
      GIT_COMMITTER_DATE: "1700000000 +0200",
    };
    const git = (...args: string[]) => {
      const child = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe" });
      if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
      return child.stdout.toString().trim();
    };
    git("init", "-q");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    return { store: new GitStore(join(root, ".git")), sha: git("rev-parse", "HEAD") };
  }
  const marker = JSON.stringify({ comparisonSchema: COMPARISON_SCHEMA });
  const files = {
    "scripts/ci/batch-comparison.json": marker,
    "a.test.ts": "a",
    "b.test.ts": "b",
    "c.test.ts": "c",
    "d.test.ts": "d",
  };
  const recipeDigest = "7".repeat(64);

  test("identity is a pure function of base, frozen plan and recipe", async () => {
    const { store, sha } = repository(files);
    const first = await buildBase(store, { baseSha: sha, plan: PLAN, recipeDigest });
    const again = await buildBase(store, { baseSha: sha, plan: PLAN, recipeDigest });
    expect(again).toEqual(first);
    expect(first.baseRunId).toBe(digest(first.manifest));
    expect(first.manifest).not.toHaveProperty("batchId");
    const commit = await store.exec(["cat-file", "commit", first.tipSha]);
    const baseCommit = await store.exec(["cat-file", "commit", sha]);
    expect(commit).toContain(`parent ${sha}`);
    expect(commit.match(/^parent /gm)).toHaveLength(1);
    expect(commit.split("\n")[0]).toBe(baseCommit.split("\n")[0]);
    expect(commit).toContain("1700000000 +0200");
    expect(commit).not.toContain("Batch-Manifest: ");
    const other = await buildBase(store, {
      baseSha: sha,
      plan: PLAN,
      recipeDigest: "8".repeat(64),
    });
    expect(other.baseRunId).not.toBe(first.baseRunId);
    const otherPlan = await buildBase(store, {
      baseSha: sha,
      plan: { ...PLAN, guards: [] },
      recipeDigest,
    });
    expect(otherPlan.tipSha).not.toBe(first.tipSha);
    expect(await inspectBase(store, first.tipSha)).toEqual(first);
  });

  test("inspection rejects candidates, forged trailers, topology and dates", async () => {
    const { store, sha } = repository(files);
    const built = await buildBase(store, { baseSha: sha, plan: PLAN, recipeDigest });
    const tree = (await store.exec(["cat-file", "commit", sha])).split("\n")[0]!.slice(5);
    const forge = (message: string, parents = [sha], date = "1700000000 +0200") =>
      store.commit(tree, parents, message, date);
    const trailer = `${BASE_TRAILER}${canonical(built.manifest)}`;
    // A base result can never be inspected as a landable candidate.
    await expect(store.inspect(built.tipSha)).rejects.toThrow();
    await expect(inspectBase(store, sha)).rejects.toThrow("Missing or ambiguous");
    await expect(inspectBase(store, await forge(`x\n\n${trailer}\n${trailer}`))).rejects.toThrow(
      "Missing or ambiguous",
    );
    await expect(
      inspectBase(store, await forge(`x\n\n${trailer}\nBatch-Manifest: {}`)),
    ).rejects.toThrow("Missing or ambiguous");
    await expect(
      inspectBase(
        store,
        await forge(
          `x\n\n${BASE_TRAILER}${canonical({ ...built.manifest, planDigest: "0".repeat(64) })}`,
        ),
      ),
    ).rejects.toThrow("plan digest");
    await expect(
      inspectBase(
        store,
        await forge(`x\n\n${BASE_TRAILER}${canonical({ ...built.manifest, source: "x" })}`),
      ),
    ).rejects.toThrow("Invalid base comparison manifest");
    // Same manifest, wrong date or extra parent: not the canonical commit.
    await expect(
      inspectBase(
        store,
        await forge(
          `Batch base comparison ${built.baseRunId}\n\n${trailer}`,
          [sha],
          "1700000001 +0200",
        ),
      ),
    ).rejects.toThrow("Noncanonical");
    await expect(
      inspectBase(
        store,
        await forge(`Batch base comparison ${built.baseRunId}\n\n${trailer}`, [sha, built.tipSha]),
      ),
    ).rejects.toThrow("parent");
    const emptyTree = await store.exec(["mktree"], "");
    await expect(
      inspectBase(
        store,
        await store.commit(emptyTree, [sha], `x\n\n${trailer}`, "1700000000 +0200"),
      ),
    ).rejects.toThrow("tree");
  });

  test("historical bases without the marker and absent planned files fail closed", async () => {
    const supported = repository(files);
    expect(await baseSupport(supported.store, supported.sha)).toEqual({ supported: true });
    expect(await absentFromBase(supported.store, supported.sha, PLAN)).toEqual([]);
    const historical = repository({ "a.test.ts": "a" });
    expect(await baseSupport(historical.store, historical.sha)).toEqual({
      supported: false,
      reason: "unsupported-base: comparison marker absent",
    });
    expect(await absentFromBase(historical.store, historical.sha, PLAN)).toEqual([
      "b.test.ts",
      "c.test.ts",
      "d.test.ts",
    ]);
    const future = repository({
      "scripts/ci/batch-comparison.json": JSON.stringify({
        comparisonSchema: "batch-base-comparison/v2",
      }),
    });
    expect((await baseSupport(future.store, future.sha)).supported).toBe(false);
  });
});

describe("run-bound comparison evidence", () => {
  test("a base receipt never verifies as a candidate result, and vice versa", () => {
    const base = baseDocuments();
    const forged = { ...base.result, batchId: CANDIDATE.batchId, headSha: CANDIDATE.tipSha };
    const manifest = { batchId: CANDIDATE.batchId, tipSha: CANDIDATE.tipSha } as Manifest;
    expect(verifyResult(forged, manifest, 901, 1)).toBeNull();
    expect(
      verifyRunResult(
        base.result,
        { batchId: BASE_RUN_ID, tipSha: BASE_TIP },
        901,
        1,
        BASE_PURPOSE,
      ),
    ).not.toBeNull();
    const candidate = candidateRun();
    expect(
      verifyRunResult(
        { ...candidate.result, batchId: BASE_RUN_ID, headSha: BASE_TIP },
        { batchId: BASE_RUN_ID, tipSha: BASE_TIP },
        CANDIDATE.runId,
        1,
        BASE_PURPOSE,
      ),
    ).toBeNull();
    // Ordinary candidate results keep verifying unchanged.
    expect(verifyResult(candidate.result, { ...manifest }, CANDIDATE.runId, 1)?.outcome).toBe(
      "success",
    );
  });

  test("a complete base run verifies only for its exact ref, tip, workflow and latest attempt", () => {
    const documents = baseDocuments({ exits: { a: 1 } });
    const ok = verifyBaseRun(baseInput(documents));
    expect(ok.ok && ok.outcome).toBe("code_failure");
    const input = baseInput(documents);
    const reject = (patch: Partial<typeof input>, reason: string) =>
      expect(verifyBaseRun({ ...input, ...patch })).toEqual({ ok: false, reason });
    reject({ latestAttempt: 2 }, "stale base run attempt");
    reject(
      { run: { ...input.run, branch: `${PREFIX}${BASE_RUN_ID}` } },
      "base run is not bound to the exact base ref and tip",
    );
    reject(
      { run: { ...input.run, headSha: "0".repeat(40) } },
      "base run is not bound to the exact base ref and tip",
    );
    reject(
      { run: { ...input.run, workflow: ".github/workflows/ci.yml" } },
      "base run is not the batch workflow",
    );
    reject({ run: { ...input.run, status: "in_progress" } }, "base run has not completed");
    reject({ run: { ...input.run, id: 902 } }, "base result is not verifiable for this exact run");
    const { purpose: _purpose, ...unlabelled } = documents.result;
    reject({ result: unlabelled }, "base result is not verifiable for this exact run");
    reject(
      {
        base: { ...input.base, manifest: { ...input.base.manifest, recipeDigest: "0".repeat(64) } },
      },
      "base recipe differs from the frozen recipe",
    );
    reject(
      { base: { ...input.base, manifest: { ...input.base.manifest, planDigest: "0".repeat(64) } } },
      "base plan digest differs",
    );
    reject(
      { base: { ...input.base, manifest: { ...input.base.manifest, baseSha: "0".repeat(40) } } },
      "comparison identity differs from the exact run",
    );
  });

  test("tampered, unbound, stale-attempt or old evidence is never usable", () => {
    const documents = baseDocuments();
    const input = baseInput(documents);
    const reject = (result: unknown, evidence: unknown, reason: string) =>
      expect(verifyBaseRun({ ...input, result, evidence })).toEqual({ ok: false, reason });
    const { comparison: _comparison, ...old } = documents.result;
    reject(old, documents.evidence, "absent comparison metadata: attribution held");
    reject(
      documents.result,
      { ...documents.evidence, reasons: [], planDigest: "0".repeat(64) },
      "comparison evidence is not bound to its result",
    );
    const wrongAttempt = rebound({
      result: documents.result,
      evidence: { ...documents.evidence, runAttempt: 2 },
    });
    reject(
      wrongAttempt.result,
      wrongAttempt.evidence,
      "comparison identity differs from the exact run",
    );
    const wrongRun = rebound({
      result: documents.result,
      evidence: { ...documents.evidence, runId: "1" },
    });
    reject(wrongRun.result, wrongRun.evidence, "comparison identity differs from the exact run");
    const schema = rebound({
      result: {
        ...documents.result,
        comparison: {
          ...(documents.result.comparison as object),
          comparisonSchema: "batch-base-comparison/v0",
        },
      },
      evidence: documents.evidence,
    });
    reject(schema.result, schema.evidence, "comparison schema differs");
    // Recomputed fields cannot be asserted: inventory, recipe and completeness.
    const dropped = structuredClone(documents.evidence);
    dropped.coverage.units.pop();
    const droppedBound = rebound({ result: documents.result, evidence: dropped });
    reject(droppedBound.result, droppedBound.evidence, "inventory digest mismatch");
    const env = structuredClone(documents.evidence);
    env.environment.unit = { ...env.environment.unit!, postgres: "PostgreSQL 17" };
    const envBound = rebound({ result: documents.result, evidence: env });
    reject(envBound.result, envBound.evidence, "recipe digest mismatch");
    const claim = structuredClone(documents.evidence);
    claim.coverage.units[0]!.status = "not-run";
    const claimBound = rebound({ result: documents.result, evidence: claim });
    reject(claimBound.result, claimBound.evidence, "coverage completeness claim mismatch");
    const steps = structuredClone(documents.evidence);
    steps.coverage.sourceSteps.pop();
    const stepsBound = rebound({ result: documents.result, evidence: steps });
    reject(stepsBound.result, stepsBound.evidence, "malformed source step evidence");
  });

  test("incomplete, non-code or differently provisioned base runs are not comparable", () => {
    const timeout = baseDocuments({ exits: { b: 124 } });
    expect(verifyBaseRun(baseInput(timeout))).toEqual({
      ok: false,
      reason: "base run ended infrastructure; not comparable",
    });
    const notRun = baseDocuments({ exits: { a: 1, cd: null } });
    expect(verifyBaseRun(baseInput(notRun))).toEqual({
      ok: false,
      reason: "base coverage incomplete",
    });
    const sourceKilled = baseDocuments({ steps: { guards: 137 } });
    expect(verifyBaseRun(baseInput(sourceKilled)).ok).toBe(false);
    const noPostgres = baseDocuments({ unitEnv: { ...UNIT_ENV, postgres: null } });
    expect(noPostgres.evidence.recipeDigest).toBeNull();
    expect(noPostgres.evidence.coverage.complete).toBe(false);
  });
});

describe("failure attribution verdicts", () => {
  const complete = verifiedBase(baseDocuments({ exits: { b: 1 } }));

  test("a candidate failure is new only where the base passed the identical unit", () => {
    const candidate = verifiedCandidate(candidateRun({ exits: { a: 1 } }));
    expect(
      compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: complete }),
    ).toEqual({
      verdict: "new-failure-demonstrated",
      units: [{ category: "parallel", files: ["a.test.ts"] }],
      steps: [],
    });
    const stepFailure = verifiedCandidate(candidateRun({ steps: { typecheck: 2 } }));
    expect(
      compareFailures({ outcome: "code_failure", evidence: stepFailure }, { evidence: complete }),
    ).toEqual({ verdict: "new-failure-demonstrated", units: [], steps: ["typecheck"] });
  });

  test("a failure the base also failed is held, never declared inherited", () => {
    // Fail-fast candidate: partial evidence, but its observed failure is usable.
    const candidate = verifiedCandidate(candidateRun({ exits: { b: 1, cd: null } }));
    expect(candidate.coverage.complete).toBe(false);
    expect(
      compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: complete }),
    ).toEqual({
      verdict: "no-demonstrated-new-failure",
    });
    const timeoutOnly = verifiedCandidate(candidateRun({ exits: { a: 1, b: 124 } }));
    expect(
      compareFailures({ outcome: "code_failure", evidence: timeoutOnly }, { evidence: complete })
        .verdict,
    ).toBe("new-failure-demonstrated");
  });

  test("a batched process is one identity; a different grouping is not demonstrable", () => {
    const regrouped = structuredClone(complete);
    regrouped.coverage.units = [
      ...regrouped.coverage.units.slice(0, 2),
      { category: "parallel", files: ["c.test.ts"], status: "pass", exitCode: 0 },
      { category: "parallel", files: ["d.test.ts"], status: "pass", exitCode: 0 },
    ];
    const candidate = verifiedCandidate(candidateRun({ exits: { cd: 1 } }));
    expect(
      compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: complete }),
    ).toEqual({
      verdict: "new-failure-demonstrated",
      units: [{ category: "parallel", files: ["c.test.ts", "d.test.ts"] }],
      steps: [],
    });
    expect(
      compareFailures({ outcome: "code_failure", evidence: candidate }, { evidence: regrouped }),
    ).toEqual({ verdict: "no-demonstrated-new-failure" });
  });

  test("different plan, recipe, base or purpose holds as not comparable", () => {
    const candidate = verifiedCandidate(candidateRun({ exits: { a: 1 } }));
    const verdict = (
      c: ComparisonEvidence,
      b: ComparisonEvidence = complete,
      outcome = "code_failure" as const,
    ) => compareFailures({ outcome, evidence: c }, { evidence: b });
    expect(verdict({ ...candidate, planDigest: "0".repeat(64) }).verdict).toBe("not-comparable");
    expect(verdict({ ...candidate, recipeDigest: "0".repeat(64) }).verdict).toBe("not-comparable");
    expect(verdict({ ...candidate, recipeDigest: null }).verdict).toBe("not-comparable");
    expect(verdict({ ...candidate, baseSha: "0".repeat(40) }).verdict).toBe("not-comparable");
    expect(verdict(candidate, { ...complete, purpose: "candidate" }).verdict).toBe(
      "not-comparable",
    );
    expect(
      verdict(candidate, { ...complete, coverage: { ...complete.coverage, complete: false } })
        .verdict,
    ).toBe("not-comparable");
    expect(
      compareFailures({ outcome: "success", evidence: candidate }, { evidence: complete }).verdict,
    ).toBe("not-comparable");
    const otherEnvironment = verifiedCandidate(
      candidateRun({ exits: { a: 1 }, unitEnv: { ...UNIT_ENV, imageVersion: "20261026.1" } }),
    );
    expect(verdict(otherEnvironment)).toEqual({
      verdict: "not-comparable",
      reason: "execution recipe or environment differs",
    });
  });
});

describe("bounded run-bound artifact readers", () => {
  function zip(member: string, data: unknown): Uint8Array<ArrayBuffer> {
    const name = Buffer.from(member),
      payload = Buffer.from(JSON.stringify(data));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + payload.length, 16);
    return new Uint8Array(Buffer.concat([local, name, payload, central, name, end]));
  }
  const run = { id: 77, attempt: 2, headSha: CANDIDATE.tipSha };
  function reader(
    artifacts: Record<string, unknown>[],
    bodies: Record<number, Uint8Array<ArrayBuffer>>,
  ) {
    const requests: string[] = [];
    const transport = (async (url: string) => {
      requests.push(url);
      if (url.includes(`/actions/runs/${run.id}/artifacts`))
        return Response.json({ total_count: artifacts.length, artifacts });
      const id = Number(url.match(/artifacts\/(\d+)\/zip/)?.[1]);
      return bodies[id] ? new Response(bodies[id]) : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    return {
      requests,
      github: new GitHubReader(
        config({ GITHUB_REPOSITORY: "Cloudgeni-ai/opengeni" }),
        new GitHubAuth({ GH_TOKEN: "test" }),
        transport,
      ),
    };
  }
  const artifact = (id: number, name: string, extra: object = {}) => ({
    id,
    name,
    expired: false,
    size_in_bytes: 500,
    workflow_run: { id: run.id, head_sha: run.headSha },
    ...extra,
  });

  test("the frozen plan binds exact run, attempt, tip and verified digest", async () => {
    const body = { 1: zip("execution-plan.json", PLAN) };
    const exact = reader([artifact(1, "batch-plan-2")], body);
    expect(await exact.github.planArtifact(run, digest(PLAN))).toEqual(PLAN);
    for (const rows of [
      [artifact(1, "batch-plan-1")],
      [artifact(1, "batch-plan-2", { workflow_run: { id: 78, head_sha: run.headSha } })],
      [artifact(1, "batch-plan-2", { workflow_run: { id: run.id, head_sha: "0".repeat(40) } })],
      [artifact(1, "batch-plan-2", { expired: true })],
      [artifact(1, "batch-plan-2", { size_in_bytes: 9_000_000 })],
      [artifact(1, "batch-plan-2"), artifact(2, "batch-plan-2")],
    ])
      expect(
        await reader(rows, { ...body, 2: body[1] }).github.planArtifact(run, digest(PLAN)),
      ).toBeNull();
    expect(
      await reader([artifact(1, "batch-plan-2")], body).github.planArtifact(run, "0".repeat(64)),
    ).toBeNull();
    const unnormalized = {
      1: zip("execution-plan.json", { ...PLAN, unitTests: ["d.test.ts", "a.test.ts"] }),
    };
    expect(
      await reader([artifact(1, "batch-plan-2")], unnormalized).github.planArtifact(
        run,
        digest(PLAN),
      ),
    ).toBeNull();
    const wrongMember = { 1: zip("impact-plan.json", PLAN) };
    expect(
      await reader([artifact(1, "batch-plan-2")], wrongMember).github.planArtifact(
        run,
        digest(PLAN),
      ),
    ).toBeNull();
  });

  test("comparison documents come only from the same exact attempt", async () => {
    const documents = candidateRun({ exits: { a: 1 } });
    const bodies = {
      1: zip("batch-result.json", documents.result),
      2: zip("batch-comparison.json", documents.evidence),
    };
    const both = [artifact(1, "batch-result-2"), artifact(2, "batch-comparison-2")];
    expect(await reader(both, bodies).github.comparisonArtifacts(run)).toEqual({
      result: JSON.parse(JSON.stringify(documents.result)),
      evidence: documents.evidence,
    });
    expect(
      await reader(
        [artifact(1, "batch-result-2"), artifact(2, "batch-comparison-1")],
        bodies,
      ).github.comparisonArtifacts(run),
    ).toBeNull();
    expect(
      await reader([artifact(1, "batch-result-2")], bodies).github.comparisonArtifacts(run),
    ).toBeNull();
  });
});
