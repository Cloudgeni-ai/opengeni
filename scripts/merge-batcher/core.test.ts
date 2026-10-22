import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admit, type PullInput } from "./evidence";
import { AtomicGitWriter, GitStore, MergeConflict } from "./git";
import {
  Controller,
  LiveReader,
  FencedGitExecutor,
  type AdmissionCoordinator,
  type Reader,
  type Transaction,
} from "./controller";
import {
  GitHubAuth,
  GitHubReader,
  GitHubMutations,
  githubCapabilities,
  readResultZip,
  requireActiveCapabilities,
  ProviderError,
  isControlPlanePath,
} from "./github";
import {
  bindingKey,
  canonical,
  config,
  digest,
  emptyLedger,
  type BatchSpec,
  type Candidate,
  type Manifest,
  type Observation,
  type Pull,
  type Run,
} from "./model";
import { fifo, plan, infrastructureRetryReason } from "./planner";
import { classifyExit, verifyResult } from "./result";
import { QueueOnlyPublisher, ShadowCiController } from "./shadow-ci";
import { ObservationJournal, latencySummary } from "./journal";
import { DiskCache } from "./cache";
import { recoverLocalMissing } from "./main";

const NOW = "2026-10-21T11:00:00.000Z";
const SHA = "a".repeat(40);
const cfg = config({});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function pull(
  number: number,
  headSha = String(number).repeat(40).slice(0, 40),
  second = number,
): Pull {
  return {
    number,
    headSha,
    headRef: `feature-${number}`,
    binding: {
      eventId: `event-${number}`,
      at: new Date(Date.parse(NOW) + second * 1000).toISOString(),
      source: "queue-ready",
      evidenceId: `${number}`,
      evidenceDigest: digest(number),
    },
  };
}
function spec(pulls = [pull(1)], baseSha = SHA, predecessor: string | null = null): BatchSpec {
  return { schemaVersion: 1, baseSha, predecessor, recoveryOf: null, createdAt: NOW, pulls };
}
function candidate(pulls = [pull(1)], baseSha = SHA, predecessor: string | null = null): Candidate {
  const s = spec(pulls, baseSha, predecessor),
    batchId = digest(s);
  const manifest: Manifest = {
    ...s,
    batchId,
    tipSha: digest(batchId).slice(0, 40),
    pulls: pulls.map((p) => ({ ...p, mergeSha: digest(p).slice(0, 40) })),
  };
  return { manifest, branch: `queue/${batchId}`, runs: [], containedInBase: false };
}
function run(c: Candidate, outcome: Run["outcome"], attempt = 1, trusted = true): Run {
  return {
    id: 100,
    attempt,
    headSha: c.manifest.tipSha,
    branch: c.branch,
    workflow: cfg.workflow,
    status: "completed",
    outcome,
    trusted,
    retryable: outcome === "code_failure",
    ...(outcome === "infrastructure"
      ? {
          infrastructureRetryReason: trusted
            ? ("verified-infrastructure" as const)
            : ("no-job-logs" as const),
        }
      : outcome === "cancelled"
        ? { infrastructureRetryReason: "provider-cancelled" as const }
        : {}),
    completedAt: NOW,
  };
}
function receiptResult(c: Candidate, attempt = 1) {
  const identity = {
    schemaVersion: 1,
    batchId: c.manifest.batchId,
    headSha: c.manifest.tipSha,
    runId: "100",
    runAttempt: attempt,
  };
  return {
    ...identity,
    outcome: "success",
    retryable: false,
    reason: "fixture",
    expectedJobs: ["plan", "source"],
    jobs: { plan: "success", source: "success", units: "skipped" },
    tasks: ["plan", "source"].map((job) => ({
      ...identity,
      job,
      exitCode: 0,
      outcome: "success",
      retryable: false,
      startedAt: NOW,
      finishedAt: NOW,
    })),
  };
}
function observation(ready = [pull(1)], candidates: Candidate[] = []): Observation {
  return {
    now: "2026-10-21T12:00:00.000Z",
    baseSha: SHA,
    baseCI: { sha: SHA, status: "green", runId: 50, attempt: 1, reason: "fixture exact-base CI" },
    ready,
    excluded: [],
    candidates,
    stateSha: null,
    ledger: emptyLedger(),
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "merge-batcher-"));
  roots.push(root);
  const git = new GitStore(join(root, "cache.git")),
    origin = new GitStore(join(root, "origin.git"));
  await git.init();
  await origin.init();
  const commitFiles = async (
    store: GitStore,
    files: Record<string, string>,
    parents: string[] = [],
  ) => {
    const entries: string[] = [];
    for (const [name, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      const hash = await store.exec(["hash-object", "-w", "--stdin"], content);
      entries.push(`100644 blob ${hash}\t${name}`);
    }
    const tree = await store.exec(["mktree"], `${entries.join("\n")}\n`);
    return store.commit(tree, parents, "fixture", NOW);
  };
  const base = await commitFiles(origin, { "base.txt": "base\n" });
  await origin.exec(["update-ref", "refs/heads/main", base]);
  const first = await commitFiles(origin, { "base.txt": "base\n", "one.txt": "one\n" }, [base]);
  const second = await commitFiles(origin, { "base.txt": "base\n", "two.txt": "two\n" }, [base]);
  await origin.exec(["update-ref", "refs/heads/one", first]);
  await origin.exec(["update-ref", "refs/heads/two", second]);
  await git.fetch(origin.dir, [base, first, second]);
  return { root, git, origin, base, first, second, commitFiles };
}

