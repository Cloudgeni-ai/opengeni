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
    override async ready() {
      this.onReady?.();
      return { ready: structuredClone(this.pulls), excluded: [] };
    }
    override async runs(_manifest: Manifest, branch: string) {
      return structuredClone(this.workflowRuns.filter((r) => r.branch === branch));
    }
    override async pullSnapshot(_number: number) {
      return { ...this.snapshot };
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
          ? "closed-newer-head"
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
    expect(record.status).toBe("closed-newer-head");
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
  test("headroom reader finds waiting full-main run and ignores other workflow paths", async () => {
    const cfg = config({ BATCHER_MODE: "active" });
    const statuses: string[] = [];
    const transport = (async (url: string | URL | Request) => {
      const status = new URL(String(url)).searchParams.get("status")!;
      statuses.push(status);
      return Response.json({
        workflow_runs: [
          {
            head_branch: "main",
            path: status === "waiting" ? ".github/workflows/ci.yml" : "unrelated.yml",
            event: "push",
            status,
          },
        ],
      });
    }) as typeof fetch;
    expect(await new GitHubReader(cfg, new GitHubAuth({}), transport).mainBusy()).toBe(true);
    expect(statuses).toEqual(["in_progress", "queued", "waiting"]);
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
});
