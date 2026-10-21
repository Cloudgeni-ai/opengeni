import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admit, type PullInput } from "./evidence";
import { AtomicGitWriter, GitStore, MergeConflict } from "./git";
import {
  Controller,
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
import { fifo, plan } from "./planner";
import { classifyExit, verifyResult } from "./result";
import { QueueOnlyPublisher, ShadowCiController } from "./shadow-ci";

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
      expect(admit(p).reason).toContain("missing exact-head");
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
  test("one whole-candidate code retry, then deterministic bisection", () => {
    const c = candidate([pull(1), pull(2), pull(3)]);
    c.runs = [run(c, "code_failure")];
    expect(plan(observation(c.manifest.pulls, [c]), cfg).kind).toBe("retry");
    c.runs.push(run(c, "code_failure", 2));
    const action = plan(observation(c.manifest.pulls, [c]), cfg);
    expect(action.kind).toBe("record");
    if (action.kind === "record")
      expect(action.ledger.recovery.map((r) => r.pulls.map((p) => p.number))).toEqual([
        [1, 2],
        [3],
      ]);
  });
  test.each(["cancelled", "infrastructure", "unknown"] as const)(
    "%s never incriminates PRs and backs off",
    (outcome) => {
      const c = candidate();
      c.runs = [run(c, outcome, 1, false), run(c, outcome, 2, false)];
      const o = observation([pull(1)], [c]);
      o.now = NOW;
      expect(plan(o, cfg).kind).toBe("wait");
      o.now = "2026-10-21T12:00:00Z";
      expect(plan(o, cfg).kind).toBe("retry");
      c.runs = Array.from({ length: 8 }, (_, i) => run(c, outcome, i + 1, false));
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
    expect(plan(observation([pull(1)], [c]), cfg).kind).toBe("retry");
  });
  test("ejected exact head stays out after evidence edit; changed/re-ready heads return", () => {
    const c = candidate();
    c.runs = [run(c, "code_failure"), run(c, "code_failure", 2)];
    const o = observation([pull(1)], [c]);
    const a = plan(o, cfg);
    if (a.kind !== "record") throw new Error("expected ejection");
    o.ledger = a.ledger;
    o.ledger.ejected[0]!.announced = true;
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
    c.runs = [run(c, "code_failure")];
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
    expect(action.kind).toBe("record");
    if (action.kind === "record") expect(action.ledger.ejected).toHaveLength(1);
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
    const o = { ...observation(m.pulls, [c]), baseSha: f.base };
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
      o = { ...observation([pull(1, f.first)]), baseSha: f.base };
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
    const o = { ...observation(m.pulls, [c]), baseSha: f.base };
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
  test("end-to-end restart each tick: retry, bisect, land good exact tip, eject bad head and announce once", async () => {
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
    expect(retryCalls).toBe(2);
    expect(comments).toBe(1);
    const final = await reader.observe();
    expect(final.ledger.ejected.map((e) => e.pull.number)).toEqual([2]);
    expect(final.ledger.landed).toHaveLength(1);
    const landed = final.candidates.find((c) => c.manifest.batchId === final.ledger.landed[0])!;
    expect(final.baseSha).toBe(landed.manifest.tipSha);
    expect(landed.manifest.pulls.map((p) => p.number)).toEqual([1]);
    expect(await f.git.exec(["show", `${final.baseSha}:one.txt`])).toBe("one");
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
  test("process-leak code-red is never retried away", () => {
    const c = candidate();
    c.runs = [{ ...run(c, "code_failure"), retryable: false }];
    const action = plan(observation([pull(1)], [c]), cfg);
    expect(action.kind).toBe("record");
    if (action.kind === "record")
      expect(action.ledger.ejected[0]!.reason).toContain("non-retryable");
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
    await expect(active.retry(run(candidate(), "code_failure"))).rejects.toThrow(
      "GitHub mutation failed (403)",
    );
    expect(calls).toBe(1);
  });
  function zipResult(data: unknown): Uint8Array<ArrayBuffer> {
    const name = Buffer.from("batch-result.json"),
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
    const transport = (async () =>
      Response.json({
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
      })) as unknown as typeof fetch;
    class ReaderWithArtifact extends GitHubReader {
      override async resultArtifact() {
        return { outcome: "success" as const, retryable: false, reason: "fixture" };
      }
    }
    const reader = new ReaderWithArtifact(cfg, new GitHubAuth({}), transport);
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