describe("readiness and deterministic planning", () => {
  const input = (): PullInput => ({
    number: 1,
    headSha: SHA,
    headRef: "feature",
    draft: false,
    autoMerge: true,
    queueReady: false,
    events: [{ id: "event", at: NOW, source: "auto-merge", enabled: true }],
    comments: [
      {
        id: "comment",
        body: `Exact head ${SHA}. VM tests passed: bun test. Independent agent review passed; reviewer session 12345678-1234-1234-1234-123456789abc. No limitations.`,
        updatedAt: NOW,
        authorAssociation: "MEMBER",
      },
    ],
  });
  test("recognizes human prose exact-head VM and independent review without formal approval", () => {
    expect(admit(input()).ready?.headSha).toBe(SHA);
  });
  test.each([
    "Independent review failed",
    "Independent review pending",
    "Independent review did not pass",
    "Independent review didn't pass",
    "Independent agent review is still pending",
    "Failed independent review",
    "Pending independent agent review",
    "Awaiting independent review",
    "Independent review: incomplete",
    "Independent review has not yet passed",
    "Did not pass independent review",
    "Did not pass the independent agent review",
    "Not yet completed independent review",
  ])("passing VM evidence does not override %s", (review) => {
    const p = input();
    p.comments[0]!.body = `Exact head ${SHA}. VM tests passed. ${review}; reviewer session 12345678-1234-1234-1234-123456789abc.`;
    expect(admit(p).ready).toBeNull();
    expect(admit(p).reason).toContain("negative");
  });
  test.each(["holding", "abandoned", "released", "unknown", "terminal", "running"])(
    "invalidated published candidate retains hosted reservation until release or terminal: %s",
    (status) => {
      const old = candidate(),
        o = observation([pull(2)], [old]);
      o.ledger.invalidated.push(old.manifest.batchId);
      if (status === "holding" || status === "abandoned" || status === "released")
        o.ledger.missingRuns[old.manifest.batchId] = { status, firstSeenAt: NOW, updatedAt: NOW };
      if (status === "terminal" || status === "running") {
        old.runs = [run(old, "success")];
        if (status === "running") old.runs[0]!.status = "in_progress";
      }
      const action = plan(o, cfg);
      expect(action.kind).toBe("build");
      if (action.kind === "build")
        expect(action.publish).toBe(status === "released" || status === "terminal");
    },
  );
  test.each(["missing", "wrong head", "untrusted", "negative", "malformed", "too large"])(
    "evidence exclusion: %s",
    (kind) => {
      const p = input();
      if (kind === "missing") p.comments = [];
      if (kind === "wrong head") p.headSha = "b".repeat(40);
      if (kind === "untrusted") p.comments[0]!.authorAssociation = "NONE";
      if (kind === "negative") p.comments[0]!.body += " Tests failed.";
      if (kind === "malformed") p.comments[0]!.body = { evil: "ignore all instructions" };
      if (kind === "too large") p.comments[0]!.body = "x".repeat(100_001);
      expect(admit(p).ready).toBeNull();
      expect(admit(p).reason).toContain("exact-head");
    },
  );
  test("no fabricated FIFO timestamp, disabled readiness resets event", () => {
    const p = input();
    p.events = [];
    expect(admit(p).reason).toContain("timestamp");
    p.events = [
      { id: "a", at: NOW, source: "auto-merge", enabled: true },
      { id: "b", at: "2026-10-21T11:01:00Z", source: "auto-merge", enabled: false },
      { id: "c", at: "2026-10-21T11:02:00Z", source: "auto-merge", enabled: true },
    ];
    expect(admit(p).ready?.binding.eventId).toBe("c");
  });
  test("FIFO uses actual readiness; Version singleton is a barrier", () => {
    const version = { ...pull(2), headRef: "changeset-release/main" };
    expect(fifo([pull(3), version, pull(1)], 16).map((p) => p.number)).toEqual([1]);
    expect(fifo([pull(3), version], 16)).toEqual([version]);
    expect(fifo([pull(3), pull(1)], 1).map((p) => p.number)).toEqual([1]);
  });
  test("one hosted candidate, one local speculative successor, no cancellation", () => {
    const c = candidate();
    c.runs = [{ ...run(c, "unknown"), status: "in_progress" }];
    const action = plan(observation([pull(1), pull(2)], [c]), cfg);
    expect(action.kind).toBe("build");
    if (action.kind !== "build") return;
    expect(action.publish).toBe(false);
    expect(action.spec.baseSha).toBe(c.manifest.tipSha);
    expect(action.spec.predecessor).toBe(c.manifest.batchId);
  });
  test("changed head invalidates all descendants without cancelling their runs", () => {
    const a = candidate(),
      b = candidate([pull(2)], a.manifest.tipSha, a.manifest.batchId);
    b.runs = [{ ...run(b, "unknown"), status: "in_progress" }];
    const action = plan(observation([pull(1, "f".repeat(40)), pull(2)], [a, b]), cfg);
    expect(action.kind).toBe("record");
    if (action.kind === "record")
      expect(action.ledger.invalidated).toEqual([a.manifest.batchId, b.manifest.batchId]);
    expect(b.runs[0]!.status).toBe("in_progress");
  });
  test("edited evidence and removed ready signal invalidate a candidate", () => {
    const c = candidate();
    const p = pull(1);
    p.binding.evidenceDigest = digest("edited");
    expect(plan(observation([p], [c]), cfg).kind).toBe("record");
    expect(plan(observation([], [c]), cfg).kind).toBe("record");
  });
  test("first code-red predecessor invalidates speculative descendants without cancelling", () => {
    const a = candidate(),
      b = candidate([pull(2)], a.manifest.tipSha, a.manifest.batchId);
    a.runs = [run(a, "code_failure")];
    b.runs = [{ ...run(b, "unknown"), status: "in_progress" }];
    const action = plan(observation([pull(1), pull(2)], [a, b]), cfg);
    expect(action.kind).toBe("record");
    if (action.kind === "record") expect(action.ledger.invalidated).toEqual([b.manifest.batchId]);
    expect(b.runs[0]!.status).toBe("in_progress");
  });
  test("recovery halves cannot be regrouped speculatively even with spare hosted capacity", () => {
    const c = candidate();
    c.manifest.recoveryOf = digest("failed-parent");
    c.runs = [{ ...run(c, "unknown"), status: "in_progress" }];
    const o = observation([pull(1), pull(2), pull(3)], [c]);
    o.ledger.recovery = [{ batchId: digest("failed-parent"), pulls: [pull(2)] }];
    expect(plan(o, { ...cfg, maxInflight: 2 }).kind).toBe("wait");
  });
  test("first trusted code failure holds without retry or speculative bisection", () => {
    const c = candidate([pull(1), pull(2), pull(3)]);
    c.runs = [run(c, "code_failure")];
    const action = plan(observation(c.manifest.pulls, [c]), cfg);
    expect(action.kind).toBe("wait");
    if (action.kind === "wait") expect(action.reason).toContain("base_batch_suite_unknown");
  });
  test.each(["cancelled", "infrastructure", "unknown"] as const)(
    "%s never incriminates PRs and backs off",
    (outcome) => {
      const c = candidate();
      c.runs = [run(c, outcome, 1, false)];
      const o = observation([pull(1)], [c]);
      o.now = NOW;
      expect(plan(o, cfg).kind).toBe("wait");
      o.now = "2026-10-21T12:00:00Z";
      expect(plan(o, cfg).kind).toBe(outcome === "unknown" ? "wait" : "retry");
      c.runs.push(run(c, outcome, 2, false));
      expect(plan(o, cfg).kind).toBe("wait");
      expect(o.ledger.ejected).toEqual([]);
    },
  );
  test("untrusted or wrong workflow failure does not count as a code failure", () => {
    const c = candidate();
    c.runs = [
      run(c, "code_failure", 1, false),
      { ...run(c, "code_failure", 2), workflow: "evil.yml" },
    ];
    expect(plan(observation([pull(1)], [c]), cfg).kind).toBe("wait");
  });
  test("ejected exact head stays out after evidence edit; changed/re-ready heads return", () => {
    const c = candidate();
    const o = observation([pull(1)], []);
    o.ledger.ejected.push({
      pull: pull(1),
      batchId: c.manifest.batchId,
      reason: "merge-tree conflict against candidate predecessor",
      announced: true,
    });
    expect(plan(o, cfg).kind).toBe("wait");
    o.ready[0]!.binding.evidenceDigest = digest("new prose");
    expect(plan(o, cfg).kind).toBe("wait");
    o.ready[0]!.binding.eventId = "re-ready";
    expect(plan(o, cfg).kind).toBe("build");
    o.ready = [pull(1, "f".repeat(40))];
    expect(plan(o, cfg).kind).toBe("build");
  });
  test("restart retry intent does not duplicate uncertain provider request", () => {
    const c = candidate();
    c.runs = [run(c, "infrastructure")];
    const o = observation([pull(1)], [c]);
    o.ledger.retries[c.manifest.batchId] = { runId: 100, fromAttempt: 1, requestedAt: NOW };
    expect(plan(o, cfg).kind).toBe("wait");
    c.runs.push(run(c, "success", 2));
    expect(plan(o, cfg).kind).toBe("land");
  });
  test("durable code-failure receipt survives first-attempt artifact replacement", () => {
    const c = candidate();
    c.runs = [run(c, "unknown", 1, false), run(c, "code_failure", 2)];
    const o = observation([pull(1)], [c]);
    o.ledger.codeFailures[c.manifest.batchId] = ["100/1"];
    const action = plan(o, cfg);
    expect(action.kind).toBe("wait");
    expect(o.ledger.ejected).toEqual([]);
  });
  test("landed tip reconstruction prevents duplicate landing after restart", () => {
    const c = candidate();
    c.containedInBase = true;
    c.runs = [run(c, "success")];
    const o = observation([], [c]);
    const a = plan(o, cfg);
    expect(a.kind).toBe("record");
    if (a.kind === "record") {
      o.ledger = a.ledger;
      expect(plan(o, cfg).kind).toBe("wait");
    }
  });
  test("provider lag closing an already-landed PR does not re-enqueue its head", () => {
    const c = candidate();
    c.containedInBase = true;
    const o = observation([pull(1)], [c]);
    o.ledger.landed = [c.manifest.batchId];
    expect(plan(o, cfg).kind).toBe("wait");
  });
  test("Version cannot be speculated behind or ahead of ordinary in-flight batch", () => {
    const version = { ...pull(2), headRef: "changeset-release/main" };
    const a = candidate();
    a.runs = [{ ...run(a, "unknown"), status: "in_progress" }];
    expect(plan(observation([pull(1), version], [a]), cfg).kind).toBe("wait");
    const b = candidate([version]);
    b.runs = [{ ...run(b, "unknown"), status: "in_progress" }];
    expect(plan(observation([version, pull(3)], [b]), cfg).kind).toBe("wait");
  });
});

describe("real temporary bare Git", () => {
  test("deterministic two-parent chain, exact trees, inspect and cache-free reconstruction", async () => {
    const f = await fixture();
    const s = spec([pull(1, f.first), pull(2, f.second)], f.base);
    const m = await f.git.build(s);
    expect(await f.git.build(s)).toEqual(m);
    expect(await f.git.inspect(m.tipSha)).toEqual(m);
    expect(await f.git.exec(["show", `${m.tipSha}:one.txt`])).toBe("one");
    expect(await f.git.exec(["show", `${m.tipSha}:two.txt`])).toBe("two");
    expect(await f.git.exec(["show", "-s", "--format=%P", m.pulls[0]!.mergeSha])).toBe(
      `${f.base} ${f.first}`,
    );
    expect(await f.git.exec(["show", "-s", "--format=%P", m.tipSha])).toBe(
      `${m.pulls[0]!.mergeSha} ${f.second}`,
    );
    await f.git.exec(["push", f.origin.dir, `${m.tipSha}:refs/heads/queue/${m.batchId}`]);
    const restarted = new GitStore(join(f.root, "restart.git"));
    await restarted.init();
    await restarted.fetch(f.origin.dir, [m.tipSha]);
    expect(await restarted.inspect(m.tipSha)).toEqual(m);
  });
  test("conflicts identify exact member without a checkout", async () => {
    const f = await fixture();
    const one = await f.commitFiles(f.git, { "base.txt": "left\n" }, [f.base]);
    const two = await f.commitFiles(f.git, { "base.txt": "right\n" }, [f.base]);
    try {
      await f.git.build(spec([pull(1, one), pull(2, two)], f.base));
      throw new Error("expected conflict");
    } catch (e) {
      expect(e).toBeInstanceOf(MergeConflict);
      expect((e as MergeConflict).number).toBe(2);
    }
  });
  test("tampered tree, parents and missing manifest rejected", async () => {
    const f = await fixture(),
      s = spec([pull(1, f.first)], f.base),
      m = await f.git.build(s);
    const message = await f.git.exec(["show", "-s", "--format=%B", m.tipSha]);
    const tree = await f.git.exec(["rev-parse", `${f.base}^{tree}`]);
    const wrongTree = await f.git.commit(tree, [f.base, f.first], message, NOW);
    await expect(f.git.inspect(wrongTree)).rejects.toThrow("composition");
    const wrongParents = await f.git.commit(tree, [f.base], message, NOW);
    await expect(f.git.inspect(wrongParents)).rejects.toThrow("topology");
    await expect(f.git.inspect(f.base)).rejects.toThrow("manifest");
  });
  test("exact CAS landing with changing lease, stale controller and duplicate rejected atomically", async () => {
    const f = await fixture(),
      m = await f.git.build(spec([pull(1, f.first)], f.base));
    const state = { ...emptyLedger(), epoch: 1, owner: "A", expiresAt: NOW };
    const fence = await f.git.stateCommit(state, null, NOW);
    const writer = new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main");
    await writer.transaction([
      { ref: cfg.stateRef, expected: null, next: fence },
      { ref: "refs/heads/main", expected: f.base, next: m.tipSha },
    ]);
    const stale = await f.git.stateCommit({ ...state, owner: "B" }, null, NOW);
    await expect(
      writer.transaction([
        { ref: cfg.stateRef, expected: null, next: stale },
        { ref: "refs/heads/main", expected: f.base, next: f.second },
      ]),
    ).rejects.toThrow();
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(m.tipSha);
    await expect(
      writer.transaction([{ ref: cfg.stateRef, expected: fence, next: fence }]),
    ).rejects.toThrow("changing");
    const next = await f.git.stateCommit({ ...state, epoch: 2 }, fence, NOW);
    await expect(
      writer.transaction([
        { ref: cfg.stateRef, expected: fence, next },
        { ref: "refs/heads/main", expected: m.tipSha, next: f.second },
      ]),
    ).rejects.toThrow("Non-fast-forward");
    expect((await f.git.remoteRefs(f.origin.dir)).get(cfg.stateRef)).toBe(fence);
  });
  test("main advances between ancestry check and CAS: no lease or main mutation", async () => {
    const f = await fixture(),
      m = await f.git.build(spec([pull(1, f.first)], f.base));
    const fence = await f.git.stateCommit({ ...emptyLedger(), epoch: 1 }, null, NOW);
    await f.origin.exec(["update-ref", "refs/heads/main", f.second, f.base]);
    const writer = new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main");
    await expect(
      writer.transaction([
        { ref: cfg.stateRef, expected: null, next: fence },
        { ref: "refs/heads/main", expected: f.base, next: m.tipSha },
      ]),
    ).rejects.toThrow();
    const refs = await f.git.remoteRefs(f.origin.dir);
    expect(refs.get("refs/heads/main")).toBe(f.second);
    expect(refs.has(cfg.stateRef)).toBe(false);
  });
  test("server without atomic capability refuses transaction with no fallback", async () => {
    const f = await fixture();
    await f.origin.exec(["config", "receive.advertiseAtomic", "false"]);
    const next = await f.git.stateCommit({ ...emptyLedger(), epoch: 1 }, null, NOW);
    await expect(
      new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main").transaction([
        { ref: cfg.stateRef, expected: null, next },
      ]),
    ).rejects.toThrow();
    expect((await f.git.remoteRefs(f.origin.dir)).has(cfg.stateRef)).toBe(false);
  });
});

