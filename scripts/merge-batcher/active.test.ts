import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubActiveExecutor } from "./active";
import { main } from "./main";
import { Controller, LiveReader } from "./controller";
import { AtomicGitWriter, GitStore, type RefUpdate } from "./git";
import {
  GitHubAuth,
  GitHubMutations,
  GitHubReader,
  ProviderError,
  type PullSnapshot,
} from "./github";
import {
  config,
  digest,
  emptyLedger,
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
      return this.comments.some((body) => body.includes(marker));
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
    new Controller(cfg, new ClockReader(api, git, cfg), git, owner, executor(owner));
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
  const publish = async () => {
    const result = await controller().step();
    expect(result.action.kind).toBe("build");
    expect(result.manifest).not.toBeNull();
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
      completedAt: NOW,
    };
    api.workflowRuns.push(run);
    return run;
  };
  return {
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
  test("publishes create-only, lands exact tested tip, reconstructs without duplicate landing", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m);
    expect((await f.controller().step()).action.kind).toBe("land");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(m.tipSha);
    expect((await f.state()).ledger.landings[`${m.batchId}:1`]?.status).toBe("unchanged");
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
    expect((await f.state()).sha).toBeNull();
  });
  test("main headroom blocks hosted publication, retry and landing", async () => {
    const f = await fixture();
    f.api.busy = true;
    const local = await f.controller().step();
    expect(local.manifest).not.toBeNull();
    expect((await f.state()).sha).toBeNull();
    f.api.busy = false;
    const m = await f.publish();
    f.verdict(m, "code_failure");
    f.api.busy = true;
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(f.api.calls).toHaveLength(0);
    f.api.workflowRuns = [];
    f.verdict(m);
    expect((await f.controller().step()).action.kind).toBe("wait");
    expect(await f.origin.exec(["rev-parse", "main"])).toBe(f.base);
  });
  test("whole-run retry lost response is observed by attempt after restart, never duplicated", async () => {
    const f = await fixture(),
      m = await f.publish();
    f.verdict(m, "code_failure");
    expect((await f.controller().step()).action.kind).toBe("retry");
    f.api.response = "lost";
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(1);
    expect(f.api.calls[0]).toEndWith("/rerun");
    f.advance();
    await f.executor().maintain();
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("done");
    expect(f.api.calls).toHaveLength(1);
  });
  test.each(["lost", "forbidden", "unknown"] as const)(
    "comment %s outcome is durable and never blindly repeated",
    async (response) => {
      const f = await fixture();
      await f.seed((l) => {
        l.ejected.push({
          pull: f.makePull(),
          batchId: "a".repeat(64),
          reason: "failure",
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
        reason: "failure",
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
        reason: "failure",
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
        reason: "failure",
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
        reason: "failure",
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
        reason: "failure",
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
      expect(await reader.mainBusy()).toBe(held);
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
  test("latency stop signal also holds an already-durable whole-run retry intent", async () => {
    const f = await fixture(),
      manifest = await f.publish();
    f.verdict(manifest, "code_failure");
    expect((await f.controller().step()).action.kind).toBe("retry");
    await f.seed((ledger) => {
      ledger.stages[manifest.batchId]!.ciStartedAt = "2026-10-21T12:40:00Z";
    });
    f.advance(3601);
    await f.executor().maintain();
    expect(f.api.calls).toHaveLength(0);
    expect(Object.values((await f.state()).ledger.effects)[0]?.status).toBe("pending");
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
