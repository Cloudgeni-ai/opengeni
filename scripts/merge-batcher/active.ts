import type { Effect, Executor, Transaction } from "./controller";
import { ReplanRequired } from "./controller";
import { AtomicGitWriter, GitFailure, GitStore, type RefUpdate } from "./git";
import {
  githubCapabilities,
  ProviderError,
  AutoMergePreSubmitError,
  type PullSnapshot,
  type AutoMergeState,
} from "./github";
import {
  bindingKey,
  digest,
  emptyLedger,
  requireInitializedState,
  type Config,
  type DurableEffect,
  type LandedPull,
  type Ledger,
  type Manifest,
  type Pull,
  type Run,
  type FollowupRequest,
  type FollowupPull,
  type BatchReservation,
} from "./model";
import { latestRun, infrastructureRetryReason } from "./planner";
import { observeDurableUncertainty, writeResolved } from "./cycle-outcome";
import { proveHeadRefresh } from "./head-refresh";

export interface ActiveReads {
  autoMergeState?(number: number): Promise<AutoMergeState>;
  openPullNumbers?(): Promise<number[]>;
  baseCI(sha: string): Promise<import("./model").BaseCiEvidence>;
  ready(): Promise<{ ready: Pull[]; excluded: { number: number; reason: string }[] }>;
  runs(manifest: Manifest, branch: string): Promise<Run[]>;
  observedRuns?(
    manifest: Manifest,
    branch: string,
    archived: boolean,
    allowRefresh?: boolean,
  ): Promise<Run[]>;
  pullSnapshot(number: number): Promise<PullSnapshot>;
  hasComment(number: number, marker: string): Promise<boolean>;
  currentAttempt(run: Run): Promise<{ attempt: number; status: string }>;
  mainBusy(
    purpose?: "publish" | "land" | "observe",
    reservations?: BatchReservation[],
  ): Promise<boolean>;
  findFollowup(request: FollowupRequest): Promise<FollowupPull | null>;
}
export interface ActiveWrites {
  disableAutoMerge?(number: number, headSha: string, parkedAt: string): Promise<void>;
  retry(run: Run): Promise<void>;
  announce(number: number, body: string): Promise<void>;
  createFollowup(request: FollowupRequest): Promise<void>;
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
function matchesAutoMergedSnapshot(
  pull: PullSnapshot,
  request: Pick<FollowupRequest, "landedHeadSha" | "landedMergeSha" | "landedTipSha">,
): boolean {
  return (
    pull.state === "closed" &&
    pull.merged &&
    (pull.headSha === request.landedHeadSha ||
      pull.mergeCommitSha === request.landedMergeSha ||
      pull.mergeCommitSha === request.landedTipSha)
  );
}
function followupRequest(
  record: LandedPull,
  pull: PullSnapshot,
  headSha: string,
): { id: string; request: FollowupRequest } {
  const id = digest({
    kind: "followup",
    repository: pull.headRepository,
    ref: pull.headRef,
    headSha,
  });
  const marker = `<!-- batcher-followup:${id} -->`;
  return {
    id,
    request: {
      original: record.pull.number,
      sourceRepository: pull.headRepository!,
      sourceRef: pull.headRef,
      headSha,
      landedHeadSha: record.pull.headSha,
      landedMergeSha: record.mergeSha,
      landedTipSha: record.tipSha,
      marker,
      title: `Remaining work after #${record.pull.number}`,
      body: `Remaining source-branch work after #${record.pull.number} was merged. The tested snapshot was ${record.pull.headSha}, landed at ${record.tipSha}. Recovery observed newer head ${headSha}; it has NOT been tested by that batch. This PR needs exact-head required GitHub CI and queue-ready before candidate CI. No evidence or readiness was copied.\n\n${marker}`,
    },
  };
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

export function stageOnNotice(ledger: Ledger, id: string, numbers: number[], now: string): boolean {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw Error("Invalid ON notice identity/inventory");
  if (ledger.onNotices?.[id]) return false;
  const recipients = [...new Set(numbers)].sort((a, b) => a - b);
  for (const number of recipients)
    addComment(
      ledger,
      `on-notice:${id}`,
      number,
      "Merges now go through the batcher: add `queue-ready` to land",
      now,
    );
  ledger.onNotices ??= {};
  ledger.onNotices[id] = { at: now, recipients };
  return true;
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
    await this.git.fetch(this.writer.remote, [main, ...(sha ? [sha] : [])], "state");
    const ledger = sha ? await this.git.readLedger(sha) : emptyLedger();
    requireInitializedState(sha, ledger);
    observeDurableUncertainty(
      Object.values(ledger.effects)
        .filter((effect) => ["submitting", "uncertain", "blocked"].includes(effect.status))
        .map((effect) => effect.id),
    );
    return { main, sha, ledger };
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
      try {
        if (await this.committed(updates)) {
          const fence = updates.find((update) => update.ref === this.writer.stateRef);
          if (fence) writeResolved(`git:${fence.next}`);
          return;
        }
      } catch {
        // Verification failure cannot replace the original ambiguous push outcome.
        throw error;
      }
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
    if (effect.kind === "publish")
      for (const pull of effect.manifest.pulls)
        addComment(
          ledger,
          `queued:${pull.number}:${pull.headSha}`,
          pull.number,
          `Queued exact head ${pull.headSha} for tested batch landing.`,
          now,
        );
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
    if (effect.kind === "park") {
      const parked = ledger.parked?.find((item) => item.batchId === effect.key);
      if (parked) {
        const disableId = digest({ kind: "disable-auto-merge", batchId: effect.key });
        ledger.effects[disableId] ??= {
          id: disableId,
          kind: "disable-auto-merge",
          number: effect.number,
          headSha: parked.pull.headSha,
          parkedAt: parked.parkedAt,
          status: "pending",
          attempts: 0,
          checks: 0,
          nextAt: now,
          lastError: null,
        };
      }
      const id = addComment(ledger, `parking:${effect.key}`, effect.number, effect.body, now);
      ledger.parked = (ledger.parked ?? []).map((item) =>
        item.batchId === effect.key
          ? { ...item, announced: ledger.effects[id]!.status === "done", effectId: id }
          : item,
      );
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
      for (const member of effect.headRefresh?.pulls ?? effect.manifest.pulls) {
        const { mergeSha, ...pull } = member;
        const key = `${effect.manifest.batchId}:${pull.number}`;
        ledger.landings[key] ??= {
          batchId: effect.manifest.batchId,
          tipSha: effect.headRefresh?.tipSha ?? effect.manifest.tipSha,
          mergeSha,
          pull,
          currentHeadSha: null,
          status: "pending",
          nextCheckAt: now,
          checkedAt: null,
          note: null,
          ...(effect.headRefresh
            ? {
                testedSnapshot: {
                  tipSha: effect.manifest.tipSha,
                  treeSha: effect.headRefresh.testedTree,
                  headSha: effect.manifest.pulls.find((p) => p.number === pull.number)!.headSha,
                },
              }
            : {}),
        };
        addComment(
          ledger,
          `landed:${key}`,
          pull.number,
          effect.headRefresh
            ? `Merge batcher landed head ${pull.headSha} at ${effect.headRefresh.tipSha}. Tested tip ${effect.manifest.tipSha}, tree ${effect.headRefresh.testedTree}; merge-main-only refresh ancestry and identical resulting tree were verified. Later heads are not covered.`
            : `Merge batcher landed the exact tested PR head ${pull.headSha} in main tip ${effect.manifest.tipSha} (member merge ${mergeSha}). Only that immutable snapshot was tested; any later head is not covered by this result.`,
          now,
        );
      }
    return ledger;
  }
  private async slotReservations(ledger: Ledger): Promise<BatchReservation[]> {
    const refs = await this.git.remoteRefs(this.writer.remote);
    const prefix = `refs/heads/${this.config.branchPrefix}`;
    const queue = [...refs].filter(
      ([ref]) => ref.startsWith(prefix) && /^[a-f0-9]{64}$/.test(ref.slice(prefix.length)),
    );
    await this.git.fetch(
      this.writer.remote,
      queue.map(([, sha]) => sha),
      "state",
    );
    const reservations: BatchReservation[] = [];
    for (const [ref, sha] of queue) {
      let manifest: Manifest;
      try {
        manifest = await this.git.inspect(sha);
      } catch {
        // Match candidate discovery: unrelated malformed refs are not trusted
        // reservations. Any actual provider run still occupies a provider slot.
        continue;
      }
      const branch = ref.slice("refs/heads/".length);
      if (branch !== `${this.config.branchPrefix}${manifest.batchId}` || manifest.tipSha !== sha)
        continue;
      const archived =
        ledger.landed.includes(manifest.batchId) || ledger.invalidated.includes(manifest.batchId);
      const runs = this.reads.observedRuns
        ? await this.reads.observedRuns(manifest, branch, archived, !archived)
        : await this.reads.runs(manifest, branch);
      const candidate = { manifest, branch, runs, containedInBase: false };
      for (const run of runs.filter(
        (item) => item.workflow === this.config.workflow && item.status !== "completed",
      ))
        reservations.push({ branch, headSha: sha, runId: run.id });
      if (
        !latestRun(candidate, this.config) &&
        ledger.missingRuns[manifest.batchId]?.status !== "released"
      )
        reservations.push({ branch, headSha: sha });
    }
    return reservations;
  }
  async transact(t: Transaction): Promise<void> {
    requireInitializedState(t.expectedState, t.expectedLedger);
    requireInitializedState(t.nextState, t.nextLedger);
    if (digest(t.expectedLedger.initialization) !== digest(t.nextLedger.initialization))
      throw new Error("Initialization provenance must remain unchanged");
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
      if (
        await this.reads.mainBusy(
          effect.kind,
          effect.kind === "publish" ? await this.slotReservations(t.expectedLedger) : [],
        )
      )
        throw new ReplanRequired(
          "Batch slot or complete inventory unavailable; replan without writes",
        );
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
        if (effect.headRefresh) {
          const verified = await proveHeadRefresh(
            this.git,
            inspected,
            ready.ready,
            effect.expectedBase,
          );
          if (
            !verified ||
            digest(verified) !== digest(effect.headRefresh) ||
            digest(t.bindings) !== digest(verified.pulls)
          )
            throw new Error("Head refresh equivalence changed");
        } else if (digest(t.bindings.map(bindingKey)) !== digest(inspected.pulls.map(bindingKey))) {
          throw new Error("Tested bindings differ");
        }
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
        next: effect.headRefresh?.tipSha ?? effect.manifest.tipSha,
      });
    // AtomicGitWriter never grants force authority to main. PR metadata may
    // change after the final read: destination is testedTip or a recomputed
    // ancestry-only descendant with the identical tested tree.
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
      if (patch.status === "done" && ledger.parked)
        ledger.parked = ledger.parked.map((item) =>
          item.effectId === id ? { ...item, announced: true } : item,
        );
    });
  }
  private async effectObserved(effect: DurableEffect): Promise<boolean> {
    if (effect.kind === "disable-auto-merge") {
      if (!this.reads.autoMergeState) throw Error("Auto-merge observation unavailable");
      const current = await this.reads.autoMergeState(effect.number);
      return (
        current.enabledAt === null ||
        current.headSha !== effect.headSha ||
        Date.parse(current.enabledAt) > Date.parse(effect.parkedAt)
      );
    }
    if (effect.kind === "comment") return this.reads.hasComment(effect.number, effect.marker);
    if (effect.kind === "followup") return (await this.reads.findFollowup(effect.request)) !== null;
    const run = await this.reads.currentAttempt(effect.run);
    return run.attempt > effect.run.attempt;
  }
  private async validFollowup(request: FollowupRequest): Promise<boolean> {
    const original = await this.reads.pullSnapshot(request.original);
    return (
      matchesAutoMergedSnapshot(original, request) &&
      original.headRepository === request.sourceRepository &&
      original.headRef === request.sourceRef &&
      original.branchHeadSha === request.headSha
    );
  }
  private async retryApplicable(manifest: Manifest, state: State): Promise<boolean> {
    const refs = await this.git.remoteRefs(this.writer.remote);
    if (refs.get(this.writer.baseRef) !== state.main) return false;
    let current = manifest;
    const seen = new Set<string>();
    for (let depth = 0; depth <= this.config.speculationDepth; depth++) {
      if (
        seen.has(current.batchId) ||
        state.ledger.invalidated.includes(current.batchId) ||
        state.ledger.landed.includes(current.batchId) ||
        refs.get(`refs/heads/${this.config.branchPrefix}${current.batchId}`) !== current.tipSha
      )
        return false;
      seen.add(current.batchId);
      if (current.baseSha === state.main) return true;
      if (!current.predecessor) return false;
      const parentTip = refs.get(`refs/heads/${this.config.branchPrefix}${current.predecessor}`);
      if (parentTip !== current.baseSha) return false;
      await this.git.fetch(this.writer.remote, [parentTip]);
      const parent = await this.git.inspect(parentTip);
      if (parent.batchId !== current.predecessor) return false;
      current = parent;
    }
    return false;
  }
  private async processEffect(state: State, effect: DurableEffect): Promise<string> {
    const now = this.now();
    let postStarted = false;
    let retryManifest: Manifest | null = null;
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
      if (effect.attempts >= (effect.kind === "rerun" ? 1 : 5)) {
        await this.patchEffect(effect.id, {
          status: "blocked",
          lastError: "REST submission retry budget exhausted",
        });
        return "REST effect blocked by bounded retry budget";
      }
      if (effect.kind === "comment" && effect.body.includes("batcher-ejection:")) {
        const conflict = state.ledger.ejected.some(
          (e) =>
            e.reason === "merge-tree conflict against candidate predecessor" &&
            e.pull.number === effect.number &&
            effect.body.includes(`<!-- batcher-ejection:${bindingKey(e.pull)} -->`) &&
            effect.body.includes(`: ${e.reason}. Batch: ${e.batchId}.`),
        );
        if (!conflict) {
          await this.patchEffect(effect.id, {
            nextAt: new Date(Date.parse(now) + 60_000).toISOString(),
            lastError:
              "Comparable base batch-suite evidence unavailable; ejection announcement held",
          });
          return "base batch-suite evidence holds pending culprit announcement";
        }
      }
      if (effect.kind === "followup" && !(await this.validFollowup(effect.request))) {
        await this.patchEffect(effect.id, {
          status: "blocked",
          attempts: 0,
          lastError: "Follow-up source snapshot changed before submission; no POST issued",
        });
        return "follow-up creation waits for current exact source snapshot";
      }
      if (effect.kind === "rerun") {
        const current = await this.reads.currentAttempt(effect.run);
        if (
          current.attempt !== effect.run.attempt ||
          current.status !== "completed" ||
          (await this.reads.mainBusy("publish", await this.slotReservations(state.ledger)))
        ) {
          await this.patchEffect(effect.id, {
            nextAt: new Date(Date.parse(now) + 60_000).toISOString(),
          });
          return "whole-workflow retry waits for exact completed attempt and complete available Batch-slot evidence";
        }
        await this.git.fetch(this.writer.remote, [effect.run.headSha]);
        const manifest = await this.git.inspect(effect.run.headSha);
        if (!(await this.retryApplicable(manifest, state))) {
          await this.patchEffect(effect.id, {
            status: "blocked",
            lastError:
              "Candidate invalidated, landed or no longer based on current main/live predecessor; no rerun submitted",
          });
          return "obsolete infrastructure retry suppressed";
        }
        retryManifest = manifest;
        const candidate = {
          manifest,
          branch: effect.run.branch,
          runs: await this.reads.runs(manifest, effect.run.branch),
          containedInBase: false,
        };
        const exact = latestRun(candidate, this.config);
        const intent = state.ledger.retries[manifest.batchId];
        if (
          !exact ||
          exact.id !== effect.run.id ||
          exact.attempt !== effect.run.attempt ||
          !infrastructureRetryReason(candidate, exact, this.config) ||
          intent?.runId !== effect.run.id ||
          intent.fromAttempt !== effect.run.attempt ||
          intent.reason !== infrastructureRetryReason(candidate, exact, this.config)
        ) {
          await this.patchEffect(effect.id, {
            status: "blocked",
            lastError:
              "Retry requires first-attempt exact candidate infrastructure evidence and matching durable intent",
          });
          return "ineligible or stale retry suppressed; no POST issued";
        }
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
      if (retryManifest && !(await this.retryApplicable(retryManifest, beforePost))) {
        await this.patchEffect(effect.id, {
          status: "blocked",
          lastError: "Candidate became obsolete after retry claim; no rerun submitted",
        });
        return "obsolete infrastructure retry suppressed after claim";
      }
      if (effect.kind === "followup") {
        if (await this.reads.findFollowup(effect.request)) {
          await this.patchEffect(effect.id, { status: "done", lastError: null });
          return "existing follow-up PR reconciled without creation";
        }
        if (!(await this.validFollowup(effect.request))) {
          await this.patchEffect(effect.id, {
            status: "blocked",
            attempts: 0,
            lastError: "Follow-up source snapshot changed before submission; no POST issued",
          });
          return "changed source head suppressed follow-up POST";
        }
      }
      postStarted = true;
      if (effect.kind === "comment") await this.writes.announce(effect.number, effect.body);
      else if (effect.kind === "rerun") await this.writes.retry(effect.run);
      else if (effect.kind === "disable-auto-merge") {
        if (!this.writes.disableAutoMerge) throw Error("Auto-merge mutation unavailable");
        await this.writes.disableAutoMerge(effect.number, effect.headSha, effect.parkedAt);
      } else await this.writes.createFollowup(effect.request);
      postStarted = false; // A later read/claim failure cannot prove this POST was rejected.
      await this.patchEffect(effect.id, {
        status:
          effect.kind === "followup" || effect.kind === "disable-auto-merge" ? "uncertain" : "done",
        lastError:
          effect.kind === "followup"
            ? "Create accepted; awaiting exact source/marker reconciliation"
            : null,
      });
      return "durable REST effect submitted";
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : null;
      const notSubmitted =
        effect.kind === "disable-auto-merge" && error instanceof AutoMergePreSubmitError;
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
            : notSubmitted || (throttled && postStarted) || !sent
              ? "pending"
              : "uncertain",
        checks,
        nextAt: new Date(
          Date.parse(now) + Math.min(3600, 60 * 2 ** Math.min(checks, 6)) * 1000,
        ).toISOString(),
        lastError: notSubmitted
          ? "Pre-submit observation failed; no mutation sent"
          : status === null
            ? "Transport/observation outcome unknown"
            : `GitHub HTTP ${status}`,
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
    let followup: { id: string; request: FollowupRequest } | null = null;
    let followupNumber: number | undefined;
    let reconciledEffectId: string | null = null;
    try {
      const pull = await this.reads.pullSnapshot(record.pull.number);
      currentHeadSha = pull.branchHeadSha ?? pull.headSha;
      if (
        !pull.branchHeadSha &&
        record.currentHeadSha &&
        record.currentHeadSha !== record.pull.headSha
      ) {
        currentHeadSha = record.currentHeadSha;
        status = "followup-blocked";
        note =
          "Previously observed newer work is retained, but the source branch is now unavailable; no follow-up can be safely created.";
      } else if (currentHeadSha !== record.pull.headSha) {
        if (pull.headRepository)
          await this.git.fetch(`https://github.com/${pull.headRepository}.git`, [currentHeadSha]);
        if (await this.git.ancestor(currentHeadSha, state.main)) {
          status = "already-contained";
          note =
            "Newer source head is already reachable from main; no claim it was tested by this batch.";
        } else if (pull.state === "closed" && !pull.merged) {
          status = "closed-newer-head";
          note =
            "PR was closed externally without merging; newer work remains unlanded. Automatic follow-up creation does not override that closure.";
        } else if (!(await this.git.ancestor(record.pull.headSha, currentHeadSha))) {
          status = "history-diverged";
          note =
            "New head does not retain landed ancestry; rebase the remaining work onto main before automatic requeue.";
        } else if (pull.state === "closed") {
          status = "followup-blocked";
          note =
            "Cannot recover automatically: source repository/branch or association with the batcher's merged snapshot is unavailable.";
          const proof = {
            landedHeadSha: record.pull.headSha,
            landedMergeSha: record.mergeSha,
            landedTipSha: record.tipSha,
          };
          if (pull.headRepository && pull.branchHeadSha && matchesAutoMergedSnapshot(pull, proof)) {
            const proposed = followupRequest(record, pull, currentHeadSha);
            const existing = await this.reads.findFollowup(proposed.request);
            if (existing) {
              followupNumber = existing.number;
              reconciledEffectId = proposed.id;
              status =
                existing.state === "open"
                  ? existing.headSha === currentHeadSha
                    ? "followup-open"
                    : "followup-pending"
                  : "followup-blocked";
              note =
                existing.state === "open"
                  ? `Source branch already has open PR #${existing.number}, observed head ${existing.headSha}, current source head ${currentHeadSha}. Any PR-head lag must reconcile; fresh exact-head evidence/readiness and candidate CI are required, with nothing inherited.`
                  : `Recovery PR #${existing.number} was closed; this adapter will not reopen it or create a duplicate for this snapshot.`;
            } else {
              const pending = Object.values(state.ledger.effects).find(
                (e) =>
                  e.kind === "followup" &&
                  e.request.sourceRepository === pull.headRepository &&
                  e.request.sourceRef === pull.headRef &&
                  ((e.attempts > 0 && e.status !== "done") || e.id === proposed.id),
              );
              status =
                pending?.status === "blocked" || pending?.status === "done"
                  ? "followup-blocked"
                  : "followup-pending";
              note = pending
                ? `Follow-up recovery ${pending.status}: ${pending.lastError ?? "durable intent awaiting reconciliation"}. No duplicate creation.`
                : "Durable follow-up creation queued for the exact observed source branch/head; normal new-PR evidence/readiness still required.";
              if (!pending) followup = proposed;
            }
          }
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
              : "Newer work remains open and tracked for automatic requeue after queue-ready plus exact-new-head required GitHub CI. No evidence was inherited from the landed head.";
        }
      } else {
        status = pull.merged
          ? "native-merged"
          : pull.state === "closed"
            ? "closed-unmerged"
            : "awaiting-native-merge";
        note = pull.merged
          ? "GitHub reports the landed PR as merged."
          : "Tested tip is in main, but GitHub has not reported native MERGED; closure alone is not merge proof.";
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
        ...(followupNumber !== undefined ? { followupNumber } : {}),
        checkedAt: now,
        nextCheckAt: new Date(
          Date.parse(now) + (status === "provider-unavailable" ? 300_000 : 60_000),
        ).toISOString(),
      };
      if (reconciledEffectId && ledger.effects[reconciledEffectId])
        ledger.effects[reconciledEffectId] = {
          ...ledger.effects[reconciledEffectId]!,
          status: "done",
          lastError: null,
        } as DurableEffect;
      if (followup)
        ledger.effects[followup.id] ??= {
          id: followup.id,
          kind: "followup",
          request: followup.request,
          status: "pending",
          attempts: 0,
          checks: 0,
          nextAt: now,
          lastError: null,
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
    // Explicit operator rollout ID only. Reading every open PR is independent
    // of admission/owner identity; the durable claim prevents repeated notices.
    if (this.config.onNoticeId && !state.ledger.onNotices?.[this.config.onNoticeId]) {
      if (!this.reads.openPullNumbers) throw Error("Complete open PR inventory unavailable");
      const recipients = await this.reads.openPullNumbers();
      await this.persist(state, (ledger) => {
        stageOnNotice(ledger, this.config.onNoticeId!, recipients, this.now());
      });
      state = await this.load();
      if (!this.available(state)) return "ON notice staged by current owner";
    }
    // Bound work per tick. Completed effects are immutable history; blocked
    // effects remain visible without starving candidate planning.
    const effect = Object.values(state.ledger.effects)
      .sort(
        (a, b) =>
          Number(b.kind === "disable-auto-merge") - Number(a.kind === "disable-auto-merge") ||
          Number(b.kind === "followup") - Number(a.kind === "followup") ||
          Date.parse(a.nextAt) - Date.parse(b.nextAt),
      )
      .find(
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
    state = await this.load();
    if (this.available(state)) {
      try {
        await this.git.maintainLocal(state.ledger, this.now());
      } catch (error) {
        // Only this local disposable-cache operation is optional. Never swallow
        // remote mutation/reconciliation failures from the work above.
        if (!(error instanceof GitFailure)) throw error;
        messages.push(`Local Git cache maintenance deferred (exit ${error.exitCode})`);
      }
    }
    return messages.join("; ") || null;
  }
  async recoverMissingRun(
    id: string,
    expectedState: string,
    confirmedNoRun: boolean,
  ): Promise<void> {
    const state = await this.load(),
      missing = state.ledger.missingRuns[id];
    if (
      !confirmedNoRun ||
      !this.available(state) ||
      state.sha !== expectedState ||
      missing?.status !== "abandoned"
    )
      throw new Error(
        "Missing-run recovery needs abandoned state, current lease/CAS and explicit no-run confirmation",
      );
    const refs = await this.git.remoteRefs(this.writer.remote);
    const branch = `${this.config.branchPrefix}${id}`,
      tip = refs.get(`refs/heads/${branch}`);
    if (!tip) throw new Error("Missing-run candidate ref disappeared");
    await this.git.fetch(this.writer.remote, [tip]);
    const manifest = await this.git.inspect(tip);
    if (manifest.batchId !== id || (await this.reads.runs(manifest, branch)).length)
      throw new Error("Candidate has a provider run; missing-run recovery refused");
    await this.persist(state, (ledger) => {
      const at = this.now();
      ledger.missingRuns[id] = {
        ...missing,
        status: "released",
        updatedAt: at,
        recovery: {
          confirmedNoRun: true,
          at,
          controllerId: this.owner,
          tipSha: manifest.tipSha,
          previousStateSha: state.sha,
        },
      };
    });
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
      if (observed && ledger.parked)
        ledger.parked = ledger.parked.map((item) =>
          item.effectId === id ? { ...item, announced: true } : item,
        );
    });
  }
}