describe("controller isolation and fencing", () => {
  const capabilities = {
    atomicRefs: true,
    atomicReadyFence: true,
    fencedSideEffects: true,
    reason: "test provider",
  };
  test("shadow builds locally but never calls a write adapter, even if supplied", async () => {
    const f = await fixture();
    const o = { ...observation([pull(1, f.first)]), baseSha: f.base };
    let writes = 0;
    const controller = new Controller(
      { ...cfg, outputDir: join(f.root, "stage") },
      { observe: async () => o },
      f.git,
      "shadow",
      {
        capabilities,
        transact: async () => {
          writes++;
        },
      },
    );
    const before = await f.git.remoteRefs(f.origin.dir);
    const r = await controller.step();
    expect(r.manifest?.pulls[0]!.headSha).toBe(f.first);
    expect(writes).toBe(0);
    expect(await f.git.remoteRefs(f.origin.dir)).toEqual(before);
    const saved = JSON.parse(await readFile(join(f.root, "stage", "stage.json"), "utf8"));
    expect(saved.result.manifest.tipSha).toBe(r.manifest!.tipSha);
  });
  test("active provider capability/permission gap fails before observation or mutation", async () => {
    const f = await fixture();
    let reads = 0,
      writes = 0;
    const controller = new Controller(
      { ...cfg, mode: "active", outputDir: join(f.root, "stage") },
      {
        observe: async () => {
          reads++;
          return observation();
        },
      },
      f.git,
      "A",
      {
        capabilities: githubCapabilities,
        transact: async () => {
          writes++;
        },
      },
    );
    await expect(controller.step()).rejects.toThrow("GitHub provides atomic");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(() => requireActiveCapabilities(githubCapabilities)).toThrow();
  });
  test("head changes during final landing recheck: no transaction", async () => {
    const f = await fixture(),
      m = await f.git.build(spec([pull(1, f.first)], f.base));
    const c: Candidate = {
      manifest: m,
      branch: `queue/${m.batchId}`,
      runs: [],
      containedInBase: false,
    };
    c.runs = [run(c, "success")];
    const o = {
      ...observation(m.pulls, [c]),
      baseSha: f.base,
      baseCI: { ...observation().baseCI!, sha: f.base },
    };
    let reads = 0,
      writes = 0;
    const reader: Reader = {
      observe: async () => {
        reads++;
        return reads === 1 ? o : { ...o, ready: [pull(1, f.second)] };
      },
    };
    const controller = new Controller(
      { ...cfg, mode: "active", outputDir: join(f.root, "stage") },
      reader,
      f.git,
      "A",
      {
        capabilities,
        transact: async () => {
          writes++;
        },
      },
    );
    expect((await controller.step()).reason).toContain("changed");
    expect(writes).toBe(0);
  });
  test("two controllers race: only one fenced publication; stale lease cannot land", async () => {
    const f = await fixture(),
      o = {
        ...observation([pull(1, f.first)]),
        baseSha: f.base,
        baseCI: { ...observation().baseCI!, sha: f.base },
      };
    const writer = new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main");
    const coordinator: AdmissionCoordinator = {
      capabilities,
      fenced: async (t, commit) => {
        if (t.bindings.some((p) => !o.ready.some((x) => bindingKey(x) === bindingKey(p))))
          throw new Error("changed ready fence");
        await commit();
      },
    };
    const executor = new FencedGitExecutor(writer, coordinator);
    const controllers = ["A", "B"].map(
      (owner) =>
        new Controller(
          { ...cfg, mode: "active", outputDir: join(f.root, owner) },
          { observe: async () => o },
          f.git,
          owner,
          executor,
        ),
    );
    const results = await Promise.allSettled(controllers.map((x) => x.step()));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const refs = await f.git.remoteRefs(f.origin.dir);
    expect([...refs.keys()].filter((x) => x.startsWith("refs/heads/queue/"))).toHaveLength(1);
    const state = await f.git.readLedger(refs.get(cfg.stateRef)!);
    expect(state.epoch).toBe(1);
    const stale: Transaction = {
      expectedState: refs.get(cfg.stateRef)!,
      nextState: SHA,
      expectedLedger: { ...state, expiresAt: "2099-01-01T00:00:00Z" },
      nextLedger: { ...state, owner: "intruder", epoch: 2 },
      now: NOW,
      bindings: [],
      effect: { kind: "record" },
    };
    await expect(executor.transact(stale)).rejects.toThrow("cannot be stolen");
  });
  test("atomic readiness coordinator closes post-recheck race and no duplicate landing", async () => {
    const f = await fixture(),
      m = await f.git.build(spec([pull(1, f.first)], f.base));
    const c: Candidate = {
      manifest: m,
      branch: `queue/${m.batchId}`,
      runs: [],
      containedInBase: false,
    };
    c.runs = [run(c, "success")];
    const o = {
      ...observation(m.pulls, [c]),
      baseSha: f.base,
      baseCI: { ...observation().baseCI!, sha: f.base },
    };
    let changed = true;
    const executor = new FencedGitExecutor(
      new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main"),
      {
        capabilities,
        fenced: async (_t, commit) => {
          if (changed) throw new Error("atomic ready binding changed");
          await commit();
        },
      },
    );
    const controller = new Controller(
      { ...cfg, mode: "active", outputDir: join(f.root, "stage") },
      { observe: async () => o },
      f.git,
      "A",
      executor,
    );
    await expect(controller.step()).rejects.toThrow("binding changed");
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.base);
    changed = false;
    await controller.step();
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(m.tipSha);
    await expect(controller.step()).rejects.toThrow();
  });
  test("end-to-end restart each tick: failed batch holds without retry, split, landing or blame", async () => {
    const f = await fixture();
    const ready = [pull(1, f.first), pull(2, f.second)];
    const histories = new Map<string, Run[]>();
    let sequence = 100,
      retryCalls = 0,
      comments = 0;
    const reader: Reader = {
      observe: async () => {
        const refs = await f.git.remoteRefs(f.origin.dir),
          baseSha = refs.get("refs/heads/main")!,
          stateSha = refs.get(cfg.stateRef) ?? null;
        const candidates: Candidate[] = [];
        for (const [ref, sha] of refs)
          if (ref.startsWith("refs/heads/queue/")) {
            const manifest = await f.git.inspect(sha);
            candidates.push({
              manifest,
              branch: ref.slice(11),
              runs: histories.get(manifest.batchId) ?? [],
              containedInBase: await f.git.ancestor(sha, baseSha),
            });
          }
        return {
          ...observation(ready, candidates),
          baseSha,
          baseCI: { ...observation().baseCI!, sha: baseSha },
          stateSha,
          ledger: stateSha ? await f.git.readLedger(stateSha) : emptyLedger(),
        };
      },
    };
    const executor = new FencedGitExecutor(
      new AtomicGitWriter(f.git, f.origin.dir, cfg.stateRef, "refs/heads/main"),
      {
        capabilities,
        fenced: async (t, commit) => {
          if (t.bindings.some((p) => !ready.some((x) => bindingKey(x) === bindingKey(p))))
            throw new Error("Changed ready state");
          await commit();
          if (t.effect.kind === "publish") {
            const c: Candidate = {
              manifest: t.effect.manifest,
              branch: t.effect.branch,
              containedInBase: false,
              runs: [],
            };
            histories.set(c.manifest.batchId, [
              {
                ...run(
                  c,
                  c.manifest.pulls.some((p) => p.number === 2) ? "code_failure" : "success",
                ),
                id: sequence++,
              },
            ]);
          }
          if (t.effect.kind === "retry") {
            const previous = [...histories.values()].find((list) =>
              list.some((r) => r.id === (t.effect as { run: Run }).run.id),
            )!;
            const latest = previous[previous.length - 1]!;
            previous.push({ ...latest, attempt: latest.attempt + 1 });
            latest.outcome = "unknown";
            latest.trusted = false; // Previous artifact replaced.
            retryCalls++;
          }
          if (t.effect.kind === "announce") {
            expect(t.effect.body).toContain(f.second);
            comments++;
          }
        },
      },
    );
    let last = "";
    for (let tick = 0; tick < 24; tick++) {
      // No local controller memory survives this construction.
      const controller = new Controller(
        { ...cfg, mode: "active", outputDir: join(f.root, "stage") },
        reader,
        f.git,
        "A",
        executor,
      );
      const result = await controller.step();
      last = result.action.kind;
      if (last === "wait") break;
    }
    expect(last).toBe("wait");
    expect(retryCalls).toBe(0);
    expect(comments).toBe(0);
    const final = await reader.observe();
    expect(final.ledger.ejected).toEqual([]);
    expect(final.ledger.recovery).toEqual([]);
    expect(final.ledger.landed).toEqual([]);
    expect(final.baseSha).toBe(f.base);
    expect(final.candidates).toHaveLength(1);
    await expect(f.git.exec(["show", `${final.baseSha}:one.txt`])).rejects.toThrow();
    await expect(f.git.exec(["show", `${final.baseSha}:two.txt`])).rejects.toThrow();
  });
});

