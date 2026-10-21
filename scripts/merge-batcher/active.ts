import type { Effect, Executor, Transaction } from "./controller";
import { AtomicGitWriter, GitStore, type RefUpdate } from "./git";
import { githubCapabilities, ProviderError, type PullSnapshot } from "./github";
import {
  bindingKey,
  digest,
  emptyLedger,
  type Config,
  type DurableEffect,
  type LandedPull,
  type Ledger,
  type Manifest,
  type Pull,
  type Run,
} from "./model";
import { latestRun } from "./planner";

export interface ActiveReads {
  ready(): Promise<{ ready: Pull[]; excluded: { number: number; reason: string }[] }>;
  runs(manifest: Manifest, branch: string): Promise<Run[]>;
  pullSnapshot(number: number): Promise<PullSnapshot>;
  hasComment(number: number, marker: string): Promise<boolean>;
  currentAttempt(run: Run): Promise<{ attempt: number; status: string }>;
  mainBusy(): Promise<boolean>;
}
export interface ActiveWrites {
  retry(run: Run): Promise<void>;
  announce(number: number, body: string): Promise<void>;
}
interface State {
  sha: string | null;
  ledger: Ledger;
  main: string;
}
interface Options {
  clock?: () => Date;
  refreshAuth?: () => Promise<void>;
}

function addComment(
  ledger: Ledger,
  key: string,
  number: number,
  body: string,
  now: string,
): string {
  const id = digest({ kind: "comment", key, number });
  const marker = `<!-- batcher-effect:${id} -->`;
  ledger.effects[id] ??= {
    id,
    kind: "comment",
    number,
    marker,
    body: `${body}\n\n${marker}`,
    status: "pending",
    attempts: 0,
    checks: 0,
    nextAt: now,
    lastError: null,
  };
  return id;
}

/** Real GitHub adapter: Git refs are atomic; PR metadata and REST calls are not.
 * Every REST effect is durably claimed before submission and reconciled by
 * marker/run-attempt afterward. Ambiguous requests are never blindly replayed.
 */
