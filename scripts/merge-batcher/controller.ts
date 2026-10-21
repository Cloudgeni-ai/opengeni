import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitStore, MergeConflict, type RefUpdate, AtomicGitWriter } from "./git";
import {
  githubCapabilities,
  requireActiveCapabilities,
  type Capabilities,
  type GitHubReader,
} from "./github";
import {
  bindingKey,
  canonical,
  digest,
  emptyLedger,
  type Candidate,
  type Config,
  type Ledger,
  type Manifest,
  type Observation,
  type Pull,
  type Run,
} from "./model";
import { plan, type Action } from "./planner";
import { DiskCache } from "./cache";
import { ObservationJournal } from "./journal";

export interface Reader {
  observe(): Promise<Observation>;
}
export type Effect =
  | { kind: "record" }
  | { kind: "publish"; branch: string; manifest: Manifest }
  | { kind: "land"; manifest: Manifest; expectedBase: string }
  | { kind: "retry"; run: Run }
  | { kind: "announce"; number: number; body: string; key: string };
export interface Transaction {
  expectedState: string | null;
  nextState: string;
  expectedLedger: Ledger;
  nextLedger: Ledger;
  now: string;
  bindings: Pull[];
  effect: Effect;
}
export interface Executor {
  capabilities: Capabilities;
  landingContract?: "exact-tested-snapshot";
  prepareLedger?(ledger: Ledger, effect: Effect, now: string): Ledger;
  maintain?(): Promise<string | null>;
  // Atomic Git lease/CAS. Strict adapters additionally fence admission/effects;
  // exact-tested-snapshot adapters explicitly reconcile non-atomic REST effects.
  transact(transaction: Transaction): Promise<void>;
}
export class LiveReader implements Reader {
  readonly manifestCache: DiskCache;
  constructor(
    readonly github: GitHubReader,
    readonly git: GitStore,
    readonly config: Config,
  ) {
    this.manifestCache = new DiskCache(join(config.outputDir, "manifest-cache.json"));
  }
  async observe(): Promise<Observation> {
    Object.assign(this.git.authEnv, await this.github.auth.gitEnv());
    const remote = `https://github.com/${this.config.repository}.git`;
    const refs = await this.git.remoteRefs(remote);
    const baseSha = refs.get(`refs/heads/${this.config.baseBranch}`);
    if (!baseSha) throw new Error("Base ref missing");
    const stateSha = refs.get(this.config.stateRef) ?? null;
    const observationWarnings: string[] = [];
    const queue = [...refs]
      .filter(([ref]) => ref.startsWith(`refs/heads/${this.config.branchPrefix}`))
      .filter(([ref]) => {
        const owned = /^[a-f0-9]{64}$/.test(
          ref.slice(`refs/heads/${this.config.branchPrefix}`.length),
        );
        if (!owned) observationWarnings.push(`Excluded unowned queue ref ${ref}`);
        return owned;
      });
    // Exact SHAs, not mutable ref names: a racing fetch cannot silently change
    // the base or candidate bound by the remote-ref observation.
    await this.git.fetch(remote, [
      ...new Set([baseSha, ...(stateSha ? [stateSha] : []), ...queue.map(([, sha]) => sha)]),
    ]);
    const admission = await this.github.ready();
    if (admission.ready.length)
      await this.git.fetch(
        remote,
        admission.ready.map((p) => p.headSha),
      );
    const ledger = stateSha ? await this.git.readLedger(stateSha) : emptyLedger();
    // A new head on an already-landed PR is admitted only when it retains that
    // landed ancestry. merge-tree then composes only its remaining delta.
    const eligible: Pull[] = [];
    for (const pull of admission.ready) {
      const prior = Object.values(ledger.landings).filter(
        (item) => item.pull.number === pull.number,
      );
      if (await this.git.ancestor(pull.headSha, baseSha)) {
        admission.excluded.push({
          number: pull.number,
          reason: "head already contained in main; no remaining delta",
        });
      } else if (
        prior.some((item) => item.pull.headSha !== pull.headSha) &&
        !(
          await Promise.all(prior.map((item) => this.git.ancestor(item.pull.headSha, pull.headSha)))
        ).every(Boolean)
      ) {
        admission.excluded.push({
          number: pull.number,
          reason: "new head diverges from landed history; rebase remaining work onto main",
        });
      } else eligible.push(pull);
    }
    const candidates: Candidate[] = [];
    for (const [ref, sha] of queue) {
      let manifest: Manifest;
      try {
        const cached = await this.manifestCache.get<Manifest>(sha);
        manifest = cached ?? (await this.git.inspect(sha));
        if (!cached) await this.manifestCache.set(sha, manifest);
      } catch {
        observationWarnings.push(`Excluded malformed candidate ${ref} at ${sha}`);
        continue;
      }
      const branch = ref.slice("refs/heads/".length);
      if (branch !== `${this.config.branchPrefix}${manifest.batchId}`) {
        observationWarnings.push(`Excluded queue ref not bound to manifest ${ref}`);
        continue;
      }
      const containedInBase = await this.git.ancestor(manifest.tipSha, baseSha);
      candidates.push({
        manifest,
        branch,
        runs: await this.github.observedRuns(
          manifest,
          branch,
          this.config.mode !== "active" ||
            containedInBase ||
            ledger.invalidated.includes(manifest.batchId),
        ),
        containedInBase,
      });
    }
    return {
      now: new Date().toISOString(),
      baseSha,
      ...admission,
      ready: eligible,
      candidates,
      stateSha,
      ledger,
      observationWarnings,
      mainBusy: this.config.mode === "shadow" ? false : await this.github.mainBusy(),
    };
  }
}
export interface StepResult {
  mode: Config["mode"];
  action: Action;
  manifest: Manifest | null;
  reason: string | null;
}
export class Controller {
  readonly journal: ObservationJournal;
  constructor(
    readonly config: Config,
    readonly reader: Reader,
    readonly git: GitStore,
    readonly owner: string,
    readonly executor?: Executor,
  ) {
    this.journal = new ObservationJournal(config);
  }
  async step(): Promise<StepResult> {
    if (this.config.mode === "shadow-ci") throw new Error("Use the restricted ShadowCiController");
    if (this.config.mode === "active") {
      requireActiveCapabilities(
        this.executor?.capabilities ?? githubCapabilities,
        this.executor?.landingContract,
      );
      if (!this.executor) throw new Error("Active mode requires a fenced provider adapter");
    }
    const maintenance = this.config.mode === "active" ? await this.executor?.maintain?.() : null;
    const observation = await this.journal.observe(await this.reader.observe());
    let action = plan(observation, this.config);
    const plannedAction = action;
    const records = await this.journal.records(observation.now);
    const stamp = (stages: Ledger["stages"]) =>
      Object.fromEntries(
        Object.entries(stages).map(([id, { observedAt: _, ...sample }]) => [id, sample]),
      );
    if (
      this.config.mode === "active" &&
      action.kind === "wait" &&
      (digest(stamp(records.stages)) !== digest(stamp(observation.ledger.stages)) ||
        digest(records.missingRuns) !== digest(observation.ledger.missingRuns))
    )
      action = {
        kind: "record",
        ledger: structuredClone(observation.ledger),
        reason: "checkpoint measured stages and missing-run infrastructure state",
      };
    const result: StepResult = {
      mode: this.config.mode,
      action: plannedAction,
      manifest: null,
      reason: maintenance ?? (plannedAction.kind === "wait" ? plannedAction.reason : null),
    };
    let ledger = structuredClone(observation.ledger);
    let effect: Effect = { kind: "record" };
    let bindings: Pull[] = [];
    if (action.kind === "wait") {
      result.reason = maintenance ? `${action.reason}; ${maintenance}` : action.reason;
      await this.stage(observation, result);
      return result;
    }
    if (action.kind === "build") {
      try {
        result.manifest = await this.git.build(action.spec);
        await this.journal.event(result.manifest, "builtAt", new Date().toISOString());
      } catch (error) {
        if (!(error instanceof MergeConflict)) throw error;
        const pull = action.spec.pulls.find((p) => p.number === error.number)!;
        if (this.config.mode === "shadow") {
          await this.journal.conflict(pull, observation.now);
          return this.step();
        }
        ledger.ejected.push({
          pull,
          batchId: digest(action.spec),
          reason: "merge-tree conflict against candidate predecessor",
          announced: false,
        });
        result.reason = error.message;
      }
      if (result.manifest) {
        if (!action.publish) {
          await this.stage(observation, result);
          return result;
        }
        bindings = action.spec.pulls;
        effect = {
          kind: "publish",
          branch: `${this.config.branchPrefix}${result.manifest.batchId}`,
          manifest: result.manifest,
        };
        if (action.recoveryIndex !== null) ledger.recovery.splice(action.recoveryIndex, 1);
      }
    } else if (action.kind === "record") ledger = action.ledger;
    else if (action.kind === "land") {
      const manifest = await this.git.inspect(action.candidate.manifest.tipSha);
      if (!(await this.git.ancestor(observation.baseSha, manifest.tipSha)))
        throw new Error("Landing would not fast-forward");
      // A fresh complete observation catches changed heads, edited/deleted
      // evidence, ready toggles, main races, reruns and invalid predecessors.
      const fresh = await this.journal.observe(await this.reader.observe());
      const replan = plan(fresh, this.config);
      if (
        fresh.stateSha !== observation.stateSha ||
        fresh.baseSha !== observation.baseSha ||
        replan.kind !== "land" ||
        replan.candidate.manifest.tipSha !== manifest.tipSha
      ) {
        result.reason = "landing observation changed; replan without mutation";
        await this.stage(fresh, result);
        return result;
      }
      bindings = manifest.pulls;
      effect = { kind: "land", manifest, expectedBase: observation.baseSha };
      ledger.landed.push(manifest.batchId);
    } else if (action.kind === "retry") {
      if (action.run.trusted && action.run.outcome === "code_failure") {
        const id = action.candidate.manifest.batchId;
        ledger.codeFailures[id] = [
          ...new Set([
            ...(ledger.codeFailures[id] ?? []),
            `${action.run.id}/${action.run.attempt}`,
          ]),
        ];
      }
      ledger.retries[action.candidate.manifest.batchId] = {
        runId: action.run.id,
        fromAttempt: action.run.attempt,
        requestedAt: observation.now,
      };
      effect = { kind: "retry", run: action.run };
    } else if (action.kind === "announce") {
      const key = bindingKey(action.ejection.pull);
      ledger.ejected = ledger.ejected.map((e) =>
        bindingKey(e.pull) === key ? { ...e, announced: true } : e,
      );
      effect = {
        kind: "announce",
        number: action.ejection.pull.number,
        key,
        body: `Merge batcher excluded exact head ${action.ejection.pull.headSha}: ${action.ejection.reason}. Batch: ${action.ejection.batchId}. A changed head or a new ready event can re-enter.\n\n<!-- batcher-ejection:${key} -->`,
      };
    }
    if (this.config.mode === "active") {
      if (
        observation.ledger.owner !== this.owner &&
        Date.parse(observation.ledger.expiresAt) > Date.parse(observation.now)
      )
        result.reason = "another controller owns the durable lease";
      else {
        ledger.owner = this.owner;
        ledger.epoch = observation.ledger.epoch + 1;
        ledger.expiresAt = new Date(
          Date.parse(observation.now) + this.config.leaseSeconds * 1000,
        ).toISOString();
        Object.assign(ledger, await this.journal.records(observation.now));
        if (effect.kind === "publish" || effect.kind === "land") {
          const sample = ledger.stages[effect.manifest.batchId];
          if (sample)
            sample[effect.kind === "land" ? "landedAt" : "publishedAt"] = new Date().toISOString();
        }
        ledger = this.executor?.prepareLedger?.(ledger, effect, observation.now) ?? ledger;
        const nextState = await this.git.stateCommit(ledger, observation.stateSha, observation.now);
        await this.executor!.transact({
          expectedState: observation.stateSha,
          nextState,
          expectedLedger: observation.ledger,
          nextLedger: ledger,
          now: observation.now,
          bindings,
          effect,
        });
        if (effect.kind === "publish" || effect.kind === "land")
          await this.journal.event(
            effect.manifest,
            effect.kind === "land" ? "landedAt" : "publishedAt",
            ledger.stages[effect.manifest.batchId]![
              effect.kind === "land" ? "landedAt" : "publishedAt"
            ]!,
          );
      }
    }
    await this.stage(observation, result);
    return result;
  }
  private async stage(observation: Observation, result: StepResult): Promise<void> {
    await mkdir(this.config.outputDir, { recursive: true });
    const data = canonical({
      schemaVersion: 1,
      observedAt: observation.now,
      baseSha: observation.baseSha,
      ready: observation.ready,
      excluded: observation.excluded,
      candidates: observation.candidates,
      stateSha: observation.stateSha,
      ledger: observation.ledger,
      result,
      providerCapabilities: this.executor?.capabilities ?? githubCapabilities,
      telemetry: observation.telemetry ?? null,
      measuredStages: (await this.journal.records(observation.now)).stages,
      missingRuns: observation.missingRuns ?? {},
      observationWarnings: observation.observationWarnings ?? [],
    });
    const destination = join(this.config.outputDir, "stage.json");
    const temporary = `${destination}.${this.owner}.tmp`;
    await writeFile(temporary, `${data}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    if (result.manifest) {
      const path = join(this.config.outputDir, `${result.manifest.batchId}.json`);
      await writeFile(path, `${canonical(result.manifest)}\n`, { mode: 0o600 });
      // Pin only LOCAL objects so disposable-cache GC cannot erase retained shadow evidence.
      await this.git.exec([
        "update-ref",
        `refs/batcher-local/${result.manifest.batchId}`,
        result.manifest.tipSha,
      ]);
    }
  }
}

export interface AdmissionCoordinator {
  capabilities: Capabilities;
  // A provider's transaction/fence, NOT a process-local lock. It must serialize
  // readiness/head edits and lease transfer with the supplied Git transaction,
  // and fence/deduplicate side effects by expected state and idempotency key.
  fenced(transaction: Transaction, commitRefs: () => Promise<void>): Promise<void>;
}
export class FencedGitExecutor implements Executor {
  readonly capabilities: Capabilities;
  constructor(
    readonly writer: AtomicGitWriter,
    readonly admission: AdmissionCoordinator,
  ) {
    this.capabilities = admission.capabilities;
  }
  async transact(t: Transaction): Promise<void> {
    requireActiveCapabilities(this.capabilities);
    if (t.nextLedger.epoch !== t.expectedLedger.epoch + 1 || t.nextState === t.expectedState)
      throw new Error("Invalid fence transition");
    if (
      t.expectedLedger.owner !== t.nextLedger.owner &&
      Date.parse(t.expectedLedger.expiresAt) > Date.parse(t.now)
    )
      throw new Error("Live lease cannot be stolen");
    const updates: RefUpdate[] = [
      { ref: this.writer.stateRef, expected: t.expectedState, next: t.nextState },
    ];
    if (t.effect.kind === "publish")
      updates.push({
        ref: `refs/heads/${t.effect.branch}`,
        expected: null,
        next: t.effect.manifest.tipSha,
      });
    if (t.effect.kind === "land")
      updates.push({
        ref: this.writer.baseRef,
        expected: t.effect.expectedBase,
        next: t.effect.manifest.tipSha,
      });
    await this.admission.fenced(t, () => this.writer.transaction(updates));
  }
}