describe("wire adapters and CLI", () => {
  test.each([0, 1, 70, 75, 124, 126, 127, 130, 137, 143, -1])(
    "task exit classification %s is independently reverified",
    (code) => {
      const c = candidate(),
        data = receiptResult(c),
        classification = classifyExit(code);
      Object.assign(data.tasks[1]!, classification, { exitCode: code });
      Object.assign(data, classification);
      if (classification.outcome !== "success")
        data.jobs.source = classification.outcome === "cancelled" ? "cancelled" : "failure";
      expect(verifyResult(data, c.manifest, 100, 1)?.outcome).toBe(classification.outcome);
      expect(verifyResult(data, c.manifest, 100, 1)?.retryable).toBe(classification.retryable);
    },
  );
  test.each(["head", "batch", "attempt", "run", "exit", "duplicate", "missing-plan"])(
    "malformed task cannot create partial green: %s",
    (kind) => {
      const c = candidate(),
        data = receiptResult(c);
      if (kind === "head") data.tasks[0]!.headSha = SHA;
      if (kind === "batch") data.tasks[0]!.batchId = digest("other");
      if (kind === "attempt") data.tasks[0]!.runAttempt = 2;
      if (kind === "run") data.tasks[0]!.runId = "2";
      if (kind === "exit") data.tasks[0]!.exitCode = 1;
      if (kind === "duplicate") data.tasks.push(data.tasks[0]!);
      if (kind === "missing-plan") data.tasks.shift();
      expect(verifyResult(data, c.manifest, 100, 1)).toBeNull();
    },
  );
  test("verified red survives missing siblings, but task/provider cancellation wins", () => {
    const c = candidate(),
      data = receiptResult(c);
    Object.assign(data.tasks[1]!, { exitCode: 1, outcome: "code_failure", retryable: true });
    data.tasks.shift();
    Object.assign(data, { outcome: "code_failure", retryable: true });
    expect(verifyResult(data, c.manifest, 100, 1)?.outcome).toBe("code_failure");
    data.jobs.plan = "cancelled";
    Object.assign(data, { outcome: "cancelled", retryable: false });
    expect(verifyResult(data, c.manifest, 100, 1)?.outcome).toBe("cancelled");
  });
  test("partial or malformed infrastructure receipts never authorize an infra-only retry", () => {
    const c = candidate(),
      data = receiptResult(c);
    Object.assign(data.tasks[1]!, { exitCode: 75, outcome: "infrastructure", retryable: false });
    data.outcome = "infrastructure";
    data.jobs.source = "failure";
    expect(verifyResult(data, c.manifest, 100, 1)?.infrastructureOnly).toBe(true);
    data.tasks.shift();
    expect(verifyResult(data, c.manifest, 100, 1)?.infrastructureOnly).toBeUndefined();
    data.tasks.push({ ...data.tasks[0]!, job: "plan", exitCode: 1, outcome: "success" });
    expect(verifyResult(data, c.manifest, 100, 1)?.infrastructureOnly).toBeUndefined();
  });
  test("process-leak code-red is never retried away", () => {
    const c = candidate();
    c.runs = [{ ...run(c, "code_failure"), retryable: false }];
    const action = plan(observation([pull(1)], [c]), cfg);
    expect(action.kind).toBe("wait");
    if (action.kind === "wait") expect(action.reason).toContain("without retry");
  });
  test("numeric runId and untrusted task outcome are refused", () => {
    const c = candidate(),
      data = receiptResult(c);
    expect(verifyResult({ ...data, runId: 100 }, c.manifest, 100, 1)).toBeNull();
    data.tasks[1]!.outcome = "code_failure";
    data.outcome = "code_failure";
    expect(verifyResult(data, c.manifest, 100, 1)).toBeNull();
  });
  test("raw mutation adapter refuses shadow; active permission denial is explicit", async () => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      return new Response("private diagnostic", { status: 403 });
    }) as unknown as typeof fetch;
    const shadow = new GitHubMutations(
      new GitHubReader(cfg, new GitHubAuth({ GH_TOKEN: "token" }), transport),
    );
    await expect(shadow.announce(1, "fixture")).rejects.toThrow("Shadow mode");
    expect(calls).toBe(0);
    const active = new GitHubMutations(
      new GitHubReader(
        { ...cfg, mode: "active" },
        new GitHubAuth({ GH_TOKEN: "token" }),
        transport,
      ),
    );
    await expect(active.retry(run(candidate(), "infrastructure"))).rejects.toThrow(
      "GitHub mutation failed (403)",
    );
    expect(calls).toBe(1);
  });
  function zipResult(data: unknown, member = "batch-result.json"): Uint8Array<ArrayBuffer> {
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
  test.each([
    "green",
    "red",
    "missing",
    "entry",
    "cancelled",
    "running",
    "other-workflow",
    "wrong-sha",
    "wrong-attempt",
    "wrong-url",
    "not-full",
    "stale-artifact",
    "prior-and-current",
    "duplicate",
    "rerun",
  ])("exact-base full CI gate: %s", async (kind) => {
    const sha = SHA,
      id = 51;
    let listings = 0;
    const row = {
      id,
      run_attempt: 2,
      head_sha: sha,
      head_branch: cfg.baseBranch,
      path:
        kind === "other-workflow" ? ".github/workflows/agent-ci.yml" : ".github/workflows/ci.yml",
      event: "push",
      status: kind === "running" ? "in_progress" : "completed",
      conclusion: kind === "red" ? "failure" : kind === "cancelled" ? "cancelled" : "success",
      run_started_at: NOW,
    };
    const receipt = {
      schemaVersion: 1,
      mode: kind === "not-full" ? "entry" : "full",
      sha: kind === "wrong-sha" ? "b".repeat(40) : sha,
      runId: String(id),
      runAttempt: kind === "wrong-attempt" ? "1" : "2",
      url:
        kind === "wrong-url"
          ? "https://example.test/"
          : `https://github.com/${cfg.repository}/actions/runs/${id}/attempts/2`,
    };
    const artifact = {
      id: 99,
      name: `full-green-main-${sha}`,
      expired: false,
      size_in_bytes: 500,
      created_at: kind === "stale-artifact" ? "2026-10-20T00:00:00Z" : NOW,
      workflow_run: { id, head_sha: sha },
    };
    const transport = (async (url: string) => {
      if (url.includes("/workflows/ci.yml/runs")) {
        listings++;
        return Response.json({
          workflow_runs:
            kind === "missing"
              ? []
              : [
                  {
                    ...row,
                    ...(kind === "rerun" && listings > 1
                      ? { run_attempt: 3, status: "queued" }
                      : {}),
                  },
                ],
        });
      }
      if (url.endsWith("/attempts/2")) return Response.json(row);
      if (url.endsWith("/artifacts?per_page=100&page=1"))
        return Response.json({
          artifacts:
            kind === "entry"
              ? []
              : kind === "duplicate"
                ? [artifact, artifact]
                : kind === "prior-and-current"
                  ? [{ ...artifact, id: 98, created_at: "2026-10-20T00:00:00Z" }, artifact]
                  : [artifact],
        });
      if (url.endsWith("/zip")) return new Response(zipResult(receipt, "full-green-main.json"));
      throw new Error(`Unexpected fixture path ${url}`);
    }) as unknown as typeof fetch;
    const reader = new GitHubReader(cfg, new GitHubAuth({ GH_TOKEN: "fixture" }), transport);
    const result = await reader.baseCI(sha);
    expect(result.status).toBe(
      ["green", "prior-and-current"].includes(kind) ? "green" : kind === "red" ? "red" : "unknown",
    );
    expect(result.sha).toBe(sha);
  });
  test.each([
    "success",
    "head",
    "batch",
    "attempt",
    "run",
    "schema",
    "duplicate",
    "malformed",
    "expired",
    "generic",
  ])("exact result artifact binding: %s", async (kind) => {
    const c = candidate();
    const data = receiptResult(c, 2);
    if (kind === "head") data.headSha = SHA;
    if (kind === "batch") data.batchId = digest("wrong");
    if (kind === "attempt") data.runAttempt = 1;
    if (kind === "run") data.runId = "99";
    if (kind === "schema") data.schemaVersion = 2;
    const archive = kind === "malformed" ? new Uint8Array([1, 2]) : zipResult(data);
    const methods: string[] = [];
    const transport = (async (url: string | URL, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      if (String(url).endsWith("/zip")) return new Response(archive);
      const artifact = {
        id: 500,
        name: kind === "generic" ? "batch-result" : "batch-result-2",
        expired: kind === "expired",
        size_in_bytes: archive.length,
        workflow_run: { id: 100, head_sha: c.manifest.tipSha },
      };
      return Response.json({ artifacts: kind === "duplicate" ? [artifact, artifact] : [artifact] });
    }) as unknown as typeof fetch;
    const reader = new GitHubReader(cfg, new GitHubAuth({ GH_TOKEN: "never-log" }), transport);
    expect(await reader.resultArtifact(c.manifest, 100, 2)).toEqual(
      kind === "success" ? { outcome: "success", retryable: false, reason: "fixture" } : null,
    );
    expect(methods.every((m) => m === "GET")).toBe(true);
  });
  test("artifact download redirects do not forward authorization", async () => {
    const c = candidate();
    let leaked = false;
    const transport = (async (url: string | URL, init: RequestInit) => {
      if (String(url).startsWith("https://storage.example/")) {
        leaked = new Headers(init.headers).has("Authorization");
        return new Response(zipResult(receiptResult(c)));
      }
      if (String(url).endsWith("/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://storage.example/artifact" },
        });
      return Response.json({
        artifacts: [
          {
            id: 500,
            name: "batch-result-1",
            expired: false,
            size_in_bytes: 100,
            workflow_run: { id: 100, head_sha: c.manifest.tipSha },
          },
        ],
      });
    }) as unknown as typeof fetch;
    expect(
      await new GitHubReader(
        cfg,
        new GitHubAuth({ GH_TOKEN: "private" }),
        transport,
      ).resultArtifact(c.manifest, 100, 1),
    ).toEqual({ outcome: "success", retryable: false, reason: "fixture" });
    expect(leaked).toBe(false);
  });
  test("workflow identity and run conclusion, not check name, bind success", async () => {
    const c = candidate();
    let conclusion = "failure";
    let path = cfg.workflow;
    const transport = (async (url: string) => {
      if (url.includes("/artifacts"))
        return Response.json({ artifacts: [{ name: "batch-result-1" }] });
      return Response.json({
        workflow_runs: [
          {
            id: 100,
            run_attempt: 1,
            head_sha: c.manifest.tipSha,
            head_branch: c.branch,
            path,
            event: "push",
            status: "completed",
            conclusion,
            updated_at: NOW,
          },
        ],
      });
    }) as unknown as typeof fetch;
    class ReaderWithArtifact extends GitHubReader {
      override async resultArtifact() {
        return { outcome: "success" as const, retryable: false, reason: "fixture" };
      }
    }
    const { root } = await fixture();
    const reader = new ReaderWithArtifact(
      { ...cfg, outputDir: join(root, "cache") },
      new GitHubAuth({}),
      transport,
    );
    expect((await reader.runs(c.manifest, c.branch))[0]!.trusted).toBe(false);
    conclusion = "success";
    expect((await reader.runs(c.manifest, c.branch))[0]!.trusted).toBe(true);
    conclusion = "cancelled";
    expect((await reader.runs(c.manifest, c.branch))[0]!.outcome).toBe("cancelled");
    expect((await reader.runs(c.manifest, c.branch))[0]!.trusted).toBe(false);
    path = ".github/workflows/attacker.yml";
    expect(await reader.runs(c.manifest, c.branch)).toEqual([]);
  });
  test("configuration defaults to shadow and rejects ambiguous active modes", () => {
    expect(cfg.mode).toBe("shadow");
    expect(cfg.maxBatchSize).toBe(16);
    expect(cfg.maxInflight).toBe(1);
    expect(cfg.speculationDepth).toBe(2);
    expect(() => config({ BATCHER_MODE: "Active" })).toThrow();
    expect(() => config({ BATCHER_MAX_BATCH_SIZE: "0" })).toThrow();
  });
  test("GET errors suppress tokens and response bodies", async () => {
    const transport = (async () =>
      new Response("sensitive response", { status: 403 })) as unknown as typeof fetch;
    const reader = new GitHubReader(cfg, new GitHubAuth({ GH_TOKEN: "secret-token" }), transport);
    await expect(reader.get("pulls")).rejects.toThrow("GitHub read failed (403)");
  });
  test("read adapter follows all pages and never makes a mutation", async () => {
    const methods: string[] = [];
    const transport = (async (url: string, init: RequestInit) => {
      methods.push(init.method ?? "GET");
      return Response.json(
        url.includes("page=2") ? [] : Array.from({ length: 100 }, (_, id) => ({ id })),
      );
    }) as unknown as typeof fetch;
    const reader = new GitHubReader(cfg, new GitHubAuth({ GH_TOKEN: "token" }), transport);
    expect(await reader.pages("pulls")).toHaveLength(100);
    expect(methods).toEqual(["GET", "GET"]);
  });
  test("malformed ZIP cannot fabricate a code failure", () => {
    expect(() => readResultZip(new Uint8Array([1, 2]))).toThrow();
    expect(() => readResultZip(new Uint8Array(1_000_001))).toThrow();
  });
  test("inspect CLI returns parent interface JSON and rejects invalid SHA", async () => {
    const f = await fixture(),
      m = await f.git.build(spec([pull(1, f.first)], f.base));
    const cli = Bun.spawn(
      [
        "bun",
        "scripts/merge-batcher/main.ts",
        "inspect",
        "--tip",
        m.tipSha,
        "--git-dir",
        f.git.dir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const result = JSON.parse(await new Response(cli.stdout).text());
    expect(await cli.exited).toBe(0);
    expect(result).toEqual(m);
    expect(result.pulls[0].mergeSha).toBe(m.tipSha);
  });
  test("SIGTERM interrupts idle poll, closes health server, exits without cancellation calls", async () => {
    const script = `import {runService} from './scripts/merge-batcher/main'; import {config} from './scripts/merge-batcher/model'; await runService({...config({}),port:0,pollSeconds:3600},{step:async()=>({mode:'shadow',action:{kind:'wait',reason:'fixture'},manifest:null,reason:null})},false);`;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    reader.releaseLock();
  });
  test("canonical JSON is stable across object insertion order", () => {
    expect(canonical({ z: 1, a: 2 })).toBe(canonical({ a: 2, z: 1 }));
  });
});