export class GitHubActiveExecutor implements Executor {
  readonly capabilities = githubCapabilities;
  readonly landingContract = "exact-tested-snapshot" as const;
  constructor(
    readonly config: Config,
    readonly git: GitStore,
    readonly writer: AtomicGitWriter,
    readonly reads: ActiveReads,
    readonly writes: ActiveWrites,
    readonly owner: string,
    readonly options: Options = {},
  ) {
    if (
      config.mode !== "active" ||
      writer.stateRef !== config.stateRef ||
      writer.baseRef !== `refs/heads/${config.baseBranch}`
    )
      throw new Error("Active adapter configuration mismatch");
    if (config.branchPrefix === "queue/" || config.branchPrefix.startsWith("queue/shadow-traffic/"))
      throw new Error("Active requires an isolated candidate prefix, such as queue/live/");
  }
  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }
  private available(state: State): boolean {
    return (
      state.ledger.owner === this.owner ||
      Date.parse(state.ledger.expiresAt) <= Date.parse(this.now())
    );
  }
  private async load(): Promise<State> {
    await this.options.refreshAuth?.();
    const refs = await this.git.remoteRefs(this.writer.remote);
    const main = refs.get(this.writer.baseRef);
    if (!main) throw new Error("Main ref missing");
    const sha = refs.get(this.writer.stateRef) ?? null;
    await this.git.fetch(this.writer.remote, [main, ...(sha ? [sha] : [])]);
    return { main, sha, ledger: sha ? await this.git.readLedger(sha) : emptyLedger() };
  }
  private async committed(updates: RefUpdate[]): Promise<boolean> {
    // Handles lost push responses, including a subsequent owner advancing the
    // state or main. Merely seeing the desired main SHA is not proof of our CAS.
    const refs = await this.git.remoteRefs(this.writer.remote);
    for (const update of updates) {
      const actual = refs.get(update.ref);
      if (!actual) return false;
      if (actual === update.next) continue;
      if (update.ref !== this.writer.stateRef && update.ref !== this.writer.baseRef) return false;
      await this.git.fetch(this.writer.remote, [actual]);
      if (!(await this.git.ancestor(update.next, actual))) return false;
    }
    return true;
  }
  private async push(updates: RefUpdate[]): Promise<void> {
    try {
      await this.writer.transaction(updates);
    } catch (error) {
      if (await this.committed(updates)) return;
      // An unreadable/ambiguous remote is never retried inside this operation.
      // The next complete observation reconstructs refs and durable intentions.
      throw error;
    }
  }
  private async persist(state: State, mutate: (ledger: Ledger) => void): Promise<State | null> {
    if (!this.available(state)) return null;
    const now = this.now(),
      ledger = structuredClone(state.ledger);
    mutate(ledger);
    ledger.owner = this.owner;
    ledger.epoch = state.ledger.epoch + 1;
    ledger.expiresAt = new Date(Date.parse(now) + this.config.leaseSeconds * 1000).toISOString();
    const sha = await this.git.stateCommit(ledger, state.sha, now);
    await this.push([{ ref: this.writer.stateRef, expected: state.sha, next: sha }]);
    return { sha, ledger, main: state.main };
  }
  prepareLedger(ledger: Ledger, effect: Effect, now: string): Ledger {
    if (effect.kind === "retry") {
      const id = digest({
        kind: "rerun",
        id: effect.run.id,
        attempt: effect.run.attempt,
        head: effect.run.headSha,
      });
      ledger.effects[id] ??= {
        id,
        kind: "rerun",
        run: effect.run,
        status: "pending",
        attempts: 0,
        checks: 0,
        nextAt: now,
        lastError: null,
      };
    }
    if (effect.kind === "announce") {
      const id = addComment(ledger, `ejection:${effect.key}`, effect.number, effect.body, now);
      ledger.ejected = ledger.ejected.map((item) =>
        bindingKey(item.pull) === effect.key
          ? { ...item, announced: ledger.effects[id]!.status === "done", effectId: id }
          : item,
      );
    }
    if (effect.kind === "land")
      for (const member of effect.manifest.pulls) {
        const { mergeSha, ...pull } = member;
        const key = `${effect.manifest.batchId}:${pull.number}`;
        ledger.landings[key] ??= {
          batchId: effect.manifest.batchId,
          tipSha: effect.manifest.tipSha,
          mergeSha,
          pull,
          currentHeadSha: null,
          status: "pending",
          nextCheckAt: now,
          checkedAt: null,
          note: null,
        };
        addComment(
          ledger,
          `landed:${key}`,
          pull.number,
          `Merge batcher landed the exact tested PR head ${pull.headSha} in main tip ${effect.manifest.tipSha} (member merge ${mergeSha}). Only that immutable snapshot was tested; any later head is not covered by this result.`,
          now,
        );
      }
    return ledger;
  }
  async transact(t: Transaction): Promise<void> {
    if (
      t.expectedLedger.owner !== this.owner &&
      Date.parse(t.expectedLedger.expiresAt) > Date.parse(this.now())
    )
      throw new Error("Cannot replace another controller's live lease");
    if (
      t.nextLedger.owner !== this.owner ||
      t.nextLedger.epoch !== t.expectedLedger.epoch + 1 ||
      Date.parse(t.nextLedger.expiresAt) <= Date.parse(this.now())
    )
      throw new Error("Expired or invalid prepared lease");
    await this.options.refreshAuth?.();
    const effect = t.effect;
    if (effect.kind === "publish" || effect.kind === "land") {
      if (await this.reads.mainBusy())
        throw new Error("Full-main CI reserves headroom; replan without writes");
      const ready = await this.reads.ready();
      if (
        t.bindings.some(
          (p) => !ready.ready.some((current) => bindingKey(current) === bindingKey(p)),
        )
      )
        throw new Error("Final head/readiness/evidence binding changed");
      for (const pull of t.bindings) {
        const current = await this.reads.pullSnapshot(pull.number);
        if (
          current.state !== "open" ||
          current.headSha !== pull.headSha ||
          (current.branchHeadSha !== null && current.branchHeadSha !== pull.headSha)
        )
          throw new Error("Final source branch head changed");
      }
      const inspected = await this.git.inspect(effect.manifest.tipSha);
      if (inspected.batchId !== effect.manifest.batchId)
        throw new Error("Candidate identity changed");
      if (effect.kind === "land") {
        if (effect.expectedBase !== inspected.baseSha) throw new Error("Tested base mismatch");
        const branch = `${this.config.branchPrefix}${inspected.batchId}`;
        const run = latestRun(
          {
            manifest: inspected,
            branch,
            containedInBase: false,
            runs: await this.reads.runs(inspected, branch),
          },
          this.config,
        );
        if (!run || run.status !== "completed" || !run.trusted || run.outcome !== "success")
          throw new Error("Latest exact workflow attempt is not verified green");
      }
    }
    const updates: RefUpdate[] = [
      { ref: this.writer.stateRef, expected: t.expectedState, next: t.nextState },
    ];
    if (effect.kind === "publish") {
      if (effect.branch !== `${this.config.branchPrefix}${effect.manifest.batchId}`)
        throw new Error("Candidate outside active namespace");
      updates.push({
        ref: `refs/heads/${effect.branch}`,
        expected: null,
        next: effect.manifest.tipSha,
      });
    }
    if (effect.kind === "land")
      updates.push({
        ref: this.writer.baseRef,
        expected: effect.expectedBase,
        next: effect.manifest.tipSha,
      });
    // AtomicGitWriter never grants force authority to main. PR metadata may
    // change after the final read: the only permitted destination is testedTip.
    await this.push(updates);
    if (effect.kind === "land") await this.maintain();
  }
  private async patchEffect(id: string, patch: Partial<DurableEffect>): Promise<void> {
    const state = await this.load();
    if (!state.ledger.effects[id]) return;
    await this.persist(state, (ledger) => {
      ledger.effects[id] = { ...ledger.effects[id]!, ...patch } as DurableEffect;
      if (patch.status === "done")
        ledger.ejected = ledger.ejected.map((item) =>
          item.effectId === id ? { ...item, announced: true } : item,
        );
    });
  }
  private async effectObserved(effect: DurableEffect): Promise<boolean> {
    if (effect.kind === "comment") return this.reads.hasComment(effect.number, effect.marker);
    const run = await this.reads.currentAttempt(effect.run);
    return run.attempt > effect.run.attempt;
  }
  private async processEffect(state: State, effect: DurableEffect): Promise<string> {
    const now = this.now();
    let postStarted = false;
    try {
      if (await this.effectObserved(effect)) {
        await this.patchEffect(effect.id, { status: "done", lastError: null });
        return "durable REST intent reconciled from provider evidence";
      }
      if (effect.status === "uncertain" || effect.status === "submitting") {
        const checks = effect.checks + 1;
        await this.patchEffect(effect.id, {
          status: checks >= 8 ? "blocked" : "uncertain",
          checks,
          nextAt: new Date(Date.parse(now) + Math.min(3600, 60 * 2 ** checks) * 1000).toISOString(),
          lastError:
            "Submission outcome unresolved; no blind replay. Inspect provider and explicitly recover if not applied.",
        });
        return "REST outcome remains uncertain; no duplicate submission";
      }
      if (effect.attempts >= 5) {
        await this.patchEffect(effect.id, {
          status: "blocked",
          lastError: "REST submission retry budget exhausted",
        });
        return "REST effect blocked by bounded retry budget";
      }
      if (effect.kind === "rerun") {
        const current = await this.reads.currentAttempt(effect.run);
        if (
          current.attempt !== effect.run.attempt ||
          current.status !== "completed" ||
          (await this.reads.mainBusy())
        ) {
          await this.patchEffect(effect.id, {
            nextAt: new Date(Date.parse(now) + 60_000).toISOString(),
          });
          return "whole-workflow retry waits for exact completed attempt and main headroom";
        }
        await this.git.fetch(this.writer.remote, [effect.run.headSha]);
        const manifest = await this.git.inspect(effect.run.headSha);
        const ready = await this.reads.ready();
        if (
          manifest.pulls.some(
            (p) => !ready.ready.some((eligible) => bindingKey(eligible) === bindingKey(p)),
          )
        ) {
          await this.patchEffect(effect.id, {
            status: "blocked",
            lastError: "Candidate readiness changed before retry; obsolete intent not submitted",
          });
          return "obsolete whole-workflow retry suppressed";
        }
      }
      const claimed = await this.persist(state, (ledger) => {
        ledger.effects[effect.id] = {
          ...ledger.effects[effect.id]!,
          status: "submitting",
          attempts: effect.attempts + 1,
          nextAt: new Date(Date.parse(now) + 60_000).toISOString(),
        };
      });
      if (!claimed) return "REST effect waits for lease owner";
      const beforePost = await this.load();
      if (
        beforePost.sha !== claimed.sha ||
        beforePost.ledger.owner !== this.owner ||
        Date.parse(beforePost.ledger.expiresAt) <= Date.parse(this.now())
      )
        return "REST claim changed before submission; reconcile on next owner";
      // There is deliberately no claim that this read makes GitHub POST atomic
      // with the lease. Stable markers / attempt identity reconcile its outcome.
      postStarted = true;
      if (effect.kind === "comment") await this.writes.announce(effect.number, effect.body);
      else await this.writes.retry(effect.run);
      postStarted = false; // A later read/claim failure cannot prove this POST was rejected.
      await this.patchEffect(effect.id, { status: "done", lastError: null });
      return "durable REST effect submitted";
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : null;
      const latest = (await this.load()).ledger.effects[effect.id];
      if (!latest) throw error;
      const sent = latest.status === "submitting" || latest.status === "uncertain";
      const definitive = status !== null && [400, 401, 403, 404, 409, 422].includes(status);
      const throttled = status === 429;
      const checks = latest.checks + 1;
      await this.patchEffect(effect.id, {
        status:
          definitive || checks >= 8
            ? "blocked"
            : (throttled && postStarted) || !sent
              ? "pending"
              : "uncertain",
        checks,
        nextAt: new Date(
          Date.parse(now) + Math.min(3600, 60 * 2 ** Math.min(checks, 6)) * 1000,
        ).toISOString(),
        lastError:
          status === null ? "Transport/observation outcome unknown" : `GitHub HTTP ${status}`,
      });
      return definitive
        ? "REST effect blocked by explicit provider rejection"
        : "REST effect deferred with bounded backoff";
    }
  }
  private async reconcile(key: string, record: LandedPull): Promise<string> {
    let state = await this.load();
    if (!this.available(state)) return "post-land reconciliation waits for lease owner";
    const now = this.now();
    let currentHeadSha: string | null = null,
      status: LandedPull["status"] = "unchanged",
      note: string | null = null;
    try {
      const pull = await this.reads.pullSnapshot(record.pull.number);
      currentHeadSha = pull.branchHeadSha ?? pull.headSha;
      if (currentHeadSha !== record.pull.headSha) {
        if (pull.headRepository)
          await this.git.fetch(`https://github.com/${pull.headRepository}.git`, [currentHeadSha]);
        if (await this.git.ancestor(currentHeadSha, state.main)) {
          status = "already-contained";
          note =
            "Newer source head is already reachable from main; no claim it was tested by this batch.";
        } else if (pull.state === "closed") {
          status = "closed-newer-head";
          note = pull.merged
            ? "GitHub already auto-closed/merged this PR before newer branch work was observed. A merged PR cannot be kept open by this adapter; open a follow-up PR for the remaining delta. The controller did not close it."
            : "PR was closed externally; newer branch work remains unlanded. The controller does not override that closure.";
        } else if (!(await this.git.ancestor(record.pull.headSha, currentHeadSha))) {
          status = "history-diverged";
          note =
            "New head does not retain landed ancestry; rebase the remaining work onto main before automatic requeue.";
        } else {
          const ready = await this.reads.ready();
          status = ready.ready.some(
            (p) => p.number === record.pull.number && p.headSha === currentHeadSha,
          )
            ? "requeued"
            : "awaiting-evidence";
          note =
            status === "requeued"
              ? "Newer open head is automatically eligible; merging against landed main includes only its remaining delta. It still requires its own candidate CI."
              : "Newer work remains open and tracked for automatic requeue after normal readiness plus exact-new-head VM/independent-review evidence. No evidence was inherited from the landed head.";
        }
      }
    } catch (error) {
      status = "provider-unavailable";
      note =
        error instanceof ProviderError
          ? `Post-land observation unavailable: HTTP ${error.status}`
          : "Post-land source history could not be verified; no automatic delta claim";
    }
    state = await this.load();
    await this.persist(state, (ledger) => {
      if (!ledger.landings[key]) return;
      ledger.landings[key] = {
        ...ledger.landings[key]!,
        currentHeadSha,
        status,
        note,
        checkedAt: now,
        nextCheckAt: new Date(
          Date.parse(now) + (status === "provider-unavailable" ? 300_000 : 60_000),
        ).toISOString(),
      };
      if (currentHeadSha && currentHeadSha !== record.pull.headSha && note)
        addComment(
          ledger,
          `delta:${key}:${currentHeadSha}:${status}`,
          record.pull.number,
          `Tested snapshot ${record.pull.headSha} landed at main tip ${record.tipSha}. Observed newer source head ${currentHeadSha} is not covered by that test result. ${note}`,
          now,
        );
    });
    return `post-land reconciliation: ${status}`;
  }
  async maintain(): Promise<string | null> {
    let state = await this.load();
    if (!this.available(state)) return null;
    const messages: string[] = [];
    // Bound work per tick. Completed effects are immutable history; blocked
    // effects remain visible without starving candidate planning.
    const effect = Object.values(state.ledger.effects).find(
      (item) =>
        !["done", "blocked"].includes(item.status) &&
        Date.parse(item.nextAt) <= Date.parse(this.now()),
    );
    if (effect) messages.push(await this.processEffect(state, effect));
    state = await this.load();
    if (!this.available(state)) return messages.join("; ") || null;
    const entry = Object.entries(state.ledger.landings)
      .filter(([, item]) => Date.parse(item.nextCheckAt) <= Date.parse(this.now()))
      .sort(([, a], [, b]) => Date.parse(a.nextCheckAt) - Date.parse(b.nextCheckAt))[0];
    if (entry) messages.push(await this.reconcile(entry[0], entry[1]));
    return messages.join("; ") || null;
  }
  /** Explicit operator recovery, never an automatic uncertain-effect replay. */
  async recoverEffect(
    id: string,
    expectedState: string,
    confirmedNotApplied: boolean,
  ): Promise<void> {
    if (!confirmedNotApplied)
      throw new Error("Recovery requires explicit confirmation that the effect was not applied");
    const state = await this.load(),
      effect = state.ledger.effects[id];
    if (!this.available(state)) throw new Error("Recovery cannot steal a live lease");
    if (
      state.sha !== expectedState ||
      !effect ||
      !["blocked", "uncertain", "submitting"].includes(effect.status)
    )
      throw new Error("Recovery state changed or effect is not recoverable");
    const observed = await this.effectObserved(effect);
    await this.persist(state, (ledger) => {
      ledger.effects[id] = {
        ...effect,
        status: observed ? "done" : "pending",
        attempts: 0,
        checks: 0,
        nextAt: this.now(),
        lastError: observed ? null : "Explicit operator recovery after provider inspection",
      };
      if (observed)
        ledger.ejected = ledger.ejected.map((item) =>
          item.effectId === id ? { ...item, announced: true } : item,
        );
    });
  }
}
