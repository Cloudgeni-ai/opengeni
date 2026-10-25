import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { markFailurePhase } from "./diagnostics";
import { writeAttempted, writeResolved } from "./cycle-outcome";
import {
  assertSha,
  canonical,
  digest,
  validateSpec,
  type BatchSpec,
  type Ledger,
  type Manifest,
} from "./model";
const TRAILER = "Batch-Manifest: ";
export class GitFailure extends Error {
  constructor(public readonly exitCode: number) {
    super(`Git operation failed (exit ${exitCode}); credentials and remote output suppressed`);
  }
}
export class MergeConflict extends Error {
  constructor(public readonly number: number) {
    super(`Merge conflict in PR #${number}`);
  }
}
export class GitStore {
  constructor(
    readonly dir: string,
    readonly authEnv: Record<string, string> = {},
    readonly fetchTimeoutSeconds = 600,
  ) {}
  async exec(
    args: string[],
    input?: string,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const child = Bun.spawn(["git", "--git-dir", this.dir, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...this.authEnv,
        ...extraEnv,
      },
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), this.commandTimeoutMs(args));
    const [out, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    if (code) throw new GitFailure(code);
    return out.trim();
  }
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.exec(["init", "--bare"]);
  }
  commandTimeoutMs(args: string[]): number {
    return args[0] === "fetch" ? this.fetchTimeoutSeconds * 1000 : 60_000;
  }
  async fetch(
    remote: string,
    refs: string[],
    cache: "state" | "candidate" | "objects" = "objects",
  ): Promise<void> {
    // Raw-SHA fetches without refs cannot advertise their existing history on
    // the next fetch. Main churn then downloads the full history repeatedly.
    // These bounded LOCAL refs are negotiation hints, never queue/state proof.
    // Keep state roots separate so a one-off candidate read cannot evict main.
    const targets = refs.map((ref, index) =>
      /^[a-f0-9]{40}$/.test(ref) && index < 64
        ? `+${ref}:refs/batcher-cache/${cache}/${index}`
        : ref,
    );
    await this.exec([
      "fetch",
      "--atomic",
      "--no-tags",
      "--no-write-fetch-head",
      remote,
      ...targets,
    ]);
  }
  async ancestor(base: string, tip: string): Promise<boolean> {
    try {
      await this.exec(["merge-base", "--is-ancestor", assertSha(base), assertSha(tip)]);
      return true;
    } catch (e) {
      if (e instanceof GitFailure && e.exitCode === 1) return false;
      throw e;
    }
  }
  async mergeTree(left: string, right: string): Promise<string> {
    return assertSha(
      (
        await this.exec([
          "-c",
          "merge.renames=true",
          "-c",
          "merge.renormalize=false",
          "-c",
          "core.autocrlf=false",
          "merge-tree",
          "--write-tree",
          assertSha(left),
          assertSha(right),
        ])
      ).split("\n")[0]!,
    );
  }
  async commit(tree: string, parents: string[], message: string, date: string): Promise<string> {
    return assertSha(
      await this.exec(
        ["commit-tree", assertSha(tree), ...parents.flatMap((p) => ["-p", assertSha(p)])],
        `${message}\n`,
        {
          GIT_AUTHOR_NAME: "Opengeni merge batcher",
          GIT_AUTHOR_EMAIL: "merge-batcher@opengeni.invalid",
          GIT_COMMITTER_NAME: "Opengeni merge batcher",
          GIT_COMMITTER_EMAIL: "merge-batcher@opengeni.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      ),
    );
  }
  async build(raw: BatchSpec): Promise<Manifest> {
    const spec = validateSpec(raw),
      batchId = digest(spec);
    let tip = spec.baseSha;
    const pulls: Manifest["pulls"] = [];
    for (const [index, pull] of spec.pulls.entries()) {
      let tree: string;
      try {
        tree = await this.mergeTree(tip, pull.headSha);
      } catch (e) {
        if (e instanceof GitFailure && e.exitCode === 1) throw new MergeConflict(pull.number);
        throw e;
      }
      tip = await this.commit(
        tree,
        [tip, pull.headSha],
        `Batch ${batchId}: PR #${pull.number} from ${pull.headRef}\n\n${TRAILER}${canonical({ batchId, index, spec })}`,
        spec.createdAt,
      );
      pulls.push({ ...pull, mergeSha: tip });
    }
    return { ...spec, batchId, tipSha: tip, pulls };
  }
  async inspect(tipSha: string): Promise<Manifest> {
    assertSha(tipSha);
    const decode = async (sha: string) => {
      const lines = (await this.exec(["cat-file", "commit", sha])).split("\n");
      const trailers = lines.filter((l) => l.startsWith(TRAILER));
      if (trailers.length !== 1 || trailers[0]!.length > 1_000_000)
        throw new Error("Missing or ambiguous manifest");
      const payload = JSON.parse(trailers[0]!.slice(TRAILER.length)) as {
        batchId: string;
        index: number;
        spec: BatchSpec;
      };
      validateSpec(payload.spec);
      if (digest(payload.spec) !== payload.batchId) throw new Error("Manifest digest mismatch");
      return {
        payload,
        tree: lines.find((l) => l.startsWith("tree "))?.slice(5),
        parents: lines.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7)),
      };
    };
    const {
      payload: { spec, batchId },
    } = await decode(tipSha);
    const pulls: Manifest["pulls"] = [];
    let current = tipSha;
    for (let i = spec.pulls.length - 1; i >= 0; i--) {
      const item = await decode(current),
        pull = spec.pulls[i]!;
      if (
        item.payload.batchId !== batchId ||
        canonical(item.payload.spec) !== canonical(spec) ||
        item.payload.index !== i ||
        item.parents.length !== 2 ||
        item.parents[1] !== pull.headSha
      )
        throw new Error("Invalid exact parent topology");
      const first = item.parents[0]!;
      if ((await this.mergeTree(first, pull.headSha)) !== item.tree)
        throw new Error("Invalid merge tree composition");
      pulls.unshift({ ...pull, mergeSha: current });
      current = first;
    }
    if (current !== spec.baseSha) throw new Error("Manifest base mismatch");
    if ((await this.build(spec)).tipSha !== tipSha) throw new Error("Noncanonical batch commit");
    return { ...spec, batchId, tipSha, pulls };
  }
  async stateCommit(ledger: Ledger, parent: string | null, now: string): Promise<string> {
    const blob = await this.exec(["hash-object", "-w", "--stdin"], canonical(ledger));
    const tree = await this.exec(["mktree"], `100644 blob ${blob}\tstate.json\n`);
    // Lease transaction identity is deliberately unique even for the same owner,
    // ledger and clock tick. Otherwise Git can omit an identical already-current
    // state OID before checking its lease and falsely report two winners.
    // Candidate manifests/commits remain deterministic; only state commits vary.
    return this.commit(
      tree,
      parent ? [parent] : [],
      `Merge batcher state v1\n\nTransaction-ID: ${randomUUID()}`,
      now,
    );
  }
  async readLedger(sha: string): Promise<Ledger> {
    const state = JSON.parse(await this.exec(["show", `${assertSha(sha)}:state.json`])) as Ledger;
    // Additive state fields permit restart from the earlier controller schema.
    state.effects ??= {};
    state.landings ??= {};
    state.stages ??= {};
    state.missingRuns ??= {};
    if (
      state.schemaVersion !== 1 ||
      !Number.isSafeInteger(state.epoch) ||
      !Number.isFinite(Date.parse(state.expiresAt)) ||
      !Array.isArray(state.landed) ||
      !Array.isArray(state.invalidated) ||
      !Array.isArray(state.ejected) ||
      (state.parked !== undefined && !Array.isArray(state.parked)) ||
      !Array.isArray(state.recovery) ||
      !state.retries ||
      !state.codeFailures
    )
      throw new Error("Malformed durable controller state");
    return state;
  }
  async remoteRefs(remote: string): Promise<Map<string, string>> {
    const raw = await this.exec(["ls-remote", "--refs", remote]);
    return new Map(
      raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split("\t");
          return [ref!, assertSha(sha!)];
        }),
    );
  }
}
export interface RefUpdate {
  ref: string;
  expected: string | null;
  next: string;
}
// An unchanged lease is omitted by Git from the wire and is NOT a fence.
export class AtomicGitWriter {
  constructor(
    readonly git: GitStore,
    readonly remote: string,
    readonly stateRef: string,
    readonly baseRef: string,
  ) {}
  async transaction(updates: RefUpdate[]): Promise<void> {
    if (this.stateRef === this.baseRef) throw new Error("State fence must never be main");
    const fence = updates.find((u) => u.ref === this.stateRef);
    if (!fence || fence.next === fence.expected)
      throw new Error("A changing durable fence is required");
    if (new Set(updates.map((u) => u.ref)).size !== updates.length)
      throw new Error("Duplicate transaction refs");
    for (const u of updates) {
      if (!/^refs\/heads\/[\w/-]+$/.test(u.ref)) throw new Error("Invalid ref");
      assertSha(u.next);
      if (u.expected) assertSha(u.expected);
      if (u.ref === this.baseRef && (!u.expected || !(await this.git.ancestor(u.expected, u.next))))
        throw new Error("Non-fast-forward main update forbidden");
      if (u.ref === this.stateRef && u.expected && !(await this.git.ancestor(u.expected, u.next)))
        throw new Error("State history must advance");
    }
    // Git skips an already-up-to-date ref before checking its lease. Explicitly
    // reject replayed snapshots. The lease wire CAS fences coordinated writers;
    // main keeps ordinary FF semantics, not a force-authorizing expected-old lease.
    const current = await this.git.remoteRefs(this.remote);
    if (updates.some((u) => (current.get(u.ref) ?? null) !== u.expected))
      throw new Error("Stale remote ref snapshot");
    const outcomeKey = `git:${fence.next}`;
    writeAttempted(outcomeKey);
    await this.git
      .exec([
        "push",
        "--atomic",
        "--porcelain",
        `--force-with-lease=${this.stateRef}:${fence.expected ?? ""}`,
        // An empty expected value is a create-only predicate: an existing
        // candidate is rejected even if it would be a fast-forward. Main NEVER
        // receives force-with-lease authorization.
        ...updates
          .filter((u) => u.ref !== this.stateRef && u.ref !== this.baseRef && u.expected === null)
          .map((u) => `--force-with-lease=${u.ref}:`),
        this.remote,
        ...updates.map((u) => `${u.next}:${u.ref}`),
      ])
      .catch((error) => {
        throw markFailurePhase(error, "atomic-push");
      });
    writeResolved(outcomeKey);
  }
}