describe("integration boundaries and queue-only shadow CI", () => {
  test.each(["red", "unknown"] as const)(
    "%s full-main status cannot block build or authorize untrusted landing",
    (status) => {
      const o = observation();
      o.baseCI!.status = status;
      o.ledger.baseHold = { ...o.baseCI! };
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("build");
      delete o.baseCI;
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("build");
      const c = candidate();
      o.candidates = [c];
      for (const untrusted of [
        run(c, "success", 1, false),
        { ...run(c, "success"), status: "in_progress" as const },
        { ...run(c, "success"), workflow: ".github/workflows/ci.yml" },
      ]) {
        c.runs = [untrusted];
        expect(plan(o, { ...cfg, mode: "active" }).kind).not.toBe("land");
      }
      c.runs = [run(c, "success")];
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("land");
      o.mainBusy = true;
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("wait");
    },
  );
  test("old recovery groups and unannounced code blame cannot use full-main green as a proxy", () => {
    const o = observation();
    o.ledger.recovery.push({ batchId: digest("legacy"), pulls: o.ready });
    expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("wait");
    o.ledger.recovery = [];
    o.ledger.ejected.push({
      pull: o.ready[0]!,
      batchId: digest("legacy"),
      reason: "non-retryable exact-candidate code failure",
      announced: false,
    });
    expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("wait");
  });
  test.each(["red", "unknown", "green"] as const)(
    "#5243 inherited %s base never bisects or ejects multiple innocent members",
    (status) => {
      const c = candidate([pull(5436), pull(5439), pull(5440)]);
      c.runs = [run(c, "code_failure")];
      const o = observation(c.manifest.pulls, [c]);
      o.baseCI!.status = status;
      const action = plan(o, { ...cfg, mode: "active" });
      expect(action.kind).toBe("wait");
      expect(o.ledger.ejected).toEqual([]);
      expect(o.ledger.recovery).toEqual([]);
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("wait");
      c.runs = [run(c, "success")];
      expect(plan(o, { ...cfg, mode: "active" }).kind).toBe("land");
    },
  );
  test("infra retry eligibility rejects code, ambiguous, second-attempt, Version and unrelated runs", () => {
    const c = candidate();
    const good = run(c, "infrastructure");
    expect(infrastructureRetryReason(c, good, cfg)).toBe("verified-infrastructure");
    for (const bad of [
      run(c, "code_failure"),
      run(c, "unknown"),
      run(c, "infrastructure", 2),
      { ...good, status: "in_progress" as const },
      { ...good, workflow: ".github/workflows/ci.yml" },
      { ...good, workflow: ".github/workflows/release-candidate.yml" },
      { ...good, branch: "main" },
      { ...good, headSha: "b".repeat(40) },
      { ...good, trusted: false },
    ])
      expect(infrastructureRetryReason(c, bad, cfg)).toBeNull();
    const absent = { ...good };
    delete absent.infrastructureRetryReason;
    expect(infrastructureRetryReason(c, absent, cfg)).toBeNull();
    const version = candidate([{ ...pull(1), headRef: "changeset-release/main" }]);
    expect(infrastructureRetryReason(version, run(version, "infrastructure"), cfg)).toBeNull();
  });
  test("mutation boundary refuses code/main/running/repeated retries without any POST", async () => {
    let posts = 0;
    const transport = (async () => {
      posts++;
      return Response.json({});
    }) as unknown as typeof fetch;
    const reader = new GitHubReader(
      { ...cfg, mode: "active" },
      new GitHubAuth({ GH_TOKEN: "fixture" }),
      transport,
    );
    const writer = new GitHubMutations(reader);
    const c = candidate();
    for (const bad of [
      run(c, "code_failure"),
      run(c, "infrastructure", 2),
      { ...run(c, "infrastructure"), branch: "main" },
      { ...run(c, "infrastructure"), status: "in_progress" as const },
    ]) {
      await expect(writer.retry(bad)).rejects.toThrow("Only a first-attempt");
    }
    expect(posts).toBe(0);
  });
  test.each([
    ["cancelled", [], [], "provider-cancelled"],
    ["failure", [], [], "no-job-logs"],
    ["cancelled", [], [{ status: "completed", conclusion: "failure" }], null],
    ["cancelled", [], [{ status: "in_progress", conclusion: null }], null],
    [
      "failure",
      [],
      [{ status: "completed", conclusion: "success", started_at: NOW, steps: [] }],
      null,
    ],
    ["failure", [{ name: "batch-result-1" }], [], null],
    ["cancelled", [{ name: "batch-result-1" }], [], null],
  ] as const)(
    "provider infra classification %s case %# is positive evidence only",
    async (conclusion, artifacts, jobs, reason) => {
      const c = candidate();
      const { root } = await fixture();
      const transport = (async (url: string) => {
        if (url.includes("/artifacts")) return Response.json({ artifacts });
        if (url.includes("/jobs")) return Response.json({ jobs });
        return Response.json({
          workflow_runs: [
            {
              id: 100,
              run_attempt: 1,
              head_sha: c.manifest.tipSha,
              head_branch: c.branch,
              path: cfg.workflow,
              event: "push",
              status: "completed",
              conclusion,
              updated_at: NOW,
            },
          ],
        });
      }) as unknown as typeof fetch;
      class MissingReceiptReader extends GitHubReader {
        override async resultArtifact() {
          return null;
        }
      }
      const reader = new MissingReceiptReader(
        { ...cfg, outputDir: join(root, "policy-cache") },
        new GitHubAuth({}),
        transport,
      );
      await reader.cache.set(`verified:${c.manifest.tipSha}:${c.manifest.batchId}:100:1`, {
        run: run(c, "infrastructure"),
        conclusion,
      }); // Legacy negative caches cannot authorize retries without fresh classification.
      const observed = (await reader.runs(c.manifest, c.branch))[0]!;
      expect(observed.infrastructureRetryReason ?? null).toBe(reason);
      expect(observed.trusted).toBe(false);
      expect(observed.outcome).not.toBe("code_failure");
    },
  );
  test("Version commit carries the literal main-CI isolation marker", async () => {
    const f = await fixture();
    const p = { ...pull(1, f.first), headRef: "changeset-release/main" };
    const m = await f.git.build(spec([p], f.base));
    expect(await f.git.exec(["show", "-s", "--format=%s", m.tipSha])).toContain(
      "changeset-release/main",
    );
    expect(await f.git.inspect(m.tipSha)).toEqual(m);
  });
  test("control-plane changes are singleton barriers and require explicit review prose", () => {
    const p = { ...pull(2), controlPlane: true };
    expect(bindingKey(p)).not.toBe(bindingKey(pull(2)));
    expect(fifo([pull(1), p, pull(3)], 16).map((x) => x.number)).toEqual([1]);
    expect(fifo([p, pull(3)], 16)).toEqual([p]);
    const input: PullInput = {
      number: 2,
      headSha: p.headSha,
      headRef: p.headRef,
      controlPlane: true,
      draft: false,
      autoMerge: false,
      queueReady: true,
      events: [{ id: "ready", at: NOW, source: "queue-ready", enabled: true }],
      comments: [
        {
          id: "evidence",
          updatedAt: NOW,
          authorAssociation: "MEMBER",
          body: `Head ${p.headSha}. VM tests passed. Independent review passed, reviewer session 12345678-1234-1234-1234-123456789abc.`,
        },
      ],
    };
    expect(admit(input).reason).toContain("control-plane");
    input.comments[0]!.body += " Control-plane changes explicitly reviewed.";
    expect(admit(input).ready?.controlPlane).toBe(true);
  });
  test("atomic push grants force semantics only to state, never main", async () => {
    const f = await fixture();
    let command: string[] = [];
    class RecordingGit extends GitStore {
      override async exec(args: string[], input?: string, env?: Record<string, string>) {
        if (args[0] === "push") command = args;
        return super.exec(args, input, env);
      }
    }
    const git = new RecordingGit(f.git.dir),
      m = await git.build(spec([pull(1, f.first)], f.base));
    const next = await git.stateCommit({ ...emptyLedger(), epoch: 1 }, null, NOW);
    await new AtomicGitWriter(git, f.origin.dir, cfg.stateRef, "refs/heads/main").transaction([
      { ref: cfg.stateRef, expected: null, next },
      { ref: "refs/heads/main", expected: f.base, next: m.tipSha },
    ]);
    expect(command.filter((x) => x.startsWith("--force-with-lease"))).toEqual([
      `--force-with-lease=${cfg.stateRef}:`,
    ]);
    expect(command.some((x) => x.startsWith("+") || x === "--force")).toBe(false);
  });
  test("shadow-ci needs separately authorized non-CI state ref and cannot use main or queue", () => {
    expect(() => config({ BATCHER_MODE: "shadow-ci" })).toThrow("explicit");
    for (const ref of ["refs/heads/main", "refs/heads/queue/lease"])
      expect(() =>
        config({ BATCHER_MODE: "shadow-ci", BATCHER_SHADOW_CI_STATE_REF: ref }),
      ).toThrow();
    expect(
      config({
        BATCHER_MODE: "shadow-ci",
        BATCHER_SHADOW_CI_STATE_REF: "refs/heads/batcher-shadow-ci-state",
      }).mode,
    ).toBe("shadow-ci");
  });
  test("two shadow-ci controllers atomically publish at most one candidate, never main/PR effects", async () => {
    const f = await fixture();
    const settings = config({
      BATCHER_MODE: "shadow-ci",
      BATCHER_SHADOW_CI_STATE_REF: "refs/heads/batcher-shadow-ci-state",
      BATCHER_OUTPUT_DIR: join(f.root, "stage"),
    });
    const snapshot = { ...observation([pull(1, f.first)]), baseSha: f.base };
    const publisher = new QueueOnlyPublisher(
      settings,
      new AtomicGitWriter(f.git, f.origin.dir, settings.stateRef, "refs/heads/main"),
    );
    const results = await Promise.allSettled(
      ["A", "B"].map((owner) =>
        new ShadowCiController(
          settings,
          { observe: async () => snapshot },
          f.git,
          publisher,
          owner,
        ).step(),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const refs = await f.git.remoteRefs(f.origin.dir);
    expect(refs.get("refs/heads/main")).toBe(f.base);
    const queues = [...refs].filter(([ref]) => ref.startsWith("refs/heads/queue/"));
    expect(queues).toHaveLength(1);
    const m = await f.git.inspect(queues[0]![1]);
    const pending: Candidate = {
      manifest: m,
      branch: queues[0]![0].slice(11),
      runs: [],
      containedInBase: false,
    };
    let writes = 0;
    const second = new ShadowCiController(
      settings,
      { observe: async () => ({ ...snapshot, candidates: [pending], ready: [pull(2, f.second)] }) },
      f.git,
      {
        publish: async () => {
          writes++;
        },
      },
      "C",
    );
    expect((await second.step()).reason).toContain("occupied");
    expect(writes).toBe(0);
    const mutations = new GitHubMutations(
      new GitHubReader(settings, new GitHubAuth({}), (async () => {
        throw new Error("unexpected HTTP");
      }) as unknown as typeof fetch),
    );
    await expect(mutations.announce(1, "forbidden")).rejects.toThrow("Shadow mode");
  });
  test("completed shadow candidate is compared with exact main baseline and never rerun/landed", async () => {
    const f = await fixture();
    const p = pull(1, f.first);
    const s = { ...spec([p], f.base), createdAt: p.binding.at };
    const m = await f.git.build(s);
    const c: Candidate = {
      manifest: m,
      branch: `queue/${m.batchId}`,
      runs: [],
      containedInBase: false,
    };
    c.runs = [{ ...run(c, "success"), startedAt: NOW, completedAt: "2026-10-21T11:00:20Z" }];
    const settings = config({
      BATCHER_MODE: "shadow-ci",
      BATCHER_SHADOW_CI_STATE_REF: "refs/heads/batcher-shadow-ci-state",
      BATCHER_OUTPUT_DIR: join(f.root, "stage"),
    });
    let writes = 0;
    const controller = new ShadowCiController(
      settings,
      { observe: async () => ({ ...observation([p], [c]), baseSha: f.base }) },
      f.git,
      {
        publish: async () => {
          writes++;
        },
      },
      "A",
      {
        mainOutcomes: async (headSha) => [
          {
            headSha,
            runId: 11,
            runAttempt: 1,
            conclusion: "success",
            startedAt: NOW,
            completedAt: "2026-10-21T11:00:30Z",
          },
        ],
      },
    );
    expect((await controller.step()).reason).toContain("already observed");
    expect(writes).toBe(0);
    const stage = JSON.parse(await readFile(join(f.root, "stage/stage.json"), "utf8"));
    expect(stage.comparisons[0].candidateSeconds).toBe(20);
    expect(stage.comparisons[0].mainRuns[0].headSha).toBe(f.base);
  });
});

describe("review regressions: observation, admission and telemetry", () => {
  test("same-owner same-clock transactions have distinct state OIDs and exactly one CAS winner", async () => {
    const f = await fixture();
    const manifest = await f.git.build(spec([pull(1, f.first)], f.base));
    const ledger = {
      ...emptyLedger(),
      owner: "same-process-owner",
      epoch: 1,
      expiresAt: "2026-10-21T13:00:00Z",
    };
    const first = await f.git.stateCommit(ledger, null, NOW);
    const second = await f.git.stateCommit(ledger, null, NOW);
    expect(first).not.toBe(second);
    expect(await f.git.readLedger(first)).toEqual(await f.git.readLedger(second));
    const exec = f.git.exec.bind(f.git);
    let arrived = 0,
      releaseBoth: () => void = () => {},
      releaseFirst: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const firstPushed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    f.git.exec = async (args, input, extraEnv) => {
      if (args[0] !== "push") return exec(args, input, extraEnv);
      if (++arrived === 1) {
        await bothRead;
        try {
          return await exec(args, input, extraEnv);
        } finally {
          releaseFirst();
        }
      }
      releaseBoth();
      await firstPushed;
      return exec(args, input, extraEnv);
    };
    const writer = new AtomicGitWriter(
      f.git,
      f.origin.dir,
      "refs/heads/batcher-state",
      "refs/heads/main",
    );
    const publish = (next: string) =>
      writer.transaction([
        { ref: "refs/heads/batcher-state", expected: null, next },
        { ref: `refs/heads/queue/${manifest.batchId}`, expected: null, next: manifest.tipSha },
      ]);
    const outcomes = await Promise.allSettled([publish(first), publish(second)]);
    expect(arrived).toBe(2); // Both pre-push rereads saw the same empty refs.
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await f.origin.exec(["rev-parse", "refs/heads/batcher-state"])).toBe(
      outcomes[0]!.status === "fulfilled" ? first : second,
    );
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
  });
  test("batcher bookkeeping receipt does not revoke the human evidence it is reconciling", () => {
    const input: PullInput = {
      number: 1,
      headSha: SHA,
      headRef: "feature",
      draft: false,
      autoMerge: false,
      queueReady: true,
      events: [{ id: "ready", at: NOW, source: "queue-ready", enabled: true }],
      comments: [
        {
          id: "human",
          updatedAt: NOW,
          authorAssociation: "MEMBER",
          body: `Head ${SHA}. VM tests passed. Independent review passed, reviewer session 12345678-1234-1234-1234-123456789abc.`,
        },
        {
          id: "receipt",
          updatedAt: "2026-10-21T11:01:00Z",
          authorAssociation: "MEMBER",
          body: `Tested snapshot ${"b".repeat(40)} landed. Newer source head ${SHA} is not covered by that test result. <!-- batcher-effect:${"c".repeat(64)} -->`,
        },
      ],
    };
    expect(admit(input).ready?.binding.evidenceId).toBe("human");
    input.comments[1]!.body = `Head ${SHA}. VM tests failed.`;
    expect(admit(input).ready).toBeNull();
  });
  test.each(["Tests failed", "VM tests pending", "Independent review pending"])(
    "newest collaborator exact-head %s revokes earlier pass",
    (text) => {
      const input: PullInput = {
        number: 1,
        headSha: SHA,
        headRef: "feature",
        draft: false,
        autoMerge: false,
        queueReady: true,
        events: [{ id: "ready", at: NOW, source: "queue-ready", enabled: true }],
        comments: [
          {
            id: "old",
            updatedAt: NOW,
            authorAssociation: "MEMBER",
            body: `Head ${SHA}. VM tests passed. Independent review passed, reviewer session 12345678-1234-1234-1234-123456789abc.`,
          },
          {
            id: "new",
            updatedAt: "2026-10-21T11:01:00Z",
            authorAssociation: "COLLABORATOR",
            body: `Head ${SHA}: ${text}`,
          },
        ],
      };
      expect(admit(input).ready).toBeNull();
      expect(admit(input).reason).toContain("revoked");
      input.comments.reverse();
      expect(admit(input).ready).toBeNull();
      input.comments[0]!.authorAssociation = "NONE";
      expect(admit(input).ready).not.toBeNull();
    },
  );
  test.each([
    "scripts/ci/impact.ts",
    "scripts/ci/run-unit-shard.ts",
    "scripts/ci/profile-command.ts",
    "scripts/ci/shared-pg.ts",
    "packages/testing/src/shared-pg.ts",
    ".bun-version",
  ])("CI dependency %s is control-plane", (path) => {
    expect(isControlPlanePath(path)).toBe(true);
    expect(isControlPlanePath("apps/web/view.ts")).toBe(false);
  });
  test.each(["shadow", "shadow-ci"] as const)(
    "%s excludes conflict and rebuilds remainder across restart without PR mutation",
    async (mode) => {
      const f = await fixture();
      const bad = await f.commitFiles(
        f.origin,
        { "base.txt": "base\n", "one.txt": "incompatible\n" },
        [f.base],
      );
      await f.origin.exec(["update-ref", "refs/heads/bad", bad]);
      await f.git.fetch(f.origin.dir, [bad]);
      const settings = config({
        BATCHER_MODE: mode,
        BATCHER_SHADOW_CI_STATE_REF: "refs/heads/batcher-shadow-ci-state",
        BATCHER_OUTPUT_DIR: join(f.root, "review"),
      });
      const o = {
        ...observation([pull(1, f.first), pull(2, bad), pull(3, f.second)]),
        baseSha: f.base,
      };
      let writes = 0;
      const publisher = {
        publish: async (_expected: string | null, _next: string, manifest: Manifest) => {
          writes++;
          o.candidates.push({
            manifest,
            branch: `queue/${manifest.batchId}`,
            containedInBase: false,
            runs: [],
          });
        },
      };
      const make = () =>
        mode === "shadow"
          ? new Controller(settings, { observe: async () => structuredClone(o) }, f.git, "review")
          : new ShadowCiController(
              settings,
              { observe: async () => structuredClone(o) },
              f.git,
              publisher,
              "review",
            );
      const result = await make().step();
      expect(result.manifest?.pulls.map((p) => p.number)).toEqual([1, 3]);
      const restarted = await make().step();
      if (mode === "shadow") expect(restarted.manifest?.pulls.map((p) => p.number)).toEqual([1, 3]);
      else expect(restarted.action.kind).toBe("wait");
      expect(writes).toBe(mode === "shadow" ? 0 : 1);
      const journal = new ObservationJournal(settings);
      expect((await journal.observe(structuredClone(o))).ready.map((p) => p.number)).toEqual([
        1, 3,
      ]);
      o.ready[1]!.binding.eventId = "re-ready";
      expect((await journal.observe(structuredClone(o))).ready.map((p) => p.number)).toEqual([
        1, 2, 3,
      ]);
    },
  );
  test("malformed refs and valid foreign traffic namespace coexist; owned manifest is cached", async () => {
    const f = await fixture(),
      manifest = await f.git.build(spec([pull(1, f.first)], f.base));
    await f.git.exec([
      "push",
      f.origin.dir,
      `${manifest.tipSha}:refs/heads/queue/${manifest.batchId}`,
      `${f.base}:refs/heads/queue/${"a".repeat(64)}`,
      `${f.base}:refs/heads/queue/diagnostic`,
      `${manifest.tipSha}:refs/heads/queue/shadow-traffic/${manifest.batchId}`,
    ]);
    const remoteRefs = f.git.remoteRefs.bind(f.git),
      fetchLocal = f.git.fetch.bind(f.git),
      inspect = f.git.inspect.bind(f.git);
    f.git.remoteRefs = () => remoteRefs(f.origin.dir);
    f.git.fetch = (_remote, refs) => fetchLocal(f.origin.dir, refs);
    let validInspections = 0;
    f.git.inspect = async (tip) => {
      if (tip === manifest.tipSha) validInspections++;
      return inspect(tip);
    };
    const settings = { ...cfg, outputDir: join(f.root, "reader") };
    class MockReader extends GitHubReader {
      override async ready() {
        return { ready: [], excluded: [] };
      }
      override async runs() {
        return [];
      }
    }
    const reader = new LiveReader(new MockReader(settings, new GitHubAuth({})), f.git, settings);
    const first = await reader.observe();
    expect(first.candidates).toHaveLength(1);
    expect(first.observationWarnings).toHaveLength(3);
    expect(first.observationWarnings).toContain(
      `Excluded unowned queue ref refs/heads/queue/shadow-traffic/${manifest.batchId}`,
    );
    await new LiveReader(new MockReader(settings, new GitHubAuth({})), f.git, settings).observe();
    expect(validInspections).toBe(1);
  });
  test("verified run attempts persist in cache while current metadata detects reruns", async () => {
    const f = await fixture(),
      c = candidate();
    let attempt = 1,
      artifactReads = 0,
      metadataReads = 0,
      completed = true;
    const settings = { ...cfg, outputDir: join(f.root, "provider") };
    const transport = (async () => {
      metadataReads++;
      return Response.json({
        workflow_runs: [
          {
            id: 100,
            run_attempt: attempt,
            head_sha: c.manifest.tipSha,
            head_branch: c.branch,
            path: cfg.workflow,
            event: "push",
            status: completed ? "completed" : "queued",
            conclusion: completed ? "success" : null,
            updated_at: NOW,
          },
        ],
      });
    }) as unknown as typeof fetch;
    class CachedReader extends GitHubReader {
      override async resultArtifact() {
        artifactReads++;
        return { outcome: "success" as const, retryable: false, reason: "fixture" };
      }
    }
    const reader = new CachedReader(settings, new GitHubAuth({}), transport);
    await reader.runs(c.manifest, c.branch);
    await reader.runs(c.manifest, c.branch);
    expect(artifactReads).toBe(1);
    expect(metadataReads).toBe(2);
    const restarted = new CachedReader(settings, new GitHubAuth({}), transport);
    attempt = 2;
    completed = false;
    expect((await restarted.runs(c.manifest, c.branch)).map((r) => r.status)).toEqual([
      "completed",
      "queued",
    ]);
    expect(artifactReads).toBe(1);
    completed = true;
    await restarted.observedRuns(c.manifest, c.branch, true);
    expect(artifactReads).toBe(2);
    const reads = metadataReads;
    await restarted.observedRuns(c.manifest, c.branch, true);
    expect(metadataReads).toBe(reads);
    attempt = 3;
    completed = false;
    expect((await restarted.runs(c.manifest, c.branch)).at(-1)?.attempt).toBe(3);
  });
  test("historical scans rotate with a persisted eight-ref budget; empty caches and late runs retain capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "merge-batcher-history-"));
    roots.push(root);
    const settings = { ...cfg, mode: "active" as const, outputDir: root };
    const historical = Array.from({ length: 50 }, (_, i) =>
      candidate([pull(i + 1, digest(i).slice(0, 40))]),
    );
    const current = candidate([pull(99, digest(99).slice(0, 40))]);
    const all = [...historical, current];
    const byTip = new Map(all.map((c) => [c.manifest.tipSha, c.manifest]));
    const ledger = emptyLedger();
    ledger.invalidated = historical.map((c) => c.manifest.batchId);
    // Released histories are still sampled for unexpectedly late runs.
    for (const c of historical.slice(0, 25))
      ledger.missingRuns[c.manifest.batchId] = {
        firstSeenAt: NOW,
        updatedAt: NOW,
        status: "released",
      };
    let lists = 0,
      late = false;
    const seen = new Set<string>();
    class FakeGit extends GitStore {
      override async remoteRefs() {
        return new Map([
          ["refs/heads/main", SHA],
          [settings.stateRef, "b".repeat(40)],
          ...all.map((c): [string, string] => [`refs/heads/${c.branch}`, c.manifest.tipSha]),
        ]);
      }
      override async fetch() {}
      override async ancestor() {
        return false;
      }
      override async readLedger() {
        return ledger;
      }
      override async inspect(sha: string) {
        return byTip.get(sha)!;
      }
    }
    class FakeReader extends GitHubReader {
      override async baseCI(sha: string) {
        return { ...observation().baseCI!, sha };
      }
      override async ready() {
        return { ready: [], excluded: [] };
      }
      override async mainBusy() {
        return false;
      }
      override async get(path: string) {
        expect(path.startsWith("actions/workflows/batch-ci.yml/runs?")).toBe(true);
        const branch = new URL(`https://example.test/${path}`).searchParams.get("branch")!;
        lists++;
        seen.add(branch);
        return {
          workflow_runs:
            late && branch === historical[0]!.branch
              ? [
                  {
                    id: 100,
                    run_attempt: 1,
                    head_sha: historical[0]!.manifest.tipSha,
                    head_branch: branch,
                    path: cfg.workflow,
                    event: "push",
                    status: "queued",
                  },
                ]
              : [],
        };
      }
    }
    const make = () =>
      new LiveReader(new FakeReader(settings, new GitHubAuth({})), new FakeGit("unused"), settings);
    for (let i = 0; i < 7; i++) {
      const before = lists;
      const o = await make().observe(); // Both reader and cache reload every time.
      expect(o.candidates).toHaveLength(51);
      expect(lists - before).toBeLessThanOrEqual(9); // Eight history refs plus current candidate.
      expect(o.observationWarnings?.some((warning) => warning.includes("sampled 8/50"))).toBe(true);
    }
    expect(seen.size).toBe(51);
    expect(lists).toBe(57); // Each history fetched once, current fetched every observation.
    const before = lists;
    await make().observe();
    expect(lists - before).toBe(1); // Empty archived results back off across restarts.

    // Expire the disposable cache without waiting or changing global Date.
    const cachePath = make().github.cache.path;
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    for (const entry of Object.values(cache.entries) as { at: number }[]) entry.at = 0;
    await writeFile(cachePath, JSON.stringify(cache));
    late = true;
    let detected = false;
    for (let i = 0; i < 7; i++) {
      const start = lists;
      const o = await make().observe();
      expect(lists - start).toBeLessThanOrEqual(9);
      if (
        o.candidates
          .find((c) => c.branch === historical[0]!.branch)
          ?.runs.some((r) => r.status === "queued")
      )
        detected = true;
    }
    expect(detected).toBe(true);
    // A deferred snapshot of a queued late run still reserves the released slot.
    const provider = make().github;
    const runs = await provider.observedRuns(
      historical[0]!.manifest,
      historical[0]!.branch,
      true,
      false,
    );
    expect(runs[0]?.status).toBe("queued");
    const o = observation([pull(98)], [{ ...historical[0]!, runs }]);
    o.ledger = ledger;
    const action = plan(o, settings);
    expect(action.kind).toBe("build");
    if (action.kind === "build") expect(action.publish).toBe(false);
  });
  test("landed unknown history ages across restart, needs explicit recovery, and late runs reserve again", async () => {
    const root = await mkdtemp(join(tmpdir(), "merge-batcher-landed-history-"));
    roots.push(root);
    const settings = { ...cfg, outputDir: root },
      old = candidate();
    old.containedInBase = true;
    const o = observation([pull(2)], [old]);
    o.ledger.landed.push(old.manifest.batchId);
    const id = old.manifest.batchId;
    await new ObservationJournal(settings).event(
      old.manifest,
      "publishedAt",
      "2026-10-20T12:00:00.000Z",
    );
    const first = await new ObservationJournal(settings).observe(o);
    expect(first.missingRuns?.[id]).toMatchObject({
      kind: "historical-run-history",
      status: "holding",
      firstSeenAt: o.now,
    });
    const pending = plan(first, settings);
    expect(pending.kind).toBe("build");
    if (pending.kind === "build") expect(pending.publish).toBe(false);
    const later = await new ObservationJournal(settings).observe({
      ...o,
      now: "2026-10-21T14:00:00.000Z",
    });
    expect(later.missingRuns?.[id]?.status).toBe("abandoned");
    const held = plan(later, settings);
    if (held.kind === "build") expect(held.publish).toBe(false);
    const journal = new ObservationJournal(settings);
    await expect(journal.recoverMissing(id, later, false)).rejects.toThrow("confirmation");
    let providerCalls = 0;
    const queued = { ...run(old, "unknown"), status: "queued" as const };
    const provider = {
      runs: async () => {
        providerCalls++;
        return [queued];
      },
    };
    // Even though the observation has no runs, recovery must bypass that cache.
    await expect(recoverLocalMissing(journal, later, provider, id)).rejects.toThrow(
      "no observed run",
    );
    expect(providerCalls).toBe(1);
    await expect(
      recoverLocalMissing(
        journal,
        later,
        {
          runs: async () => {
            throw new Error("provider unavailable");
          },
        },
        id,
      ),
    ).rejects.toThrow("provider unavailable");
    await recoverLocalMissing(journal, later, { runs: async () => [] }, id);
    const released = await new ObservationJournal(settings).observe(later);
    expect(released.missingRuns?.[id]).toMatchObject({
      status: "released",
      kind: "historical-run-history",
      recovery: {
        confirmedNoRun: true,
        at: later.now,
        controllerId: null,
        tipSha: old.manifest.tipSha,
        previousStateSha: null,
      },
    });
    const permitted = plan(released, settings);
    expect(permitted.kind).toBe("build");
    if (permitted.kind === "build") expect(permitted.publish).toBe(true);
    released.candidates[0]!.runs = [queued];
    const late = plan(released, settings);
    expect(late.kind).toBe("build");
    if (late.kind === "build") expect(late.publish).toBe(false);
  });
  test("baseline reads are cached and rate limits back off without another HTTP request", async () => {
    const f = await fixture();
    let calls = 0;
    const settings = { ...cfg, outputDir: join(f.root, "baseline") };
    const transport = (async () => {
      calls++;
      return Response.json({ workflow_runs: [] });
    }) as unknown as typeof fetch;
    await new GitHubReader(settings, new GitHubAuth({}), transport).mainOutcomes(SHA);
    await new GitHubReader(settings, new GitHubAuth({}), transport).mainOutcomes(SHA);
    expect(calls).toBe(1);
    const limited = new GitHubReader(settings, new GitHubAuth({}), (async () => {
      calls++;
      return new Response("", { status: 429, headers: { "retry-after": "600" } });
    }) as unknown as typeof fetch);
    await expect(limited.get("pulls")).rejects.toBeInstanceOf(ProviderError);
    await expect(limited.get("pulls")).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(2);
  });
  test("cold-fetch timeout is separately configurable; shadow defaults poll less often", () => {
    const settings = config({ BATCHER_FETCH_TIMEOUT_SECONDS: "900" });
    const git = new GitStore("unused", {}, settings.fetchTimeoutSeconds);
    expect(git.commandTimeoutMs(["fetch"])).toBe(900_000);
    expect(git.commandTimeoutMs(["merge-tree"])).toBe(60_000);
    expect(settings.pollSeconds).toBe(120);
    expect(config({ BATCHER_MODE: "active" }).pollSeconds).toBe(30);
  });
  test("missing run changes from bounded hold to abandoned, requires explicit release, never ejects PR", async () => {
    const f = await fixture(),
      settings = { ...cfg, outputDir: join(f.root, "missing"), missingRunSeconds: 60 };
    const c = candidate(),
      o = observation([pull(1)], [c]);
    const journal = new ObservationJournal(settings);
    expect((await journal.observe(o)).missingRuns?.[c.manifest.batchId]?.status).toBe("holding");
    o.now = "2026-10-21T12:01:01Z";
    const restarted = new ObservationJournal(settings),
      expired = await restarted.observe(o);
    expect(expired.missingRuns?.[c.manifest.batchId]?.status).toBe("abandoned");
    expect(plan(expired, settings).kind).toBe("wait");
    await expect(restarted.recoverMissing(c.manifest.batchId, expired, false)).rejects.toThrow(
      "confirmation",
    );
    await restarted.recoverMissing(c.manifest.batchId, expired, true);
    const released = await restarted.observe(o),
      action = plan(released, settings);
    expect(action.kind).toBe("record");
    if (action.kind !== "record") throw new Error("expected invalidation");
    expect(action.ledger.ejected).toEqual([]);
    released.ledger = action.ledger;
    expect(plan(released, settings).kind).toBe("wait");
    c.runs = [{ ...run(c, "unknown"), status: "in_progress" }];
    released.ready.push(pull(2));
    const next = plan(released, settings);
    expect(next.kind).toBe("build");
    if (next.kind === "build") expect(next.publish).toBe(false);
  });
  test("measured stages and rolling latency survive restart; missing history is unknown, not green", async () => {
    const f = await fixture(),
      settings = { ...cfg, outputDir: join(f.root, "telemetry") },
      c = candidate();
    c.runs = [
      {
        ...run(c, "success"),
        startedAt: "2026-10-21T11:40:00Z",
        completedAt: "2026-10-21T11:45:00Z",
      },
    ];
    const o = observation([pull(1)], [c]),
      journal = new ObservationJournal(settings);
    const measured = await journal.observe(o);
    expect(measured.telemetry?.status).toBe("stop");
    expect(measured.telemetry?.samples).toBe(1);
    expect(measured.telemetry?.completeWindow).toBe(false);
    expect(plan(measured, settings).kind).toBe("wait");
    const records = await journal.records(o.now);
    expect(records.stages[c.manifest.batchId]?.builtAt).toBeNull();
    expect(records.stages[c.manifest.batchId]?.landedAt).toBeNull();
    await journal.event(c.manifest, "builtAt", "2026-10-21T11:02:00Z");
    expect(
      (await new ObservationJournal(settings).observe({ ...o, candidates: [] })).telemetry?.status,
    ).toBe("stop");
    const lost = new ObservationJournal({ ...settings, outputDir: join(f.root, "lost") });
    expect((await lost.observe({ ...o, candidates: [] })).telemetry?.status).toBe("unknown");
    const reconstructed = await lost.observe({
      ...o,
      candidates: [],
      ledger: { ...o.ledger, ...records },
    });
    expect(reconstructed.telemetry?.status).toBe("stop");
    expect((await journal.records(o.now)).stages[c.manifest.batchId]?.builtAt).not.toBe(
      c.manifest.createdAt,
    );
    const afterGap = await new ObservationJournal(settings).observe({
      ...o,
      now: "2026-10-22T12:01:00Z",
      candidates: [],
    });
    expect(afterGap.telemetry?.completeWindow).toBe(false);
    expect(afterGap.telemetry?.status).toBe("unknown");
  });
  test("disposable cache is bounded and malformed cache reloads fresh", async () => {
    const f = await fixture(),
      path = join(f.root, "bounded.json"),
      cache = new DiskCache(path, 2);
    await cache.set("one", 1);
    await cache.set("two", 2);
    await cache.set("three", 3);
    expect(await cache.get("one")).toBeNull();
    expect(await new DiskCache(path).get("three")).toBe(3);
    await writeFile(path, "{malformed");
    expect(await new DiskCache(path).get("three")).toBeNull();
  });
  test("ready-to-CI metric counts PR readiness bindings, not duplicate reruns/bisection batches", async () => {
    const f = await fixture(),
      settings = { ...cfg, outputDir: join(f.root, "dedup") };
    const c = candidate([pull(1), pull(2)]);
    c.runs = [{ ...run(c, "success"), startedAt: "2026-10-21T11:40:00Z" }];
    const journal = new ObservationJournal(settings),
      o = observation([pull(1), pull(2)], [c]);
    await journal.observe(o);
    const records = await journal.records(o.now),
      sample = records.stages[c.manifest.batchId]!;
    records.stages.duplicate = {
      ...sample,
      batchId: "duplicate",
      ciStartedAt: "2026-10-21T11:50:00Z",
    };
    expect(latencySummary(records.stages, o.now)).toEqual({ samples: 2, p95: 2399 });
    expect(latencySummary(records.stages, "2026-10-23T12:00:00Z")).toEqual({
      samples: 0,
      p95: null,
    });
  });
});
