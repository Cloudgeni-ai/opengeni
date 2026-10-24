import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubActiveExecutor } from "./active";
import { main } from "./main";
import { Controller, LiveReader } from "./controller";
import { AtomicGitWriter, GitStore, type RefUpdate } from "./git";
import { proveHeadRefresh } from "./head-refresh";
import {
  GitHubAuth,
  GitHubMutations,
  GitHubReader,
  ProviderError,
  type PullSnapshot,
} from "./github";
import {
  ACTIVE_RUN_SCAN_DEADLINE_MS,
  approvalOnlyRun,
  config,
  digest,
  emptyLedger,
  runnerJobDemand,
  scanRunnerDemand,
  type Ledger,
  type Manifest,
  type Pull,
  type Run,
  type FollowupRequest,
  type FollowupPull,
} from "./model";

const NOW = "2026-10-21T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batcher-active-"));
  roots.push(root);
  const origin = new GitStore(join(root, "origin.git"));
  await origin.init();
  class LocalGit extends GitStore {
    beforePush: (() => Promise<void>) | null = null;
    pushes: string[][] = [];
    override remoteRefs(_remote: string) {
      return super.remoteRefs(origin.dir);
    }
    override fetch(_remote: string, refs: string[]) {
      return super.fetch(origin.dir, refs);
    }
    override async exec(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
      if (args[0] === "push") {
        this.pushes.push(args);
        const hook = this.beforePush;
        this.beforePush = null;
        await hook?.();
      }
      return super.exec(args, input, extraEnv);
    }
  }
  const git = new LocalGit(join(root, "cache.git"));
  await git.init();
  const commit = async (files: Record<string, string>, parents: string[]) => {
    const entries: string[] = [];
    for (const [name, text] of Object.entries(files).sort())
      entries.push(
        `100644 blob ${await origin.exec(["hash-object", "-w", "--stdin"], text)}\t${name}`,
      );
    return origin.commit(
      await origin.exec(["mktree"], `${entries.join("\n")}\n`),
      parents,
      "fixture",
      NOW,
    );
  };
  const base = await commit({ base: "base" }, []);
  const head = await commit({ base: "base", feature: "old" }, [base]);
  const newer = await commit({ base: "base", feature: "old", delta: "new" }, [head]);
  const divergent = await commit({ base: "base", replacement: "new" }, [base]);
  for (const [ref, sha] of Object.entries({ main: base, feature: head, newer, divergent }))
    await origin.exec(["update-ref", `refs/heads/${ref}`, sha]);
  await git.fetch(origin.dir, [base, head, newer, divergent]);
  const cfg = config({
    BATCHER_MODE: "active",
    BATCHER_GIT_DIR: git.dir,
    BATCHER_OUTPUT_DIR: join(root, "stage"),
  });
  const makePull = (sha = head): Pull => ({
    number: 1,
    headSha: sha,
    headRef: "feature",
    binding: {
      eventId: `event-${sha}`,
      at: NOW,
      source: "queue-ready",
      evidenceId: `evidence-${sha}`,
      evidenceDigest: digest(sha),
    },
  });
  let clock = Date.parse(NOW);
  class MockGitHub extends GitHubReader {
    baseStatus: "green" | "red" | "unknown" = "green";
    override async baseCI(sha: string) {
      return {
        sha,
        status: this.baseStatus,
        runId: 50,
        attempt: 1,
        reason: "fixture exact-base CI",
      };
    }
    pulls = [makePull()];
    snapshot: PullSnapshot = {
      number: 1,
      headSha: head,
      branchHeadSha: head,
      headRef: "feature",
      headRepository: null,
      state: "open",
      merged: false,
    };
    workflowRuns: Run[] = [];
    comments: string[] = [];
    priorComments: string[] = [];
    override async openPullNumbers() {
      return [1, 99];
    }
    calls: string[] = [];
    busy = false;
    commentReadFails = false;
    commentReadThrottled = false;
    response: "ok" | "lost" | "unknown" | "forbidden" | "throttled" = "ok";
    onReady: (() => void) | null = null;
    onAccepted: (() => void) | null = null;
    onSnapshot: (() => void) | null = null;
    beforeCreate: (() => void) | null = null;
    followups: (FollowupPull & { sourceRepository: string; sourceRef: string; body: string })[] =
      [];
    override async ready() {
      this.onReady?.();
      return { ready: structuredClone(this.pulls), excluded: [] };
    }
    override async runs(_manifest: Manifest, branch: string) {
      return structuredClone(this.workflowRuns.filter((r) => r.branch === branch));
    }
    override async pullSnapshot(_number: number) {
      this.onSnapshot?.();
      return { ...this.snapshot };
    }
    override async autoMergeState(_number: number) {
      return { id: "PR_fixture", headSha: this.snapshot.headSha, enabledAt: null };
    }
    override async findFollowup(request: FollowupRequest) {
      const matches = this.followups.filter(
        (p) => p.sourceRepository === request.sourceRepository && p.sourceRef === request.sourceRef,
      );
      return (
        matches.find((p) => p.state === "open" && p.headSha === request.headSha) ??
        matches.find((p) => p.state === "open") ??
        matches.find((p) => p.body.includes(request.marker)) ??
        null
      );
    }
    override async hasComment(_number: number, marker: string) {
      if (this.commentReadThrottled) throw new ProviderError(429, "read");
      if (this.commentReadFails) throw new Error("observation unavailable");
      return [...this.priorComments, ...this.comments].some((body) => body.includes(marker));
    }
    override async currentAttempt(run: Run) {
      const latest = this.workflowRuns
        .filter((r) => r.id === run.id)
        .sort((a, b) => b.attempt - a.attempt)[0];
      if (!latest) throw new Error("missing mock run");
      return { attempt: latest.attempt, status: latest.status };
    }
    override async mainBusy() {
      return this.busy;
    }
  }
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    api.calls.push(`${init?.method} ${path}`);
    if (init?.method !== "POST") throw new Error("unexpected network request");
    if (api.response === "forbidden") return new Response("", { status: 403 });
    if (api.response === "throttled") return new Response("", { status: 429 });
    if (api.response === "unknown") throw new Error("transport unavailable");
    if (path.endsWith("/comments"))
      api.comments.push((JSON.parse(String(init.body)) as { body: string }).body);
    else if (path.endsWith("/rerun")) {
      const run = api.workflowRuns.at(-1)!;
      api.workflowRuns.push({
        ...run,
        attempt: run.attempt + 1,
        status: "queued",
        completedAt: null,
      });
    } else if (path.endsWith("/pulls")) {
      api.beforeCreate?.();
      const body = JSON.parse(String(init.body)) as { body: string; head: string };
      api.followups.push({
        number: api.followups.length + 2,
        headSha: api.snapshot.branchHeadSha!,
        state: "open",
        merged: false,
        sourceRepository: api.snapshot.headRepository!,
        sourceRef: api.snapshot.headRef,
        body: body.body,
      });
    } else throw new Error("unapproved mocked endpoint");
    api.onAccepted?.();
    if (api.response === "lost") throw new Error("response lost after acceptance");
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const api = new MockGitHub(cfg, new GitHubAuth({}), transport);
  class ClockReader extends LiveReader {
    override async observe() {
      return { ...(await super.observe()), now: new Date(clock).toISOString() };
    }
  }
  class Writer extends AtomicGitWriter {
    loseResponse = false;
    override async transaction(updates: RefUpdate[]) {
      await super.transaction(updates);
      if (this.loseResponse) {
        this.loseResponse = false;
        throw new Error("push response lost");
      }
    }
  }
  const writer = new Writer(git, origin.dir, cfg.stateRef, "refs/heads/main");
  const executor = (owner = "controller-a") =>
    new GitHubActiveExecutor(cfg, git, writer, api, new GitHubMutations(api), owner, {
      clock: () => new Date(clock),
    });
  const controller = (owner = "controller-a") =>
    new Controller(
      cfg,
      new ClockReader(api, git, cfg),
      git,
      owner,
      executor(owner),
      () => new Date(clock),
    );
  const state = async () => {
    const refs = await git.remoteRefs(origin.dir),
      sha = refs.get(cfg.stateRef);
    if (!sha) return { sha: null, ledger: emptyLedger() };
    await git.fetch(origin.dir, [sha]);
    return { sha, ledger: await git.readLedger(sha) };
  };
  const seed = async (mutate: (ledger: Ledger) => void) => {
    const old = await state(),
      ledger = structuredClone(old.ledger);
    mutate(ledger);
    const sha = await git.stateCommit(ledger, old.sha, new Date(clock).toISOString());
    await writer.transaction([{ ref: cfg.stateRef, expected: old.sha, next: sha }]);
    return sha;
  };
  const publish = async (flushQueued = true) => {
    const result = await controller().step();
    expect(result.action.kind).toBe("build");
    expect(result.manifest).not.toBeNull();
    if (flushQueued) {
      // Establish the new queued-comment lifecycle before tests attach their
      // landing/retry race hooks. Preserve provider comments for reconciliation;
      // clear only the assertions' observation window, not durable effects.
      await executor().maintain();
      expect(
        [...api.priorComments, ...api.comments].some((body) =>
          body.startsWith("Queued exact head"),
        ),
      ).toBe(true);
      api.priorComments.push(...api.comments.splice(0));
      api.calls.length = 0;
    }
    return result.manifest!;
  };
  const verdict = (m: Manifest, outcome: Run["outcome"] = "success") => {
    const run: Run = {
      id: 100,
      attempt: 1,
      headSha: m.tipSha,
      branch: `${cfg.branchPrefix}${m.batchId}`,
      workflow: cfg.workflow,
      status: "completed",
      outcome,
      trusted: true,
      retryable: outcome === "code_failure",
      ...(outcome === "infrastructure"
        ? { infrastructureRetryReason: "verified-infrastructure" as const }
        : {}),
      completedAt: NOW,
    };
    api.workflowRuns.push(run);
    return run;
  };
  const initializedSha = await seed((ledger) => {
    ledger.initialization = {
      schemaVersion: 1,
      operationId: "12345678-1234-4123-8123-123456789abc",
      serviceUid: "fixture-service",
      serviceGeneration: "1",
      initializedAt: NOW,
    };
  });
  return {
    initializedSha,
    root,
    origin,
    git,
    cfg,
    api,
    base,
    head,
    newer,
    divergent,
    makePull,
    commit,
    writer,
    executor,
    controller,
    state,
    seed,
    publish,
    verdict,
    advance: (seconds = 3601) => {
      clock += seconds * 1000;
    },
    change: (sha = newer) => {
      api.snapshot.headSha = sha;
      api.snapshot.branchHeadSha = sha;
      api.pulls = [makePull(sha)];
    },
  };
}

async function mergedOriginalWithDelta() {
  const f = await fixture(),
    manifest = await f.publish();
  f.verdict(manifest);
  f.git.beforePush = async () => {
    f.api.snapshot.state = "closed";
    f.api.snapshot.merged = true;
    f.api.snapshot.mergeCommitSha = manifest.pulls[0]!.mergeSha;
    f.api.snapshot.branchHeadSha = f.newer;
    f.api.snapshot.headRepository = f.cfg.repository;
    f.api.pulls = [];
  };
  await f.controller().step();
  expect((await f.state()).ledger.landings[`${manifest.batchId}:1`]?.status).toBe(
    "followup-pending",
  );
  return { ...f, manifest };
}

