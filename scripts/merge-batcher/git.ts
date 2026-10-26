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
  private readonly promisors = new Map<string, string>();
  private lastMaintenance = 0;
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
    if (!refs.length) {
      await this.retireCacheSlots(cache, 0);
      return;
    }
    // One persistent promisor only. Git can batch missing blobs from different
    // forks into one lazy request which neither source can satisfy. Distinct
    // sources therefore use a complete exact-head fetch, not another promisor.
    let source = this.promisors.get(remote);
    if (!source) {
      source = `batcher-${digest(remote).slice(0, 24)}`;
      let primary = await this.exec(["config", "--default", "", "--get", "batcher.bloblessSource"]);
      if (!primary) {
        primary = source;
        await this.exec(["config", "batcher.bloblessSource", primary]);
      }
      if (source === primary) {
        await this.exec(["config", `remote.${source}.url`, remote]);
        await this.exec(["config", `remote.${source}.promisor`, "true"]);
        await this.exec(["config", `remote.${source}.partialclonefilter`, "blob:none"]);
        await this.exec(["config", `remote.${source}.tagOpt`, "--no-tags"]);
      } else source = remote;
      this.promisors.set(remote, source);
    }
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
      ...(source === remote ? ["--refetch", "--no-filter"] : ["--filter=blob:none"]),
      "--no-auto-maintenance",
      source,
      ...targets,
    ]);
    await this.retireCacheSlots(cache, Math.min(refs.length, 64));
  }
  private async retireCacheSlots(cache: "state" | "candidate" | "objects", count: number) {
    const prefix = `refs/batcher-cache/${cache}/`;
    const rows = await this.exec(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
    for (const row of rows.split("\n").filter(Boolean)) {
      const [ref, sha] = row.split(" ");
      const slot = ref!.slice(prefix.length);
      if (/^(0|[1-9][0-9]*)$/.test(slot) && Number(slot) < 64 && Number(slot) >= count)
        await this.exec(["update-ref", "-d", ref!, assertSha(sha!)]);
    }
  }
  /** Local disposable pins only; called by the serialized active controller. */
  async maintainLocal(ledger: Ledger, now: string): Promise<void> {
    const at = Date.parse(now);
    const retained = Number(
      await this.exec(["config", "--default", "0", "--get", "batcher.lastMaintenance"]),
    );
    if (Number.isFinite(retained)) this.lastMaintenance = Math.max(this.lastMaintenance, retained);
    if (!Number.isFinite(at) || at - this.lastMaintenance < 3600_000) return;
    // Protect unresolved batches, not unrelated terminal history. Effects whose
    // batch cannot be identified still hold all maintenance conservatively.
    const protectedBatches = new Set([
      ...Object.entries(ledger.missingRuns)
        .filter(([, run]) => run.status !== "released")
        .map(([id]) => id),
      ...ledger.recovery.map((item) => item.batchId),
      ...Object.values(ledger.landings)
        .filter(
          (item) =>
            ![
              "native-merged",
              "already-contained",
              "closed-unmerged",
              "closed-newer-head",
            ].includes(item.status),
        )
        .map((item) => item.batchId),
    ]);
    for (const effect of Object.values(ledger.effects)) {
      if (effect.status === "done") continue;
      if (effect.kind !== "rerun") return;
      const id = effect.run.branch.split("/").at(-1);
      if (!id || !/^[a-f0-9]{64}$/.test(id)) return;
      protectedBatches.add(id);
    }
    // Persist the attempt before work: a local GC timeout must not be repeated
    // every cycle or after every short-lived controller process restart.
    this.lastMaintenance = at;
    await this.exec(["config", "batcher.lastMaintenance", String(at)]);
    const terminal = new Set([...ledger.landed, ...(ledger.parked ?? []).map((p) => p.batchId)]);
    const refs = await this.exec([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/batcher-local/",
    ]);
    for (const row of refs.split("\n").filter(Boolean)) {
      const [ref, sha] = row.split(" ");
      const id = ref?.slice("refs/batcher-local/".length);
      if (id && /^[a-f0-9]{64}$/.test(id) && terminal.has(id) && !protectedBatches.has(id))
        await this.exec(["update-ref", "-d", ref!, assertSha(sha!)]);
    }
    // Foreground, bounded by exec's timeout; preserve Git's normal grace period.
    // No prune-now, remote refs, ledger, checkpoint or operator evidence writes.
    // A partial pack intentionally lacks blob closure; full-closure bitmaps
    // cannot be generated for that pack alongside locally authored commits.
    await this.exec([
      "-c",
      "gc.autoDetach=false",
      "-c",
      "repack.writeBitmaps=false",
      "gc",
      "--prune=2.weeks.ago",
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