describe("actual active executor with local bare Git and mocked GitHub", () => {
  async function refreshedFixture() {
    const f = await fixture();
    const advancedMain = await f.commit({ base: "base", main: "advance" }, [f.base]);
    await f.origin.exec(["update-ref", "refs/heads/main", advancedMain]);
    const manifest = await f.publish();
    const refreshed = await f.origin.commit(
      await f.origin.mergeTree(f.head, advancedMain),
      [f.head, advancedMain],
      "Merge main",
      NOW,
    );
    await f.origin.exec(["update-ref", "refs/heads/feature", refreshed]);
    f.api.snapshot.headSha = refreshed;
    f.api.snapshot.branchHeadSha = refreshed;
    f.api.pulls = [
      {
        ...f.makePull(),
        headSha: refreshed,
        binding: {
          ...f.makePull().binding,
          evidenceId: "fresh",
          evidenceDigest: digest(refreshed),
        },
      },
    ];
    return { ...f, main: advancedMain, manifest, refreshed };
  }
  test("clean merge-main refresh lands same tested tree with native new-head ancestry and retained proof", async () => {
    const f = await refreshedFixture();
    f.verdict(f.manifest);
    const result = await f.controller().step();
    expect(result.action.kind).toBe("land");
    const refs = await f.git.remoteRefs(f.origin.dir),
      tip = refs.get("refs/heads/main")!;
    expect(tip).not.toBe(f.manifest.tipSha);
    expect(await f.git.ancestor(f.manifest.tipSha, tip)).toBe(true);
    expect(await f.git.ancestor(f.refreshed, tip)).toBe(true);
    expect(await f.git.exec(["rev-parse", `${tip}^{tree}`])).toBe(
      await f.git.exec(["rev-parse", `${f.manifest.tipSha}^{tree}`]),
    );
    const record = (await f.state()).ledger.landings[`${f.manifest.batchId}:1`]!;
    expect(record.pull.headSha).toBe(f.refreshed);
    expect(record.testedSnapshot?.headSha).toBe(f.head);
    expect(record.testedSnapshot?.tipSha).toBe(f.manifest.tipSha);
    expect(record.tipSha).toBe(tip);
  });
  test("clean refresh preserves in-progress candidate without rerun or early landing", async () => {
    const f = await refreshedFixture();
    const run = f.verdict(f.manifest);
    run.status = "in_progress";
    run.completedAt = null;
    await f.controller().step();
    expect((await f.state()).ledger.invalidated).not.toContain(f.manifest.batchId);
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.main);
    expect(f.api.calls.some((x) => x.includes("/rerun"))).toBe(false);
  });
  test("changed-head equivalence never transfers a failed result into retry or blame", async () => {
    const f = await refreshedFixture();
    f.verdict(f.manifest, "code_failure");
    const result = await f.controller().step();
    expect(result.action.kind).toBe("record");
    expect((await f.state()).ledger.invalidated).toContain(f.manifest.batchId);
    expect(f.api.calls.some((x) => x.includes("/rerun"))).toBe(false);
  });
  test("refresh rejects extra edits, linear commits, readiness churn and changed main", async () => {
    const f = await refreshedFixture();
    await f.git.fetch(f.origin.dir, [f.refreshed]);
    expect(await proveHeadRefresh(f.git, f.manifest, f.api.pulls, f.main)).not.toBeNull();
    const changed = await f.commit({ base: "base", main: "advance", feature: "changed" }, [
      f.head,
      f.main,
    ]);
    const linear = await f.commit({ base: "base", main: "advance", feature: "old" }, [f.head]);
    await f.git.fetch(f.origin.dir, [changed, linear]);
    for (const headSha of [changed, linear])
      expect(
        await proveHeadRefresh(f.git, f.manifest, [{ ...f.api.pulls[0]!, headSha }], f.main),
      ).toBeNull();
    expect(
      await proveHeadRefresh(
        f.git,
        f.manifest,
        [{ ...f.api.pulls[0]!, binding: { ...f.api.pulls[0]!.binding, eventId: "relabel" } }],
        f.main,
      ),
    ).toBeNull();
    expect(await proveHeadRefresh(f.git, f.manifest, f.api.pulls, f.base)).toBeNull();
  });
  test("final branch-head race cannot land a refresh proof", async () => {
    const f = await refreshedFixture();
    f.verdict(f.manifest);
    f.api.onSnapshot = () => {
      f.api.snapshot.branchHeadSha = f.newer;
    };
    await expect(f.controller().step()).rejects.toThrow("Final source branch head changed");
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.main);
  });
  test("final equivalence recomputation rejects a changed tree despite stable head metadata", async () => {
    const f = await refreshedFixture();
    f.verdict(f.manifest);
    const merge = f.git.mergeTree.bind(f.git);
    f.api.onSnapshot = () => {
      f.git.mergeTree = async (left, right) =>
        right === f.refreshed ? "a".repeat(40) : merge(left, right);
    };
    await expect(f.controller().step()).rejects.toThrow("Head refresh equivalence changed");
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.main);
  });
  test("refresh proof rejects side-branch merges, reversed ancestry and excessive merge chains", async () => {
    const f = await refreshedFixture();
    const side = await f.commit({ base: "base", side: "not-main" }, [f.base]);
    const sideMerge = await f.origin.commit(
      await f.origin.mergeTree(f.head, side),
      [f.head, side],
      "side",
      NOW,
    );
    const reversed = await f.origin.commit(
      await f.origin.mergeTree(f.head, f.main),
      [f.main, f.head],
      "reverse",
      NOW,
    );
    let long = f.head;
    for (let i = 0; i < 9; i++)
      long = await f.origin.commit(
        await f.origin.mergeTree(long, f.main),
        [long, f.main],
        `main${i}`,
        NOW,
      );
    await f.git.fetch(f.origin.dir, [sideMerge, reversed, long]);
    for (const headSha of [sideMerge, reversed, long])
      expect(
        await proveHeadRefresh(f.git, f.manifest, [{ ...f.api.pulls[0]!, headSha }], f.main),
      ).toBeNull();
  });
  test("multiple refreshed members retain every new head and the full tested tree", async () => {
    const f = await refreshedFixture();
    const second = await f.commit({ base: "base", second: "feature" }, [f.base]);
    const secondRefresh = await f.origin.commit(
      await f.origin.mergeTree(second, f.main),
      [second, f.main],
      "main into second",
      NOW,
    );
    await f.git.fetch(f.origin.dir, [f.refreshed, second, secondRefresh]);
    const oldSecond = { ...f.makePull(second), number: 2, headRef: "second" };
    const tested = await f.git.build({
      schemaVersion: 1,
      baseSha: f.main,
      predecessor: null,
      recoveryOf: null,
      createdAt: NOW,
      pulls: [f.makePull(), oldSecond],
    });
    const proof = await proveHeadRefresh(
      f.git,
      tested,
      [
        f.api.pulls[0]!,
        {
          ...oldSecond,
          headSha: secondRefresh,
          binding: {
            ...oldSecond.binding,
            evidenceId: "fresh-second",
            evidenceDigest: digest(secondRefresh),
          },
        },
      ],
      f.main,
    );
    expect(proof).not.toBeNull();
    expect(await f.git.ancestor(f.refreshed, proof!.tipSha)).toBe(true);
    expect(await f.git.ancestor(secondRefresh, proof!.tipSha)).toBe(true);
    expect(await f.git.ancestor(tested.tipSha, proof!.tipSha)).toBe(true);
    expect(await f.git.exec(["rev-parse", `${proof!.tipSha}^{tree}`])).toBe(proof!.testedTree);
  });
  test("refresh rebuild conflict rejects equivalence but unexpected errors propagate", async () => {
    const f = await refreshedFixture();
    await f.git.fetch(f.origin.dir, [f.refreshed]);
    const { MergeConflict } = await import("./git");
    const build = f.git.build.bind(f.git);
    let failure: Error = new MergeConflict(1);
    f.git.build = async (spec) => {
      if (spec.pulls.some((p) => p.headSha === f.refreshed)) throw failure;
      return build(spec);
    };
    expect(await proveHeadRefresh(f.git, f.manifest, f.api.pulls, f.main)).toBeNull();
    await f.controller().step();
    expect((await f.state()).ledger.invalidated).toContain(f.manifest.batchId);
    expect((await f.git.remoteRefs(f.origin.dir)).get("refs/heads/main")).toBe(f.main);
    for (const message of ["provider unavailable", "unknown write outcome"]) {
      failure = new Error(message);
      await expect(proveHeadRefresh(f.git, f.manifest, f.api.pulls, f.main)).rejects.toBe(failure);
    }
  });
  test("refresh requires unchanged identity, root membership and bounded merge lineage", async () => {
    const f = await refreshedFixture();
    await f.git.fetch(f.origin.dir, [f.refreshed]);
    const p = f.api.pulls[0]!;
    for (const changed of [
      { ...p, headRef: "other" },
      { ...p, controlPlane: true },
      { ...p, binding: { ...p.binding, source: "auto-merge" as const } },
      { ...p, binding: { ...p.binding, at: "2026-10-21T12:00:01.000Z" } },
      { ...f.makePull(), binding: { ...f.makePull().binding, evidenceId: "fresh" } },
    ])
      expect(await proveHeadRefresh(f.git, f.manifest, [changed], f.main)).toBeNull();
    expect(
      await proveHeadRefresh(f.git, { ...f.manifest, predecessor: "a".repeat(64) }, [p], f.main),
    ).toBeNull();
    expect(await proveHeadRefresh(f.git, f.manifest, [], f.main)).toBeNull();
    let chain = f.head;
    for (let i = 1; i <= 9; i++) {
      chain = await f.origin.commit(
        await f.origin.mergeTree(chain, f.main),
        [chain, f.main],
        `m${i}`,
        NOW,
      );
      if (i < 8) continue;
      await f.git.fetch(f.origin.dir, [chain]);
      const proof = await proveHeadRefresh(f.git, f.manifest, [{ ...p, headSha: chain }], f.main);
      expect(proof === null).toBe(i === 9);
    }
  });
  test("content-neutral non-main ancestry, evil-revert and octopus refreshes are rejected", async () => {
    const f = await refreshedFixture();
    const p = f.api.pulls[0]!;
    const mainTree = await f.origin.exec(["rev-parse", `${f.main}^{tree}`]);
    const cherry = await f.origin.commit(mainTree, [f.base], "cherry-picked main", NOW);
    const viaCherry = await f.origin.commit(
      await f.origin.mergeTree(f.head, cherry),
      [f.head, cherry],
      "merge cherry",
      NOW,
    );
    const clean = await f.origin.mergeTree(f.head, f.main);
    const evil = await f.commit({ base: "base", main: "advance", feature: "old", injected: "x" }, [
      f.head,
      f.main,
    ]);
    const revert = await f.origin.commit(clean, [evil, f.main], "evil revert", NOW);
    const octopus = await f.origin.commit(clean, [f.head, f.main, cherry], "octopus", NOW);
    await f.git.fetch(f.origin.dir, [viaCherry, revert, octopus]);
    for (const headSha of [viaCherry, revert, octopus])
      expect(await proveHeadRefresh(f.git, f.manifest, [{ ...p, headSha }], f.main)).toBeNull();
  });
  test("missing initialized state alerts and refuses activation without provider writes", async () => {
    const f = await fixture();
    await f.origin.exec(["update-ref", "-d", f.cfg.stateRef]);
    await expect(f.controller().step()).rejects.toMatchObject({
      name: "ActiveStateInitializationError",
    });
    expect(f.api.calls).toHaveLength(0);
    expect((await f.git.remoteRefs(f.origin.dir)).has(f.cfg.stateRef)).toBe(false);
  });
  test.each([false, true])("native MERGED is distinct from CLOSED (merged=%s)", async (merged) => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    expect((await f.controller().step()).action.kind).toBe("land");
    f.api.snapshot.state = "closed";
    f.api.snapshot.merged = merged;
    f.advance();
    await f.executor().maintain();
    expect((await f.state()).ledger.landings[`${m.batchId}:1`]?.status).toBe(
      merged ? "native-merged" : "closed-unmerged",
    );
  });
  test("publishes create-only, lands exact tested tip, reconstructs without duplicate landing", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    expect((await f.controller().step()).action.kind).toBe("land");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
    expect((await f.state()).ledger.landings[`${m.batchId}:1`]?.status).toBe(
      "awaiting-native-merge",
    );
    expect(f.api.comments[0]).toContain(f.head);
    expect(f.api.comments[0]).toContain(m.tipSha);
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(f.api.calls).toHaveLength(1);
    expect(
      f.git.pushes.every(
        (args) =>
          !args.some((a) => a.startsWith("--force-with-lease=refs/heads/main") || a === "--force"),
      ),
    ).toBe(true);
  });
  test("queued publication comment lost response is reconciled once after restart", async () => {
    const f = await fixture();
    await f.publish(false);
    f.api.response = "lost";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(f.api.comments[0]).toContain("Queued exact head");
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
  });
  test("explicit ON notice includes unready open PRs and survives executor restart", async () => {
    const f = await fixture();
    f.cfg.onNoticeId = "rollout-20261023";
    await f.executor().maintain();
    await f.executor().maintain();
    await f.executor().maintain();
    expect((await f.state()).ledger.onNotices?.["rollout-20261023"]?.recipients).toEqual([1, 99]);
    expect(f.api.comments).toHaveLength(2);
    expect(f.api.calls.some((c) => c.includes("/issues/99/comments"))).toBe(true);
    expect(f.api.comments.every((c) => c.includes("Merges now go through the batcher"))).toBe(true);
  });
  test("head race after final read lands snapshot and automatically queues only newer delta", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    f.git.beforePush = async () => {
      f.change();
    };
    await f.controller().step();
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
    expect((await f.state()).ledger.landings[`${m.batchId}:1`]?.status).toBe("requeued");
    expect(f.api.snapshot.state).toBe("open");
    const next = await f.publish();
    expect(next.baseSha).toBe(m.tipSha);
    expect(await f.git.exec(["diff", "--name-only", m.tipSha, next.tipSha])).toBe("delta");
    expect(next.pulls[0]?.headSha).toBe(f.newer);
    expect(f.api.calls.every((call) => call.includes("/comments"))).toBe(true);
  });
  test.each(["closed", "missing-evidence", "divergent"])(
    "post-land reconciliation reports %s without pretending newer work was tested",
    async (kind) => {
      const f = await fixture(),
        m = await f.publish();
      f.verdict(m);
      f.git.beforePush = async () => {
        f.change(kind === "divergent" ? f.divergent : f.newer);
        if (kind === "closed") {
          f.api.snapshot.state = "closed";
          f.api.snapshot.merged = true;
          f.api.pulls = [];
        }
        if (kind === "missing-evidence") f.api.pulls = [];
      };
      await f.controller().step();
      const record = (await f.state()).ledger.landings[`${m.batchId}:1`]!;
      expect(record.status).toBe(
        kind === "closed"
          ? "followup-blocked"
          : kind === "divergent"
            ? "history-diverged"
            : "awaiting-evidence",
      );
      expect(record.note).not.toBeNull();
      expect((await f.controller().step()).manifest).toBeNull();
      expect(f.api.calls.every((call) => call.includes("/comments"))).toBe(true);
    },
  );
  test("final reread rejects changed evidence and latest workflow attempt", async () => {
    const f = await fixture(),
      m = await f.publish();
    const run = f.verdict(m);
    const reader = new LiveReader(f.api, f.git, f.cfg);
    const observation = await reader.observe();
    const ledger = structuredClone(observation.ledger);
    ledger.owner = "controller-a";
    ledger.epoch++;
    ledger.expiresAt = "2026-10-21T13:00:00.000Z";
    const nextState = await f.git.stateCommit(ledger, observation.stateSha, NOW);
    const tx = {
      expectedState: observation.stateSha,
      expectedLedger: observation.ledger,
      nextLedger: ledger,
      nextState,
      now: NOW,
      bindings: m.pulls,
      effect: { kind: "land" as const, manifest: m, expectedBase: f.base },
    };
    f.api.pulls[0]!.binding.evidenceDigest = digest("changed");
    await expect(f.executor().transact(tx)).rejects.toThrow("binding changed");
    f.api.pulls = [f.makePull()];
    f.api.workflowRuns.push({ ...run, attempt: 2, status: "in_progress" });
    await expect(f.executor().transact(tx)).rejects.toThrow("not verified green");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
  });
  test("two controllers and stale generation cannot duplicate publication", async () => {
    const f = await fixture();
    await f.publish();
    await f.controller("controller-b").step();
    expect(
      [...(await f.git.remoteRefs(f.origin.dir)).keys()].filter((x) =>
        x.startsWith("refs/heads/queue/"),
      ),
    ).toHaveLength(1);
    const old = await f.state();
    f.advance();
    await f.seed((l) => {
      l.owner = "controller-b";
      l.epoch++;
    });
    const next = await f.git.stateCommit(old.ledger, old.sha, NOW);
    await expect(
      f.writer.transaction([{ ref: f.cfg.stateRef, expected: old.sha, next }]),
    ).rejects.toThrow("Stale");
  });
  test("accepted push with lost response reconciles instead of republishing", async () => {
    const f = await fixture();
    f.writer.loseResponse = true;
    const m = await f.publish();
    f.verdict(m);
    f.writer.loseResponse = true;
    await f.controller().step();
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
    expect((await f.state()).ledger.landed).toEqual([m.batchId]);
    expect((await f.controller().step()).action.kind).toBe("wait");
  });
  test("atomic create-only candidate rejects a concurrent existing ancestor ref", async () => {
    const f = await fixture();
    f.git.beforePush = async () => {
      const candidate = f.git.pushes
        .at(-1)!
        .find((arg) => arg.includes(":refs/heads/queue/live/"))!;
      await f.origin.exec(["update-ref", candidate.split(":")[1]!, f.base]);
    };
    await expect(f.publish()).rejects.toThrow();
    expect((await f.state()).sha).toBe(f.initializedSha);
  });
  test("blocking reader evidence prevents hosted publication, retry and landing", async () => {
    // This stub models incomplete/unknown evidence or an occupied Batch slot.
    // Valid numeric/main-capacity estimates are informational in the live reader.
    const f = await fixture();
    f.api.busy = true;
    const local = await f.controller().step();
    expect(local.manifest).not.toBeNull();
    expect((await f.state()).sha).toBe(f.initializedSha);
    f.api.busy = false;
    const m = await f.publish();
    f.verdict(m, "infrastructure");
    f.advance(61);
    f.api.busy = true;
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(f.api.calls).toHaveLength(0);
    f.api.workflowRuns = [];
    f.verdict(m);
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
  });
  test.each(["publish", "retry", "land"] as const)(
    "live capacity observation permits %s while preserving executor checks",
    async (phase) => {
      const f = await fixture();
      const live = new GitHubReader(
        config({ BATCHER_MODE: "active", BATCHER_RUNNER_BUDGET: "52", BATCHER_MAIN_RESERVE: "30" }),
        new GitHubAuth({}),
        (async (url: string | URL | Request) => {
          const path = String(url);
          if (path.includes("/jobs?"))
            return Response.json({
              total_count: 4,
              jobs: [
                { status: "queued" },
                ...Array.from({ length: 3 }, () => ({ status: "completed" })),
              ],
            });
          const status = new URL(path).searchParams.get("status");
          const runs =
            status === "in_progress"
              ? [
                  {
                    id: 900,
                    status,
                    path: ".github/workflows/ci.yml",
                    head_branch: "main",
                    event: "push",
                  },
                ]
              : [];
          return Response.json({ total_count: runs.length, workflow_runs: runs });
        }) as typeof fetch,
      );
      f.api.mainBusy = () => live.mainBusy();
      const m = await f.publish();
      if (phase === "retry") {
        f.verdict(m, "infrastructure");
        f.advance(61);
        expect((await f.controller().step()).action.kind).toBe("retry");
        await f.executor().maintain();
        expect(f.api.calls).toHaveLength(1);
        expect(f.api.calls[0]).toEndWith("/rerun");
      } else if (phase === "land") {
        f.verdict(m);
        expect((await f.controller().step()).action.kind).toBe("land");
        expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
      }
      expect(live.lastHeadroom).toMatchObject({
        allowed: true,
        capacityInformational: true,
        capacity: { hold: "main-queued", mainQueuedJobs: 1 },
      });
    },
  );
  test("whole-run retry lost response is observed by attempt after restart, never duplicated", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "infrastructure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    const persistedRetry = (await f.state()).ledger.retries[m.batchId]!;
    expect(persistedRetry.reason).toBe("verified-infrastructure");
    expect((await f.state()).ledger.stages[m.batchId]?.retry).toEqual(persistedRetry);
    f.api.response = "lost";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(f.api.calls[0]).toEndWith("/rerun");
    f.advance();
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("done");
    expect(f.api.calls).toHaveLength(1);
  });
  test.each(["main-advance", "invalidated", "after-claim"] as const)(
    "R8 obsolete retry %s never submits",
    async (change) => {
      const f = await fixture(),
        m = await f.publish();
      f.verdict(m, "infrastructure");
      f.advance(61);
      expect((await f.controller().step()).action.kind).toBe("retry");
      if (change === "invalidated")
        await f.seed((l) => {
          l.invalidated.push(m.batchId);
        });
      else if (change === "main-advance")
        await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
      else
        f.git.beforePush = async () => {
          await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
        };
      await f.executor().maintain();
      expect(f.api.calls).toEqual([]);
      expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("blocked");
      f.advance(61);
      if (change === "invalidated") await f.executor().maintain();
      else {
        await f.controller().step();
        expect((await f.state()).ledger.invalidated).toContain(m.batchId);
      }
      expect(f.api.calls).toEqual([]);
    },
  );
  test("unknown retry outcome remains reconciliation-only after main advances", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "infrastructure");
    f.advance(61);
    await f.controller().step();
    f.api.response = "unknown";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
    f.advance(180);
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("uncertain");
  });
  test.each(["live", "invalidated-parent", "obsolete-parent"] as const)(
    "predecessor retry chain %s is checked exactly",
    async (parentState) => {
      const f = await fixture(),
        root = await f.publish();
      f.verdict(root);
      const p = f.makePull(f.newer);
      f.api.pulls = [p];
      const child = await f.git.build({
        schemaVersion: 1,
        baseSha: root.tipSha,
        predecessor: root.batchId,
        recoveryOf: null,
        createdAt: NOW,
        pulls: [p],
      });
      const prior = await f.state();
      const next = await f.git.stateCommit(prior.ledger, prior.sha, NOW);
      await f.writer.transaction([
        { ref: f.cfg.stateRef, expected: prior.sha, next },
        {
          ref: `refs/heads/${f.cfg.branchPrefix}${child.batchId}`,
          expected: null,
          next: child.tipSha,
        },
      ]);
      const r = f.verdict(child, "infrastructure");
      r.id = 101;
      await f.seed((l) => {
        l.retries[child.batchId] = {
          runId: r.id,
          fromAttempt: 1,
          requestedAt: NOW,
          reason: "verified-infrastructure",
        };
        Object.assign(l, f.executor().prepareLedger(l, { kind: "retry", run: r }, NOW));
        if (parentState === "invalidated-parent") l.invalidated.push(root.batchId);
      });
      if (parentState === "obsolete-parent")
        await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
      f.advance(61);
      await f.executor().maintain();
      expect(f.api.calls.filter((call) => call.endsWith("/rerun"))).toHaveLength(
        parentState === "live" ? 1 : 0,
      );
    },
  );
  test("code failure gets one fenced retry, then parks on the latest failed attempt", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "code_failure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    await f.executor().maintain();
    expect(f.api.calls.filter((call) => call.endsWith("/rerun"))).toHaveLength(1);
    const second = f.api.workflowRuns.at(-1)!;
    second.status = "completed";
    second.outcome = "code_failure";
    second.trusted = true;
    second.completedAt = NOW;
    expect(second.attempt).toBe(2);
    expect((await f.controller().step()).action.kind).toBe("record");
    expect((await f.state()).ledger.parked?.[0]?.attempt).toBe(2);
    await f.executor().maintain();
    expect(f.api.calls.filter((call) => call.endsWith("/rerun"))).toHaveLength(1);
  });
  test("a stale code-failure retry intent cannot submit, even if a prior controller persisted it", async () => {
    const f = await fixture(),
      m = await f.publish();
    const observed = f.verdict(m, "infrastructure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    observed.outcome = "code_failure";
    observed.retryable = true;
    delete observed.infrastructureRetryReason;
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(0);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("blocked");
  });
  test("once retried infrastructure holds after second terminal failure without ejecting", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "infrastructure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    await f.executor().maintain();
    const second = f.api.workflowRuns.at(-1)!;
    second.status = "completed";
    second.completedAt = NOW;
    f.advance(61);
    await f.executor().maintain();
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(f.api.calls).toHaveLength(1);
    expect((await f.state()).ledger.ejected).toEqual([]);
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
  });
  test("a rejected infrastructure rerun POST is not automatically submitted again", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "infrastructure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    f.api.response = "forbidden";
    await f.executor().maintain();
    f.advance(3601);
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("blocked");
    expect((await f.state()).ledger.ejected).toEqual([]);
  });
  test.each(["lost", "forbidden", "unknown"] as const)(
    "comment %s outcome is durable and never blindly repeated",
    async (response) => {
      const f = await fixture();
      await f.seed((l) => {
        l.ejected.push({
          pull: f.makePull(),
          batchId: "a".repeat(64),
          reason: "merge-tree conflict against candidate predecessor",
          announced: false,
        });
      });
      await f.controller().step();
      f.api.response = response;
      await f.executor().maintain();
      f.advance();
      await f.executor().maintain();
      const ledger = (await f.state()).ledger,
        effect = Object.values(ledger.effects)[0]!;
      expect(effect.status).toBe(
        response === "lost" ? "done" : response === "forbidden" ? "blocked" : "uncertain",
      );
      expect(ledger.ejected[0]?.announced).toBe(response === "lost");
      expect(f.api.calls).toHaveLength(1);
    },
  );
  test("crash after durable claim blocks boundedly; explicit CAS recovery resumes", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "b".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step();
    await f.seed((l) => {
      Object.values(l.effects)[0]!.status = "submitting";
    });
    for (let i = 0; i < 8; i++) {
      f.advance();
      await f.executor().maintain();
    }
    const state = await f.state(),
      effect = Object.values(state.ledger.effects)[0]!;
    expect(effect.status).toBe("blocked");
    expect(f.api.calls).toHaveLength(0);
    await expect(f.executor().recoverEffect(effect.id, state.sha!, false)).rejects.toThrow(
      "confirmation",
    );
    await expect(f.executor().recoverEffect(effect.id, "0".repeat(40), true)).rejects.toThrow(
      "state changed",
    );
    await f.executor().recoverEffect(effect.id, state.sha!, true);
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect((await f.state()).ledger.ejected[0]?.announced).toBe(true);
  });
  test("throttled effects have bounded submission budget without false announcement", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "c".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step();
    f.api.response = "throttled";
    for (let i = 0; i < 7; i++) {
      f.advance();
      await f.executor().maintain();
    }
    expect(f.api.calls).toHaveLength(5);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("blocked");
    expect((await f.state()).ledger.ejected[0]?.announced).toBe(false);
  });
  test("uncertain submission plus failed observation never returns to automatic pending", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "d".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step();
    f.api.response = "unknown";
    await f.executor().maintain();
    f.advance();
    f.api.commentReadFails = true;
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("uncertain");
    f.advance();
    f.api.commentReadFails = false;
    f.api.commentReadThrottled = true;
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("uncertain");
    f.advance();
    f.api.commentReadThrottled = false;
    f.api.response = "ok";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
  });
  test("lease transfer after durable REST claim prevents stale controller submission", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "e".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step();
    const transaction = f.writer.transaction.bind(f.writer);
    let transfer = true;
    f.writer.transaction = async (updates) => {
      await transaction(updates);
      if (transfer) {
        transfer = false;
        await f.seed((l) => {
          l.owner = "controller-b";
          l.epoch++;
          l.expiresAt = "2026-10-21T14:00:00.000Z";
        });
      }
    };
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(0);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("submitting");
    await f.executor("controller-b").maintain();
    expect(f.api.calls).toHaveLength(0);
  });
  test("successful POST followed by throttled state observation stays uncertain, not replayable", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "f".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step();
    const remoteRefs = f.git.remoteRefs.bind(f.git);
    f.api.onAccepted = () => {
      let fail = true;
      f.git.remoteRefs = async (remote) => {
        if (fail) {
          fail = false;
          throw new ProviderError(429, "auth refresh");
        }
        return remoteRefs(remote);
      };
    };
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("uncertain");
    f.advance();
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("done");
    expect(f.api.calls).toHaveLength(1);
  });
  test.each(["green"] as const)(
    "inherited #5243-style singleton is parked without blame on %s main; new base does not retry it",
    async (status) => {
      const f = await fixture();
      const m = await f.publish();
      f.verdict(m, "code_failure").attempt = 2;
      f.api.baseStatus = status;
      expect((await f.controller().step()).action.kind).toBe("record");
      const held = (await f.state()).ledger;
      expect(held.ejected).toEqual([]);
      expect(held.recovery).toEqual([]);
      expect(held.parked?.[0]?.baseSha).toBe(f.base);
      expect((await f.controller().step()).action.kind).toBe("park");
      expect(f.api.calls).toEqual([]);
      await f.controller().step();
      await f.executor().maintain(); // Reconcile native disable before the parking comment.
      expect(f.api.comments).toHaveLength(1);
      expect(f.api.comments[0]).toContain("singleton Batch CI failed");
      await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
      f.api.baseStatus = "green";
      expect((await f.controller().step()).action.kind).toBe("wait");
      expect((await f.state()).ledger.parked).toHaveLength(1);
      expect(f.api.calls).toHaveLength(1);
      expect((await f.state()).ledger.baseHold).toBeUndefined();
      expect((await f.state()).ledger.ejected).toEqual([]);
    },
  );
  test("green full-main CI is not comparable base-suite evidence for singleton ejection", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "code_failure").attempt = 2;
    expect((await f.controller().step()).action.kind).toBe("record");
    expect((await f.state()).ledger.ejected).toEqual([]);
    expect((await f.state()).ledger.parked?.[0]?.pull.headSha).toBe(f.head);
    expect((await f.state()).ledger.retries).toEqual({});
  });
  test("parking comment lost response is reconciled after restart, never blindly replayed", async () => {
    const f = await fixture();
    const m = await f.publish();
    f.verdict(m, "code_failure").attempt = 2;
    await f.controller().step();
    expect((await f.controller().step()).action.kind).toBe("park");
    await f.executor().maintain(); // Already-disabled native request is reconciled first.
    f.api.response = "lost";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    f.advance();
    await f.executor().maintain();
    const parked = (await f.state()).ledger.parked![0]!;
    expect(parked.announced).toBe(true);
    expect((await f.state()).ledger.effects[parked.effectId!]!.status).toBe("done");
    expect(f.api.comments).toHaveLength(1);
    expect(f.api.calls).toHaveLength(1);
  });
  test.each(["red", "unknown"] as const)(
    "exact green batch builds and lands on %s full-main CI",
    async (status) => {
      const f = await fixture();
      f.api.baseStatus = status;
      await f.seed((l) => {
        l.baseHold = { sha: f.base, status: "red", runId: 50, attempt: 1, reason: "legacy hold" };
      });
      const m = await f.publish();
      expect((await f.controller().step()).action.kind).toBe("wait");
      expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
      f.verdict(m);
      // Main-CI observation failure must not become an indirect admission gate.
      f.api.baseCI = async () => {
        throw Error("full main CI unavailable");
      };
      expect((await f.controller().step()).action.kind).toBe("land");
      expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
      expect((await f.state()).ledger.landed).toContain(m.batchId);
      expect(f.api.comments).toHaveLength(1);
      expect(f.api.comments[0]).toContain("landed the exact tested PR head");
      expect(f.api.calls.every((call) => call.endsWith("/comments"))).toBe(true);
    },
  );
  test("real reader observes exact red base before retrying or parking a failed batch", async () => {
    const f = await fixture();
    const m = await f.publish();
    f.api.baseStatus = "red";
    for (const [attempt, status] of [
      [1, "red"],
      [2, "unknown"],
      [2, "red"],
    ] as const) {
      f.api.baseStatus = status;
      f.verdict(m, "code_failure").attempt = attempt;
      const result = await f.controller().step();
      expect(result.action.kind).toBe("wait");
      expect(result.reason).toContain("no retry, split or parking");
      const ledger = (await f.state()).ledger;
      expect(ledger.retries).toEqual({});
      expect(ledger.recovery).toEqual([]);
      expect(ledger.parked ?? []).toEqual([]);
      expect(ledger.invalidated).not.toContain(m.batchId);
    }
  });
  test("legacy pending code-failure comment holds even with green full-main CI", async () => {
    const f = await fixture();
    await f.seed((l) => {
      l.ejected.push({
        pull: f.makePull(),
        batchId: "f".repeat(64),
        reason: "merge-tree conflict against candidate predecessor",
        announced: false,
      });
    });
    await f.controller().step(); // Create a real durable effect, then model old code-blame state.
    await f.seed((l) => {
      l.ejected[0]!.reason = "non-retryable exact-candidate code failure";
      for (const effect of Object.values(l.effects))
        if (effect.kind === "comment")
          effect.body = effect.body.replace(
            "merge-tree conflict against candidate predecessor",
            l.ejected[0]!.reason,
          );
    });
    await f.executor().maintain();
    expect(f.api.calls).toEqual([]);
    expect(Object.values((await f.state()).ledger.effects)[0]?.lastError).toContain(
      "base batch-suite",
    );
  });
  test("main race outside tested ancestry rejects entire atomic landing", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    f.git.beforePush = async () => {
      await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
    };
    await expect(f.controller().step()).rejects.toThrow();
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.divergent);
    expect((await f.state()).ledger.landed).toEqual([]);
    // Restart after an emergency/admin main advance: the old green tip cannot
    // be reused, and the exact replacement must earn its own provider verdict.
    expect((await f.controller().step()).action.kind).toBe("record");
    expect((await f.state()).ledger.invalidated).toContain(m.batchId);
    const rebuilt = await f.publish();
    expect(rebuilt.baseSha).toBe(f.divergent);
    expect(rebuilt.tipSha).not.toBe(m.tipSha);
    expect(rebuilt.batchId).not.toBe(m.batchId);
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.divergent);
    f.verdict(rebuilt);
    expect((await f.controller().step()).action.kind).toBe("land");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(rebuilt.tipSha);
    expect(await f.origin.exec(["show", `${rebuilt.tipSha}:replacement`])).toBe("new");
    expect(await f.origin.exec(["show", `${rebuilt.tipSha}:feature`])).toBe("old");
  });
  test("newer source branch is detected even if merged PR metadata still names old head", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    f.git.beforePush = async () => {
      f.api.snapshot.branchHeadSha = f.newer;
      f.api.snapshot.state = "closed";
      f.api.snapshot.merged = true;
      f.api.pulls = [];
    };
    await f.controller().step();
    const record = (await f.state()).ledger.landings[`${m.batchId}:1`]!;
    expect(record.currentHeadSha).toBe(f.newer);
    expect(record.status).toBe("followup-blocked");
  });
  test("GitHub read adapter binds actual fork branch and exact attempt identity", async () => {
    const f = await fixture(),
      m = await f.publish(),
      run = f.verdict(m);
    const urls: string[] = [];
    let wrongAttemptIdentity = false;
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      urls.push(String(url));
      if (String(url).includes("/pulls/1"))
        return Response.json({
          head: { sha: f.head, ref: "topic/work", repo: { full_name: "fork/project" } },
          state: "closed",
          merged: true,
        });
      if (String(url).includes("/git/ref/")) return Response.json({ object: { sha: f.newer } });
      if (String(url).includes("/actions/runs/"))
        return Response.json({
          id: run.id,
          head_sha: run.headSha,
          head_branch: run.branch,
          path: wrongAttemptIdentity ? "wrong.yml" : run.workflow,
          event: "push",
          run_attempt: 2,
          status: "queued",
        });
      throw new Error("unexpected mocked endpoint");
    }) as typeof fetch;
    const reader = new GitHubReader(f.cfg, new GitHubAuth({}), transport);
    const snapshot = await reader.pullSnapshot(1);
    expect(snapshot.headSha).toBe(f.head);
    expect(snapshot.branchHeadSha).toBe(f.newer);
    expect(urls[1]).toContain("/repos/fork/project/git/ref/heads/topic%2Fwork");
    expect(await reader.currentAttempt(run)).toEqual({ attempt: 2, status: "queued" });
    wrongAttemptIdentity = true;
    await expect(reader.currentAttempt(run)).rejects.toThrow("identity changed");
  });
  test.each([
    [10, 2, false],
    [44, 2, true],
    [10, 3, true],
  ] as const)(
    "observed main jobs %i and other jobs %i yield capacity hold %s",
    async (mainJobs, otherJobs, held) => {
      const cfg = config({
        BATCHER_MODE: "active",
        BATCHER_RUNNER_BUDGET: "60",
        BATCHER_MAIN_RESERVE: "40",
      });
      const transport = (async (url: string | URL | Request) => {
        if (String(url).includes("/jobs?")) {
          const count = String(url).includes("/runs/1/") ? mainJobs : otherJobs;
          return Response.json({
            total_count: count + 3,
            jobs: [
              ...Array.from({ length: count }, () => ({ status: "in_progress" })),
              ...Array.from({ length: 3 }, () => ({ status: "completed" })),
            ],
          });
        }
        const status = new URL(String(url)).searchParams.get("status");
        const runs =
          status === "waiting"
            ? [
                {
                  id: 1,
                  head_branch: "main",
                  path: ".github/workflows/ci.yml",
                  event: "push",
                  status,
                },
                { id: 2, head_branch: "feature", path: "other.yml", event: "push", status },
              ]
            : [];
        return Response.json({ total_count: runs.length, workflow_runs: runs });
      }) as typeof fetch;
      const reader = new GitHubReader(cfg, new GitHubAuth({}), transport);
      expect(await reader.mainBusy()).toBe(false);
      expect(Boolean(reader.lastHeadroom?.capacity?.hold)).toBe(held);
      expect(reader.lastHeadroom?.reservedMain).toBe(Math.max(40, mainJobs));
      expect(reader.lastHeadroom?.occupied).toBe(mainJobs + otherJobs);
      expect(reader.lastHeadroom?.candidateSlots).toBe(18);
    },
  );
  test("capacity budget is explicit and incomplete scans never invent headroom", async () => {
    const unconfigured = new GitHubReader(config({}), new GitHubAuth({}), (async () => {
      throw new Error("must not assume quota");
    }) as unknown as typeof fetch);
    expect(await unconfigured.mainBusy()).toBe(true);
    expect(unconfigured.lastHeadroom?.budget).toBeNull();
    const settings = config({ BATCHER_RUNNER_BUDGET: "60", BATCHER_MAIN_RESERVE: "40" });
    const incomplete = new GitHubReader(settings, new GitHubAuth({}), (async () =>
      Response.json({ total_count: 101, workflow_runs: [] })) as unknown as typeof fetch);
    expect(await incomplete.mainBusy()).toBe(true);
    expect(incomplete.lastHeadroom?.reason).toContain("Incomplete");
    const batch = new GitHubReader(settings, new GitHubAuth({}), (async () =>
      Response.json({
        total_count: 1,
        workflow_runs: [{ id: 2, path: settings.workflow, status: "queued" }],
      })) as unknown as typeof fetch);
    expect(await batch.mainBusy()).toBe(true);
    expect(batch.lastHeadroom?.reason).toContain("single candidate");
  });
  describe("runner headroom counts runner-holding jobs, not run placeholders", () => {
    type JobPage = Record<string, unknown> | unknown[];
    const MAIN = { head_branch: "main", path: ".github/workflows/ci.yml", event: "push" };
    const OTHER = { head_branch: "feature", path: ".github/workflows/other.yml", event: "push" };
    const jobs = (...statuses: unknown[]) =>
      statuses.map((status) => (status === undefined ? {} : { status }));
    const page = (list: unknown[]): JobPage => ({ total_count: list.length, jobs: list });
    const reader = (
      runs: Array<Record<string, unknown>>,
      jobPages: Record<number, JobPage>,
      budget = "60",
      runPage?: (status: string) => JobPage,
    ) => {
      const cfg = config({
        BATCHER_MODE: "active",
        BATCHER_RUNNER_BUDGET: budget,
        BATCHER_MAIN_RESERVE: "40",
        // These cases isolate the repository allocation arithmetic; the hosted
        // job limit and other-repository allowance are covered in capacity.test.ts.
        BATCHER_PROVIDER_JOB_LIMIT: "100000",
        BATCHER_OTHER_REPOSITORY_ALLOWANCE: "0",
      });
      const transport = (async (url: string | URL | Request) => {
        const text = String(url);
        const jobsMatch = /\/runs\/(\d+)\/jobs\?/.exec(text);
        if (jobsMatch) return Response.json(jobPages[Number(jobsMatch[1])]);
        const status = new URL(text).searchParams.get("status")!;
        if (runPage) return Response.json(runPage(status));
        const listed = runs.filter((run) => run.status === status);
        return Response.json({ total_count: listed.length, workflow_runs: listed });
      }) as typeof fetch;
      return new GitHubReader(cfg, new GitHubAuth({}), transport);
    };
    test("classifier counts queued, in-progress and requested jobs only", () => {
      expect(runnerJobDemand([])).toBe(0);
      expect(runnerJobDemand(jobs("waiting", "waiting", "pending", "completed"))).toBe(0);
      expect(runnerJobDemand(jobs("queued", "in_progress", "requested", "completed"))).toBe(3);
      for (const invalid of ["action_required", "", "QUEUED", 1, null, undefined])
        expect(runnerJobDemand(jobs("in_progress", invalid))).toBeNull();
      expect(runnerJobDemand([null])).toBeNull();
      expect(runnerJobDemand(["queued"])).toBeNull();
    });
    test.each([
      ["zero-job other run held by its concurrency group", [], 0, true],
      ["approval-waiting other jobs", ["waiting", "waiting", "waiting", "waiting"], 0, true],
      ["concurrency-pending other jobs", ["pending", "pending", "pending"], 0, true],
      ["completed other jobs", ["completed", "completed", "completed"], 0, true],
      ["two runner-holding other jobs", ["queued", "in_progress", "completed"], 2, true],
      ["three runner-holding other jobs", ["queued", "in_progress", "requested"], 3, false],
      [
        "mixed matrix counts each runner-holding job",
        ["in_progress", "in_progress", "queued", "waiting", "pending", "completed", "completed"],
        3,
        false,
      ],
    ] as const)("%s", async (_name, statuses, demand, allowed) => {
      const r = reader([{ id: 2, status: "queued", ...OTHER }], { 2: page(jobs(...statuses)) });
      expect(await r.mainBusy()).toBe(false);
      expect(Boolean(r.lastHeadroom?.capacity?.hold)).toBe(!allowed);
      expect(r.lastHeadroom).toMatchObject({
        allowed: true,
        capacityInformational: true,
        occupied: demand,
        reservedMain: 40,
        candidateSlots: 18,
        budget: 60,
      });
    });
    test("main and non-main allocations are independent", async () => {
      const busy = (budget: string) =>
        reader(
          [
            { id: 1, status: "in_progress", ...MAIN },
            // A job-less placeholder adds no demand. (A job-less *main* run is
            // before its fan-out and holds admission; see capacity.test.ts.)
            { id: 2, status: "waiting", ...OTHER },
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
          budget,
        );
      // Main demand 45 exceeds the 40 reserve; production and PR ci.yml runs are other demand.
      const fits = busy("66");
      expect(await fits.mainBusy()).toBe(false);
      expect(fits.lastHeadroom).toMatchObject({ occupied: 48, reservedMain: 45 });
      const tight = busy("65");
      expect(await tight.mainBusy()).toBe(false);
      expect(tight.lastHeadroom).toMatchObject({ occupied: 48, reservedMain: 45 });
      // An idle main run never shrinks the configured reserve.
      const quiet = reader(
        [
          { id: 1, status: "queued", ...MAIN },
          { id: 3, status: "queued", ...MAIN, head_branch: "production" },
        ],
        // Fan-out already instantiated (more than the 3 pre-plan jobs listed).
        {
          1: page(jobs("waiting", "waiting", "completed", "completed")),
          3: page(jobs("queued", "in_progress")),
        },
      );
      expect(await quiet.mainBusy()).toBe(false);
      expect(quiet.lastHeadroom).toMatchObject({ occupied: 2, reservedMain: 40 });
    });
    test.each([
      ["unknown job status", page(jobs("in_progress", "action_required")), "Unrecognized"],
      ["missing job status", page(jobs("queued", undefined)), "Unrecognized"],
      [
        "complete job page above the 100-row bound",
        { total_count: 101, jobs: jobs(...Array(101).fill("completed")) },
        "Incomplete",
      ],
      ["truncated job page", { total_count: 2, jobs: jobs("queued") }, "Incomplete"],
      ["malformed job page", { total_count: 0 }, "Incomplete"],
    ] as const)("%s holds", async (_name, jobPage, reason) => {
      const r = reader([{ id: 2, status: "queued", ...OTHER }], { 2: jobPage }, "1000");
      expect(await r.mainBusy()).toBe(true);
      expect(r.lastHeadroom?.reason).toContain(reason);
      expect(r.lastHeadroom?.allowed).toBe(false);
    });
    test("idle run volume is allowed but malformed inventories still hold", async () => {
      const idle = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + 1, page([])]));
      const many = Array.from({ length: 33 }, (_, i) => ({
        id: i + 1,
        status: "queued",
        ...OTHER,
      }));
      const tooMany = reader(many, idle, "1000");
      expect(await tooMany.mainBusy()).toBe(false);
      expect(tooMany.lastHeadroom?.scannedRuns).toBe(33);
      const invalid = reader([{ id: 0, status: "queued", ...OTHER }], idle, "1000");
      expect(await invalid.mainBusy()).toBe(true);
      expect(invalid.lastHeadroom?.reason).toContain("Invalid active run");
      const truncated = reader([], idle, "1000", () => ({ total_count: 1, workflow_runs: [] }));
      expect(await truncated.mainBusy()).toBe(true);
      expect(truncated.lastHeadroom?.reason).toContain("Incomplete");
      const oversized = reader([], idle, "1000", () => ({
        total_count: 101,
        workflow_runs: Array.from({ length: 101 }, (_, i) => ({ id: i + 1, status: "queued" })),
      }));
      expect(await oversized.mainBusy()).toBe(true);
      expect(oversized.lastHeadroom?.reason).toContain("Incomplete");
      const batch = reader(
        [{ id: 7, status: "waiting", ...OTHER, path: ".github/workflows/batch-ci.yml" }],
        { 7: page([]) },
        "1000",
      );
      expect(await batch.mainBusy()).toBe(true);
      expect(batch.lastHeadroom?.reason).toContain("single candidate");
    });
  });
  describe("proven approval-only runs are excluded from the 32-run runner cap", () => {
    type WirePage = Record<string, unknown> | unknown[];
    const MAIN = { head_branch: "main", path: ".github/workflows/ci.yml", event: "push" };
    const OTHER = { head_branch: "feature", path: ".github/workflows/other.yml", event: "push" };
    const jobs = (...statuses: unknown[]) =>
      statuses.map((status) => (status === undefined ? {} : { status }));
    const page = (list: unknown[]): WirePage => ({ total_count: list.length, jobs: list });
    type Fixture = {
      id: number;
      run: Record<string, unknown>;
      jobs: WirePage | (() => WirePage) | "provider-error";
    };
    let nextId = 1;
    const runs = (count: number, status: string, base: object, jobPage: Fixture["jobs"]) =>
      Array.from({ length: count }, (): Fixture => {
        const id = nextId++;
        return { id, run: { id, status, ...base }, jobs: jobPage };
      });
    // Old main reruns waiting on environment approval: the gated job waits and
    // the latest attempt of every other job is completed.
    const approvalMain = (count: number) =>
      runs(count, "waiting", MAIN, page(jobs("waiting", "completed", "completed")));
    const approvalOther = (count: number) =>
      runs(count, "waiting", OTHER, page(jobs("waiting", "pending")));
    const busyOther = (count: number) =>
      runs(count, "queued", OTHER, page(jobs("in_progress", "completed")));
    const idleOther = (count: number) =>
      runs(count, "queued", OTHER, page(jobs("pending", "completed")));
    // Production allocation: 52 runners, 30 reserved for full main CI, 18 candidate slots.
    const reader = (fixtures: Fixture[], budget = "52", reserve = "30") => {
      const requests: string[] = [];
      const cfg = config({
        BATCHER_MODE: "active",
        BATCHER_RUNNER_BUDGET: budget,
        BATCHER_MAIN_RESERVE: reserve,
      });
      const transport = (async (url: string | URL | Request) => {
        const text = String(url);
        requests.push(text);
        const jobsMatch = /\/runs\/(\d+)\/jobs\?/.exec(text);
        if (jobsMatch) {
          const subject = fixtures.find((entry) => entry.id === Number(jobsMatch[1]))!;
          if (subject.jobs === "provider-error") return new Response("down", { status: 502 });
          return Response.json(typeof subject.jobs === "function" ? subject.jobs() : subject.jobs);
        }
        const status = new URL(text).searchParams.get("status")!;
        const listed = fixtures.filter((entry) => entry.run.status === status);
        return Response.json({
          total_count: listed.length,
          workflow_runs: listed.map((entry) => entry.run),
        });
      }) as typeof fetch;
      return { requests, github: new GitHubReader(cfg, new GitHubAuth({}), transport) };
    };
    test("approval-only proof requires a waiting run and a complete idle job set", () => {
      const waitingRun = { id: 1, status: "waiting" };
      const cases: Array<[unknown, unknown[], boolean]> = [
        [waitingRun, jobs("waiting"), true],
        [waitingRun, jobs("waiting", "completed", "completed"), true],
        [waitingRun, jobs("waiting", "pending", "completed"), true],
        [waitingRun, [], false],
        [waitingRun, jobs("completed"), false],
        [waitingRun, jobs("pending", "completed"), false],
        [waitingRun, jobs("waiting", "queued"), false],
        [waitingRun, jobs("waiting", "in_progress"), false],
        [waitingRun, jobs("waiting", "requested"), false],
        [waitingRun, jobs("waiting", "action_required"), false],
        [waitingRun, jobs("waiting", undefined), false],
        [waitingRun, [null, ...jobs("waiting")], false],
        [{ id: 1, status: "queued" }, jobs("waiting"), false],
        [{ id: 1, status: "in_progress" }, jobs("waiting", "completed"), false],
        [{ id: 1, status: "pending" }, jobs("waiting"), false],
        [{ id: 1 }, jobs("waiting"), false],
        [null, jobs("waiting"), false],
      ];
      for (const [run, list, expected] of cases)
        expect([run, list, approvalOnlyRun(run, list)]).toEqual([run, list, expected]);
    });
    test("12 waiting runs (10 old main reruns) plus active runs crossing 32 are admitted", async () => {
      nextId = 1;
      const fixtures = [
        ...approvalMain(10),
        ...approvalOther(2),
        ...busyOther(4),
        ...idleOther(21),
      ];
      // Negative control: the previous readers held on 37 distinct active runs before reading jobs.
      expect(fixtures.length).toBeGreaterThan(32);
      const fits = reader(fixtures);
      expect(await fits.github.mainBusy()).toBe(false);
      expect(fits.github.lastHeadroom).toMatchObject({
        allowed: true,
        budget: 52,
        occupied: 4,
        reservedMain: 30,
        candidateSlots: 18,
        scannedRuns: 37,
        approvalOnlyRuns: 12,
      });
      // Every run's complete job page is read: 2 x 5 run-list pages plus 37 job pages.
      expect(fits.requests.length).toBe(10 + 37);
      // Budget arithmetic is unchanged: one more busy runner exceeds 4 + 30 + 18 = 52.
      nextId = 1;
      const tight = reader([
        ...approvalMain(10),
        ...approvalOther(2),
        ...busyOther(5),
        ...idleOther(20),
      ]);
      expect(await tight.github.mainBusy()).toBe(false);
      expect(tight.github.lastHeadroom).toMatchObject({
        allowed: true,
        capacityInformational: true,
        occupied: 5,
        approvalOnlyRuns: 12,
      });
      // More than 32 idle non-approval runs do not create a volume-only hold.
      nextId = 1;
      const crossing = reader([...approvalMain(10), ...approvalOther(2), ...idleOther(33)], "1000");
      expect(await crossing.github.mainBusy()).toBe(false);
      expect(crossing.github.lastHeadroom).toMatchObject({ scannedRuns: 45, occupied: 0 });
      nextId = 1;
      const atCap = reader([...approvalMain(10), ...approvalOther(2), ...idleOther(32)], "1000");
      expect(await atCap.github.mainBusy()).toBe(false);
      expect(atCap.github.lastHeadroom).toMatchObject({ scannedRuns: 44, approvalOnlyRuns: 12 });
    });
    test("more than 32 proven approval-only runs accumulate without holding", async () => {
      nextId = 1;
      const forty = reader(approvalMain(40));
      expect(await forty.github.mainBusy()).toBe(false);
      expect(forty.github.lastHeadroom).toMatchObject({
        allowed: true,
        occupied: 0,
        reservedMain: 30,
        scannedRuns: 40,
        approvalOnlyRuns: 40,
      });
      // Former 64-run boundary is not an admission limit.
      nextId = 1;
      const bound = reader(approvalMain(64));
      expect(await bound.github.mainBusy()).toBe(false);
      expect(bound.github.lastHeadroom?.approvalOnlyRuns).toBe(64);
      expect(bound.requests.length).toBe(10 + 64);
      // Every one of 65 runs is observed, rather than holding before job reads.
      nextId = 1;
      const over = reader(approvalMain(65));
      expect(await over.github.mainBusy()).toBe(false);
      expect(over.github.lastHeadroom).toMatchObject({ allowed: true, scannedRuns: 65 });
      expect(over.requests.length).toBe(75);
    });
    test("an approval-waiting run that becomes queued counts toward demand and the cap", async () => {
      nextId = 1;
      let approved = false;
      const transition: Fixture = {
        id: 1000,
        run: { id: 1000, status: "waiting", ...MAIN },
        jobs: () =>
          approved
            ? page(jobs("queued", "queued", "completed", "completed"))
            : page(jobs("waiting", "waiting", "completed")),
      };
      const fixtures = [transition, ...idleOther(32)];
      const before = reader(fixtures, "1000");
      expect(await before.github.mainBusy()).toBe(false);
      expect(before.github.lastHeadroom).toMatchObject({ occupied: 0, approvalOnlyRuns: 1 });
      // Approval granted: the run status may still read waiting while jobs queue.
      approved = true;
      const after = reader(fixtures, "1000");
      expect(await after.github.mainBusy()).toBe(false);
      expect(after.github.lastHeadroom?.capacity?.hold).toBe("main-queued");
      // With room under the cap, the queued main jobs are main demand, and
      // because they wait for runners on the newest main run, admission holds.
      const roomy = reader([transition, ...idleOther(3)], "1000");
      expect(await roomy.github.mainBusy()).toBe(false);
      expect(roomy.github.lastHeadroom).toMatchObject({ occupied: 2, approvalOnlyRuns: 0 });
      expect(roomy.github.lastHeadroom?.capacity?.hold).toBe("main-queued");
      transition.run.status = "queued";
      const queued = reader([transition, ...idleOther(3)], "1000");
      expect(await queued.github.mainBusy()).toBe(false);
      expect(queued.github.lastHeadroom).toMatchObject({ occupied: 2, approvalOnlyRuns: 0 });
      expect(queued.github.lastHeadroom?.capacity?.latestMain).toMatchObject({
        runId: 1000,
        queuedJobs: 2,
      });
    });
    test("mixed, job-less and non-waiting runs are never treated as approval-only", async () => {
      const mixed: Array<[string, string, unknown[], number]> = [
        ["waiting run with a queued job", "waiting", ["waiting", "queued"], 1],
        ["waiting run with an in-progress job", "waiting", ["waiting", "in_progress"], 1],
        ["waiting run with a requested job", "waiting", ["waiting", "requested"], 1],
        ["waiting run without materialized jobs", "waiting", [], 0],
        ["waiting run with only completed jobs", "waiting", ["completed"], 0],
        ["queued run whose jobs wait for approval", "queued", ["waiting"], 0],
        ["in-progress run with a waiting job", "in_progress", ["waiting", "completed"], 0],
      ];
      for (const [name, status, statuses, demand] of mixed) {
        // 31 runner-relevant runs plus the subject fit exactly; demand is counted.
        nextId = 1;
        const fits = reader(
          [
            ...runs(1, status, OTHER, page(jobs(...statuses))),
            ...idleOther(31),
            ...approvalMain(5),
          ],
          "1000",
        );
        expect([name, await fits.github.mainBusy()]).toEqual([name, false]);
        expect([name, fits.github.lastHeadroom]).toMatchObject([
          name,
          { occupied: demand, approvalOnlyRuns: 5, scannedRuns: 37 },
        ]);
        // With 32 other idle runs, the subject's demand is still accounted for.
        nextId = 1;
        const over = reader(
          [
            ...runs(1, status, OTHER, page(jobs(...statuses))),
            ...idleOther(32),
            ...approvalMain(5),
          ],
          "1000",
        );
        expect([name, await over.github.mainBusy()]).toEqual([name, false]);
        expect([name, over.github.lastHeadroom]).toMatchObject([
          name,
          { occupied: demand, approvalOnlyRuns: 5, scannedRuns: 38 },
        ]);
      }
    });
    test("unknown statuses, incomplete pages and provider errors in approval runs hold", async () => {
      const holds: Array<[string, WirePage, string]> = [
        ["unknown job status", page(jobs("waiting", "action_required")), "Unrecognized"],
        ["missing job status", page(jobs("waiting", undefined)), "Unrecognized"],
        [
          "truncated job page",
          { total_count: 3, jobs: jobs("waiting", "completed") },
          "Incomplete",
        ],
        [
          "oversized job page",
          { total_count: 101, jobs: jobs("waiting", ...Array(100).fill("completed")) },
          "Incomplete",
        ],
        ["malformed job page", { jobs: jobs("waiting") }, "Incomplete"],
        ["array job page", [], "Incomplete"],
      ];
      for (const [name, jobPage, reason] of holds) {
        nextId = 1;
        const r = reader([...approvalMain(40), ...runs(1, "waiting", MAIN, jobPage)], "1000");
        expect([name, await r.github.mainBusy()]).toEqual([name, true]);
        expect([name, r.github.lastHeadroom?.reason]).toEqual([
          name,
          expect.stringContaining(reason),
        ]);
      }
      // Provider errors on a job page or a run-list page reject; callers hold.
      nextId = 1;
      const jobError = reader([...approvalMain(3), ...runs(1, "waiting", MAIN, "provider-error")]);
      await expect(jobError.github.mainBusy()).rejects.toThrow();
      const listError = new GitHubReader(
        config({ BATCHER_MODE: "active", BATCHER_RUNNER_BUDGET: "52", BATCHER_MAIN_RESERVE: "30" }),
        new GitHubAuth({}),
        (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
      );
      await expect(listError.mainBusy()).rejects.toThrow();
    });
    // A run whose status flips once during the inventory listing, served by a
    // transport that changes the run after the first listing of `flipAfter`.
    const flipping = (
      from: string,
      to: string,
      flipAfter: string,
      base: object,
      jobPage: WirePage,
      budget = "52",
      reserve = "30",
      others: Fixture[] = [],
    ) => {
      const subject = { id: 5000, status: from, ...base };
      let flipped = false;
      const requests: string[] = [];
      const transport = (async (url: string | URL | Request) => {
        const text = String(url);
        requests.push(text);
        const jobsMatch = /\/runs\/(\d+)\/jobs\?/.exec(text);
        if (jobsMatch) {
          if (Number(jobsMatch[1]) === subject.id) return Response.json(jobPage);
          const other = others.find((entry) => entry.id === Number(jobsMatch[1]))!;
          return Response.json(other.jobs);
        }
        const status = new URL(text).searchParams.get("status")!;
        const current = { ...subject, status: flipped ? to : from };
        const listed = [
          ...others.map((entry) => entry.run).filter((run) => run.status === status),
          ...(current.status === status ? [current] : []),
        ];
        if (status === flipAfter) flipped = true;
        return Response.json({ total_count: listed.length, workflow_runs: listed });
      }) as typeof fetch;
      const github = new GitHubReader(
        config({
          BATCHER_MODE: "active",
          BATCHER_RUNNER_BUDGET: budget,
          BATCHER_MAIN_RESERVE: reserve,
        }),
        new GitHubAuth({}),
        transport,
      );
      return { github, requests };
    };
    test("a run moving backwards between page reads is listed by the second pass", async () => {
      // in_progress -> waiting right after the waiting page: one pass would miss
      // the run entirely (waiting read too early, in_progress read too late).
      const running = page(jobs(...Array(20).fill("in_progress"), "waiting"));
      const other = flipping("in_progress", "waiting", "waiting", OTHER, running);
      expect(await other.github.mainBusy()).toBe(false);
      expect(other.github.lastHeadroom).toMatchObject({
        allowed: true,
        capacityInformational: true,
        occupied: 20,
        reservedMain: 30,
        scannedRuns: 1,
        approvalOnlyRuns: 0,
      });
      expect(other.requests.length).toBe(10 + 1);
      // Main demand above the reserve is likewise observed: max(30, 35) + 18 > 52.
      const mainRun = flipping(
        "in_progress",
        "waiting",
        "waiting",
        MAIN,
        page(jobs(...Array(35).fill("in_progress"), "waiting")),
      );
      expect(await mainRun.github.mainBusy()).toBe(false);
      expect(mainRun.github.lastHeadroom).toMatchObject({ occupied: 35, reservedMain: 35 });
      // queued -> waiting and in_progress -> queued flips are observed too.
      for (const [from, to] of [
        ["queued", "waiting"],
        ["in_progress", "queued"],
      ] as const) {
        const flip = flipping(from, to, to, OTHER, running);
        expect([from, to, await flip.github.mainBusy()]).toEqual([from, to, false]);
        expect(flip.github.lastHeadroom).toMatchObject({ occupied: 20, scannedRuns: 1 });
      }
      // Approval to queued during the listing: demand is counted.
      const approved = flipping(
        "waiting",
        "queued",
        "waiting",
        OTHER,
        page(jobs(...Array(5).fill("queued"), "completed")),
      );
      expect(await approved.github.mainBusy()).toBe(false);
      expect(approved.github.lastHeadroom).toMatchObject({ occupied: 5, approvalOnlyRuns: 0 });
      // A run listed with a non-waiting status in any listing is never
      // approval-only, even when its later listing and job page look idle.
      nextId = 1;
      const settling = flipping(
        "in_progress",
        "waiting",
        "in_progress",
        OTHER,
        page(jobs("waiting", "completed")),
        "1000",
        "30",
        idleOther(32),
      );
      expect(await settling.github.mainBusy()).toBe(false);
      expect(settling.github.lastHeadroom).toMatchObject({ approvalOnlyRuns: 0, scannedRuns: 33 });
      nextId = 1;
      const steady = flipping(
        "waiting",
        "waiting",
        "waiting",
        OTHER,
        page(jobs("waiting", "completed")),
        "1000",
        "30",
        idleOther(32),
      );
      expect(await steady.github.mainBusy()).toBe(false);
      expect(steady.github.lastHeadroom).toMatchObject({ approvalOnlyRuns: 1, scannedRuns: 33 });
    });
    test("a response arriving after the deadline holds, including the last one", async () => {
      const oneRun = (slowPath: RegExp, delay: number) => {
        let clock = 0;
        const get = async (path: string) => {
          if (slowPath.test(path)) clock += delay;
          if (/\/jobs\?/.test(path)) return page(jobs("in_progress"));
          const status = new URLSearchParams(path.split("?")[1]).get("status");
          const list = status === "queued" ? [{ id: 1, status: "queued", ...OTHER }] : [];
          return { total_count: list.length, workflow_runs: list };
        };
        return scanRunnerDemand({
          get,
          batchWorkflow: "batch.yml",
          baseBranch: "main",
          now: () => clock,
        });
      };
      // The only (last) job page arrives late, before ordered reduction starts.
      expect(await oneRun(/\/jobs\?/, ACTIVE_RUN_SCAN_DEADLINE_MS + 1)).toMatchObject({
        ok: false,
        hold: "deadline",
        scannedRuns: 0,
      });
      expect(await oneRun(/\/jobs\?/, ACTIVE_RUN_SCAN_DEADLINE_MS)).toMatchObject({ ok: true });
      // With no active runs, the last run-list page arriving late also holds.
      let clock = 0,
        lists = 0;
      const zero = await scanRunnerDemand({
        get: async () => {
          if (++lists === 10) clock += ACTIVE_RUN_SCAN_DEADLINE_MS + 1;
          return { total_count: 0, workflow_runs: [] };
        },
        batchWorkflow: "batch.yml",
        baseBranch: "main",
        now: () => clock,
      });
      expect(zero).toMatchObject({ ok: false, hold: "deadline", scannedRuns: 0 });
      expect(lists).toBe(10);
      // A slow middle run-list page holds before the next request.
      clock = 0;
      lists = 0;
      const middle = await scanRunnerDemand({
        get: async () => {
          if (++lists === 3) clock += ACTIVE_RUN_SCAN_DEADLINE_MS + 1;
          return { total_count: 0, workflow_runs: [] };
        },
        batchWorkflow: "batch.yml",
        baseBranch: "main",
        now: () => clock,
      });
      expect(middle).toMatchObject({ ok: false, hold: "deadline" });
      expect(lists).toBe(3);
    });
    test("pure scan enforces separate request, scan and deadline bounds", async () => {
      const listed = (statusRuns: Record<string, unknown[]>) => {
        const requests: string[] = [];
        const get = async (path: string) => {
          requests.push(path);
          if (/^actions\/runs\/\d+\/jobs\?/.test(path)) return page(jobs("waiting", "completed"));
          const status = new URLSearchParams(path.split("?")[1]).get("status")!;
          const list = statusRuns[status] ?? [];
          return { total_count: list.length, workflow_runs: list };
        };
        return { requests, get };
      };
      const scan = (get: (path: string) => Promise<unknown>, extra: object = {}) =>
        scanRunnerDemand({ get, batchWorkflow: "batch.yml", baseBranch: "main", ...extra });
      const waiting = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        status: "waiting",
        ...MAIN,
      }));
      const ok = listed({ waiting });
      expect(await scan(ok.get)).toEqual({
        ok: true,
        mainDemand: 0,
        otherDemand: 0,
        scannedRuns: 10,
        approvalOnlyRuns: 10,
        cachedApprovalOnlyRuns: 0,
        runnerRelevantRuns: 0,
        latestMain: {
          runId: 10,
          queuedJobs: 0,
          oldestQueuedSeconds: null,
          maxStartWaitSeconds: null,
        },
        mainQueuedJobs: 0,
        preFanoutMainRuns: [],
      });
      // The wall-clock deadline holds mid-scan instead of admitting partial demand.
      let clock = 0;
      const slow = listed({ waiting });
      const timed = await scan(
        async (path) => {
          clock += 20_000;
          return slow.get(path);
        },
        { now: () => clock },
      );
      expect(timed).toMatchObject({ ok: false, hold: "deadline" });
      expect(clock).toBeLessThanOrEqual(ACTIVE_RUN_SCAN_DEADLINE_MS + 20_000);
      expect(slow.requests.length).toBeLessThan(10 + waiting.length);
      // Duplicate listings of one run (status changed between pages) are scanned once.
      expect(await scan(listed({ queued: [waiting[0]], waiting }).get)).toMatchObject({
        ok: true,
        scannedRuns: 10,
      });
      // A run approved between the waiting and queued page reads is listed as
      // queued; its jobs are demand and it is not approval-only.
      let approvedAfterWaitingPage = false;
      const order: string[] = [];
      const raced = await scan(async (path) => {
        if (/^actions\/runs\/1\/jobs\?/.test(path))
          return page(jobs(approvedAfterWaitingPage ? "queued" : "waiting"));
        const status = new URLSearchParams(path.split("?")[1]).get("status")!;
        order.push(status);
        const run = { id: 1, status: approvedAfterWaitingPage ? "queued" : "waiting", ...MAIN };
        const list = run.status === status ? [run] : [];
        if (status === "waiting") approvedAfterWaitingPage = true;
        return { total_count: list.length, workflow_runs: list };
      });
      const statuses = ["requested", "pending", "waiting", "queued", "in_progress"];
      expect(order).toEqual([...statuses, ...statuses]);
      expect(raced).toEqual({
        ok: true,
        mainDemand: 1,
        otherDemand: 0,
        scannedRuns: 1,
        approvalOnlyRuns: 0,
        cachedApprovalOnlyRuns: 0,
        runnerRelevantRuns: 1,
        latestMain: {
          runId: 1,
          queuedJobs: 1,
          oldestQueuedSeconds: null,
          maxStartWaitSeconds: null,
        },
        // One queued job: the newly approved run has not instantiated its fan-out.
        mainQueuedJobs: 1,
        preFanoutMainRuns: [1],
      });
      // Completed runs listed between pages are not scanned; invalid identities hold.
      expect(
        await scan(listed({ waiting: [...waiting, { id: 77, status: "completed", ...MAIN }] }).get),
      ).toMatchObject({ ok: true, scannedRuns: 10 });
      for (const id of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1])
        expect(
          await scan(listed({ waiting: [{ id, status: "waiting", ...MAIN }] }).get),
        ).toMatchObject({ ok: false, hold: "invalid-run" });
      expect(await scan(listed({ waiting: [null] }).get)).toMatchObject({
        ok: false,
        hold: "invalid-run",
      });
      // A waiting Batch CI run still occupies the single candidate slot.
      expect(
        await scan(
          listed({ waiting: [...waiting, { id: 88, status: "waiting", path: "batch.yml" }] }).get,
        ),
      ).toMatchObject({ ok: false, hold: "batch-slot" });
      // Provider errors propagate to the caller rather than being treated as free.
      await expect(
        scan(async (path) => {
          if (path.includes("/jobs?")) throw new Error("provider unavailable");
          return ok.get(path);
        }),
      ).rejects.toThrow("provider unavailable");
      for (const runPage of [
        null,
        [],
        { total_count: 1, workflow_runs: [] },
        { workflow_runs: [] },
      ])
        expect(await scan(async () => runPage)).toMatchObject({
          ok: false,
          hold: "incomplete-runs",
        });
    });
  });
  test("recovery CLI requires explicit active configuration and confirmation before auth", async () => {
    await expect(main(["recover-effect"], {})).rejects.toThrow("requires active mode");
    await expect(
      main(["recover-effect", "--effect-id", "a".repeat(64), "--state-sha", "b".repeat(40)], {
        BATCHER_MODE: "active",
      }),
    ).rejects.toThrow("confirm-not-applied");
    expect(config({}).mode).toBe("shadow");
    expect(config({ BATCHER_MODE: "active" }).branchPrefix).toBe("queue/live/");
  });
  test("missing-run abandonment is Git-backed and explicit recovery releases only infrastructure slot", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    const published = (await f.state()).ledger.stages[manifest.batchId];
    expect(published?.builtAt).toBe(NOW);
    expect(published?.publishedAt).toBe(NOW);
    f.advance(7200);
    await f.controller().step();
    const state = await f.state();
    expect(state.ledger.missingRuns[manifest.batchId]?.status).toBe("abandoned");
    expect(state.ledger.ejected).toEqual([]);
    await expect(
      f.executor().recoverMissingRun(manifest.batchId, state.sha!, false),
    ).rejects.toThrow("confirmation");
    await f.executor().recoverMissingRun(manifest.batchId, state.sha!, true);
    await f.controller().step();
    expect((await f.state()).ledger.invalidated).toContain(manifest.batchId);
    expect((await f.controller().step()).action.kind).toBe("wait");
    f.api.pulls[0]!.binding.eventId = "explicit-re-ready";
    const next = await f.publish();
    expect(next.batchId).not.toBe(manifest.batchId);
  });
  test("missing-run deadline uses the injected publication clock across controller restarts", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    expect(f.cfg.missingRunSeconds).toBe(900);
    f.advance(899);
    await f.controller().step();
    expect((await f.state()).ledger.missingRuns[manifest.batchId]?.status).toBe("holding");
    f.advance(1);
    await f.controller().step();
    expect((await f.state()).ledger.missingRuns[manifest.batchId]?.status).toBe("abandoned");
    expect((await f.state()).ledger.stages[manifest.batchId]?.publishedAt).toBe(NOW);
  });
  test("head invalidation before workflow admission cannot publish a second candidate", async () => {
    const f = await fixture(),
      old = await f.publish();
    f.change();
    await f.controller().step();
    expect((await f.state()).ledger.invalidated).toContain(old.batchId);
    for (let i = 0; i < 3; i++) {
      const step = await f.controller().step();
      expect(step.action.kind).toBe("build");
      if (step.action.kind === "build") expect(step.action.publish).toBe(false);
    }
    const branches = [...(await f.git.remoteRefs(f.origin.dir)).keys()].filter((ref) =>
      ref.startsWith(`refs/heads/${f.cfg.branchPrefix}`),
    );
    expect(branches).toHaveLength(1);
    const late = f.verdict(old, "infrastructure");
    late.status = "queued";
    // Refresh the archived sample explicitly rather than waiting out its cache
    // interval; separate history tests cover expiry and rotating late discovery.
    await f.api.observedRuns(old, `${f.cfg.branchPrefix}${old.batchId}`, false);
    const queued = await f.controller().step();
    expect(queued.action.kind).toBe("build");
    if (queued.action.kind === "build") expect(queued.action.publish).toBe(false);
    late.status = "completed";
    const next = await f.controller().step();
    expect(next.action.kind).toBe("build");
    if (next.action.kind === "build") expect(next.action.publish).toBe(true);
    expect(next.manifest?.batchId).not.toBe(old.batchId);
    expect(
      [...(await f.git.remoteRefs(f.origin.dir)).keys()].filter((ref) =>
        ref.startsWith(`refs/heads/${f.cfg.branchPrefix}`),
      ),
    ).toHaveLength(2);
  });
  test("landed missing history has durable audited recovery after cache loss without releasing late CI", async () => {
    const f = await fixture(),
      old = await f.publish();
    f.verdict(old);
    expect((await f.controller().step()).action.kind).toBe("land");
    f.api.workflowRuns = [];
    f.api.cache.get = async () => null; // Disposable provider cache is unavailable after restart.
    f.change();
    const blocked = await f.controller().step();
    expect(blocked.action.kind).toBe("build");
    if (blocked.action.kind === "build") expect(blocked.action.publish).toBe(false);
    expect((await f.state()).ledger.missingRuns[old.batchId]).toMatchObject({
      kind: "historical-run-history",
      status: "holding",
      firstSeenAt: NOW,
    });
    f.advance(900);
    await f.controller().step();
    const held = await f.state();
    expect(held.ledger.missingRuns[old.batchId]?.status).toBe("abandoned");
    await expect(f.executor().recoverMissingRun(old.batchId, held.sha!, false)).rejects.toThrow(
      "confirmation",
    );
    await expect(f.executor().recoverMissingRun(old.batchId, "a".repeat(40), true)).rejects.toThrow(
      "CAS",
    );
    const late = f.verdict(old, "unknown");
    late.status = "queued";
    await expect(f.executor().recoverMissingRun(old.batchId, held.sha!, true)).rejects.toThrow(
      "provider run",
    );
    f.api.workflowRuns = [];
    await f.executor().recoverMissingRun(old.batchId, held.sha!, true);
    const recovered = await f.state();
    expect(recovered.sha).not.toBe(held.sha);
    expect(recovered.ledger.missingRuns[old.batchId]).toMatchObject({
      status: "released",
      kind: "historical-run-history",
      recovery: {
        confirmedNoRun: true,
        controllerId: "controller-a",
        tipSha: old.tipSha,
        previousStateSha: held.sha,
      },
    });
    // The release remains Git-backed if the disposable journal also disappears.
    await rm(f.controller().journal.path, { force: true });
    f.api.workflowRuns = [late];
    const stillBusy = await f.controller().step();
    expect(stillBusy.action.kind).toBe("build");
    if (stillBusy.action.kind === "build") expect(stillBusy.action.publish).toBe(false);
    late.status = "completed";
    const next = await f.controller().step();
    expect(next.action.kind).toBe("build");
    if (next.action.kind === "build") expect(next.action.publish).toBe(true);
    expect((await f.state()).ledger.missingRuns[old.batchId]?.recovery).toEqual(
      recovered.ledger.missingRuns[old.batchId]?.recovery,
    );
    expect((await f.state()).ledger.ejected).toEqual([]);
  });
  test("failed landing does not record fabricated measured landed time", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    f.verdict(manifest);
    f.git.beforePush = async () => {
      await f.origin.exec(["update-ref", "refs/heads/main", f.divergent]);
    };
    const controller = f.controller();
    await expect(controller.step()).rejects.toThrow();
    expect((await controller.journal.records(NOW)).stages[manifest.batchId]?.landedAt).toBeNull();
    expect((await f.state()).ledger.stages[manifest.batchId]?.landedAt).toBeNull();
  });
  test("latency alert does not hold an already-durable whole-run retry intent", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    f.verdict(manifest, "infrastructure");
    f.advance(61);
    expect((await f.controller().step()).action.kind).toBe("retry");
    await f.seed((ledger) => {
      ledger.stages[manifest.batchId]!.ciStartedAt = "2026-10-21T12:40:00Z";
    });
    f.advance(3601);
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("done");
  });
  test("auto-merged original gets one durable follow-up, with no inherited evidence or readiness", async () => {
    const f = await mergedOriginalWithDelta();
    await f.executor().maintain();
    expect(f.api.followups).toHaveLength(1);
    expect(f.api.followups[0]?.headSha).toBe(f.newer);
    expect(f.api.followups[0]?.body).toContain("NOT been tested");
    f.advance(180);
    await f.executor().maintain();
    const record = (await f.state()).ledger.landings[`${f.manifest.batchId}:1`]!;
    expect(record.status).toBe("followup-open");
    expect(record.followupNumber).toBe(2);
    expect((await f.controller().step()).manifest).toBeNull();
    expect(f.api.pulls).toEqual([]);
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(1);
  });
  test("existing exact-source open PR is reused without duplicate creation", async () => {
    const f = await mergedOriginalWithDelta();
    f.api.followups.push({
      number: 99,
      headSha: f.newer,
      sourceRepository: f.cfg.repository,
      sourceRef: "feature",
      state: "open",
      merged: false,
      body: "Existing human-created follow-up",
    });
    f.advance(180);
    await f.executor().maintain();
    expect((await f.state()).ledger.landings[`${f.manifest.batchId}:1`]?.followupNumber).toBe(99);
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(0);
  });
  test("accepted create with lost response reconciles marker after restart without second POST", async () => {
    const f = await mergedOriginalWithDelta();
    f.api.response = "lost";
    await f.executor().maintain();
    expect(f.api.followups).toHaveLength(1);
    f.api.response = "ok";
    f.advance(180);
    await f.executor().maintain();
    expect((await f.state()).ledger.landings[`${f.manifest.batchId}:1`]?.status).toBe(
      "followup-open",
    );
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(1);
  });
  test("provider denial leaves precise blocked recovery instead of claiming newer work is open", async () => {
    const f = await mergedOriginalWithDelta();
    f.api.response = "forbidden";
    await f.executor().maintain();
    f.advance(180);
    await f.executor().maintain();
    const record = (await f.state()).ledger.landings[`${f.manifest.batchId}:1`]!;
    expect(record.status).toBe("followup-blocked");
    expect(record.note).toContain("403");
    expect(f.api.followups).toEqual([]);
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(1);
  });
  test("never creates recovery PR for externally closed unmerged original", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    f.verdict(manifest);
    f.git.beforePush = async () => {
      f.api.snapshot.state = "closed";
      f.api.snapshot.merged = false;
      f.api.snapshot.branchHeadSha = f.newer;
      f.api.snapshot.headRepository = f.cfg.repository;
      f.api.pulls = [];
    };
    await f.controller().step();
    f.advance(180);
    await f.executor().maintain();
    expect((await f.state()).ledger.landings[`${manifest.batchId}:1`]?.status).toBe(
      "closed-newer-head",
    );
    expect(
      Object.values((await f.state()).ledger.effects).some((effect) => effect.kind === "followup"),
    ).toBe(false);
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(0);
  });
  test("changed source head before POST supersedes an unsent intent without duplicating PRs", async () => {
    const f = await mergedOriginalWithDelta();
    const next = await f.commit({ base: "base", feature: "old", delta: "new", extra: "later" }, [
      f.newer,
    ]);
    await f.origin.exec(["update-ref", "refs/heads/newest", next]);
    let reads = 0;
    f.api.onSnapshot = () => {
      if (++reads === 2) f.api.snapshot.branchHeadSha = next;
    };
    await f.executor().maintain();
    expect(f.api.followups).toHaveLength(0);
    f.api.onSnapshot = null;
    f.advance(180);
    await f.executor().maintain();
    const effects = Object.values((await f.state()).ledger.effects).filter(
      (e) => e.kind === "followup",
    );
    expect(
      effects.some(
        (e) => e.kind === "followup" && e.request.headSha === next && e.status === "pending",
      ),
    ).toBe(true);
    f.advance(180);
    await f.executor().maintain();
    expect(f.api.followups).toHaveLength(1);
    expect(f.api.followups[0]?.headSha).toBe(next);
  });
  test("create-time branch race is reconciled as untested newer work; closed follow-up is not reopened", async () => {
    const f = await mergedOriginalWithDelta();
    f.api.beforeCreate = () => {
      f.api.snapshot.branchHeadSha = f.divergent;
    };
    await f.executor().maintain();
    // Provider creation is branch-addressed, not SHA-CAS; the receipt marker
    // binds recovery, never an assertion that the newer captured head was tested.
    const effect = Object.values((await f.state()).ledger.effects).find(
      (e) => e.kind === "followup",
    )!;
    expect(effect.kind === "followup" && effect.request.headSha).toBe(f.newer);
    expect(f.api.followups[0]?.headSha).toBe(f.divergent);
    f.api.followups[0]!.state = "closed";
    f.api.beforeCreate = null;
    f.api.snapshot.branchHeadSha = f.newer;
    f.advance(180);
    await f.executor().maintain();
    expect((await f.state()).ledger.landings[`${f.manifest.batchId}:1`]?.status).toBe(
      "followup-blocked",
    );
    expect(f.api.calls.filter((call) => call.endsWith("/pulls"))).toHaveLength(1);
  });
  test("unavailable source branch preserves a blocked newer-work record", async () => {
    const f = await mergedOriginalWithDelta();
    f.api.snapshot.branchHeadSha = null;
    f.advance(180);
    await f.executor().maintain();
    const record = (await f.state()).ledger.landings[`${f.manifest.batchId}:1`]!;
    expect(record.status).toBe("followup-blocked");
    expect(record.currentHeadSha).toBe(f.newer);
    expect(record.note).toContain("source branch is now unavailable");
    expect(f.api.followups).toEqual([]);
  });
  test("provider follow-up adapter binds repository/branch/base and creates no readiness or evidence", async () => {
    const request: FollowupRequest = {
      original: 1,
      sourceRepository: "owner/fork",
      sourceRef: "feature/work",
      headSha: "a".repeat(40),
      landedHeadSha: "b".repeat(40),
      landedMergeSha: "c".repeat(40),
      landedTipSha: "d".repeat(40),
      marker: "<!-- batcher-followup:fixture -->",
      title: "Remaining work",
      body: "Untested newer work",
    };
    const posted: Record<string, unknown>[] = [];
    const settings = config({ BATCHER_MODE: "active", BATCHER_REPOSITORY: "owner/base" });
    const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ number: 5 }, { status: 201 });
      }
      const common = { state: "open", merged: false, body: request.marker, base: { ref: "main" } };
      return Response.json([
        {
          ...common,
          number: 2,
          head: { sha: request.headSha, ref: request.sourceRef, repo: { full_name: "wrong/fork" } },
        },
        {
          ...common,
          number: 3,
          head: {
            sha: request.headSha,
            ref: "wrong",
            repo: { full_name: request.sourceRepository },
          },
        },
        {
          ...common,
          number: 5,
          head: {
            sha: request.headSha,
            ref: request.sourceRef,
            repo: { full_name: request.sourceRepository },
          },
        },
      ]);
    }) as typeof fetch;
    const reader = new GitHubReader(settings, new GitHubAuth({}), transport);
    expect((await reader.findFollowup(request))?.number).toBe(5);
    await new GitHubMutations(reader).createFollowup(request);
    expect(posted[0]).toEqual({
      title: request.title,
      body: request.body,
      head: "owner:feature/work",
      head_repo: "fork",
      base: "main",
      draft: false,
    });
    await expect(
      new GitHubMutations(
        new GitHubReader({ ...settings, mode: "shadow" }, new GitHubAuth({}), transport),
      ).createFollowup(request),
    ).rejects.toThrow("Shadow mode");
  });
});
