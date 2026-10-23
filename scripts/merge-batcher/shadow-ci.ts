import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reader, StepResult } from "./controller";
import { AtomicGitWriter, GitStore, MergeConflict } from "./git";
import { bindingKey, canonical, type Config, type Manifest, type Observation } from "./model";
import { fifo, latestRun } from "./planner";
import { ObservationJournal } from "./journal";

export interface CandidatePublisher {
  publish(expectedState: string | null, nextState: string, manifest: Manifest): Promise<void>;
}
export class QueueOnlyPublisher implements CandidatePublisher {
  constructor(
    readonly config: Config,
    readonly writer: AtomicGitWriter,
  ) {
    if (
      config.mode !== "shadow-ci" ||
      writer.stateRef !== config.stateRef ||
      writer.baseRef !== `refs/heads/${config.baseBranch}` ||
      config.stateRef === writer.baseRef ||
      config.stateRef.startsWith(`refs/heads/${config.branchPrefix}`)
    )
      throw new Error("Invalid queue-only publisher configuration");
  }
  async publish(
    expectedState: string | null,
    nextState: string,
    manifest: Manifest,
  ): Promise<void> {
    // This surface cannot express main, labels, comments, reruns, deletes or
    // readiness writes. The configured routine state ref is the CAS slot.
    await this.writer.transaction([
      { ref: this.config.stateRef, expected: expectedState, next: nextState },
      {
        ref: `refs/heads/${this.config.branchPrefix}${manifest.batchId}`,
        expected: null,
        next: manifest.tipSha,
      },
    ]);
  }
}
export interface MainOutcome {
  headSha: string;
  runId: number;
  runAttempt: number;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
export interface OutcomeReader {
  mainOutcomes(headSha: string): Promise<MainOutcome[]>;
}
export class ShadowCiController {
  readonly journal: ObservationJournal;
  constructor(
    readonly config: Config,
    readonly reader: Reader,
    readonly git: GitStore,
    readonly publisher: CandidatePublisher,
    readonly owner: string,
    readonly outcomes?: OutcomeReader,
  ) {
    if (config.mode !== "shadow-ci") throw new Error("Shadow-ci controller requires explicit mode");
    this.journal = new ObservationJournal(config);
  }
  async step(): Promise<StepResult> {
    const o = await this.journal.observe(await this.reader.observe());
    const wait = async (reason: string): Promise<StepResult> => {
      const result: StepResult = {
        mode: "shadow-ci",
        action: { kind: "wait", reason },
        manifest: null,
        reason,
      };
      await this.stage(o, result);
      return result;
    };
    if (o.telemetry?.status === "stop")
      return wait(
        "stop signal: recent 2h sampled capacity/OFF-adjusted p95 ready-to-CI exceeds 30 minutes",
      );
    if (
      o.candidates.some(
        (c) => !c.runs.length && o.missingRuns?.[c.manifest.batchId]?.status === "abandoned",
      )
    )
      return wait(
        "missing-run infrastructure hold expired; abandoned pending explicit recover-missing-run confirmation",
      );
    // Published-but-not-started also holds the slot. Count invalid/stale heads:
    // neither this mode nor the active controller cancels a running candidate.
    if (
      o.candidates.some(
        (candidate) =>
          (!latestRun(candidate, this.config) &&
            o.missingRuns?.[candidate.manifest.batchId]?.status !== "released") ||
          candidate.runs.some(
            (run) => run.status !== "completed" && run.workflow === this.config.workflow,
          ),
      )
    )
      return wait("one hosted candidate slot occupied, including pending workflow admission");
    if (o.ledger.owner !== this.owner && Date.parse(o.ledger.expiresAt) > Date.parse(o.now))
      return wait("another shadow-ci writer holds the durable lease");
    const pulls = fifo(o.ready, this.config.maxBatchSize);
    if (o.mainBusy)
      return wait(
        o.headroom?.reason ?? "full-main CI has priority; no new shadow candidate publication",
      );
    if (!pulls.length) return wait("no eligible ready heads");
    const spec = {
      schemaVersion: 1 as const,
      baseSha: o.baseSha,
      predecessor: null,
      recoveryOf: null,
      createdAt: new Date(Math.max(...pulls.map((p) => Date.parse(p.binding.at)))).toISOString(),
      pulls,
    };
    let manifest: Manifest;
    try {
      manifest = await this.git.build(spec);
    } catch (error) {
      if (!(error instanceof MergeConflict)) throw error;
      await this.journal.conflict(pulls.find((p) => p.number === error.number)!, o.now);
      return this.step();
    }
    await this.journal.event(manifest, "builtAt", new Date().toISOString());
    if (o.candidates.some((c) => c.manifest.batchId === manifest.batchId))
      return wait(
        "exact shadow candidate already observed; no automatic rerun or duplicate publication",
      );
    // No stale observed snapshot is knowingly published. A later PR metadata
    // race remains possible, but can never land on main from this mode.
    const fresh = await this.journal.observe(await this.reader.observe());
    if (
      fresh.stateSha !== o.stateSha ||
      fresh.baseSha !== o.baseSha ||
      fresh.mainBusy ||
      fresh.telemetry?.status === "stop" ||
      pulls.some((p) => !fresh.ready.some((current) => bindingKey(current) === bindingKey(p))) ||
      fresh.candidates.some(
        (c) =>
          (!latestRun(c, this.config) &&
            fresh.missingRuns?.[c.manifest.batchId]?.status !== "released") ||
          c.runs.some((r) => r.status !== "completed" && r.workflow === this.config.workflow),
      )
    )
      return wait("publication snapshot changed; re-observe without writes");
    const ledger = {
      ...o.ledger,
      owner: this.owner,
      epoch: o.ledger.epoch + 1,
      expiresAt: new Date(Date.parse(o.now) + this.config.leaseSeconds * 1000).toISOString(),
    };
    Object.assign(ledger, await this.journal.records(o.now));
    ledger.stages[manifest.batchId]!.publishedAt = new Date().toISOString();
    const nextState = await this.git.stateCommit(ledger, o.stateSha, o.now);
    await this.publisher.publish(o.stateSha, nextState, manifest);
    await this.journal.event(
      manifest,
      "publishedAt",
      ledger.stages[manifest.batchId]!.publishedAt!,
    );
    const result: StepResult = {
      mode: "shadow-ci",
      action: { kind: "build", spec, publish: true, recoveryIndex: null },
      manifest,
      reason: "published queue-only candidate; main and PR state unchanged",
    };
    await this.stage(o, result);
    return result;
  }
  private async stage(o: Observation, result: StepResult): Promise<void> {
    const comparisons = [];
    const baselines = new Map<string, MainOutcome[]>();
    for (const c of o.candidates) {
      const head = c.manifest.baseSha;
      if (!baselines.has(head))
        baselines.set(head, this.outcomes ? await this.outcomes.mainOutcomes(head) : []);
      const latest = latestRun(c, this.config);
      const duration =
        latest?.startedAt && latest.completedAt
          ? (Date.parse(latest.completedAt) - Date.parse(latest.startedAt)) / 1000
          : null;
      comparisons.push({
        batchId: c.manifest.batchId,
        testedTip: c.manifest.tipSha,
        outcome: latest?.outcome ?? "unknown",
        trusted: latest?.trusted ?? false,
        candidateSeconds: duration,
        baseSha: head,
        mainRuns: baselines.get(head),
        interpretation:
          "Baseline comparison, not equivalent trees: shadow candidate includes unlanded PR heads.",
      });
    }
    await mkdir(this.config.outputDir, { recursive: true });
    const destination = join(this.config.outputDir, "stage.json"),
      temporary = `${destination}.${this.owner}.tmp`;
    await writeFile(
      temporary,
      canonical({
        schemaVersion: 1,
        observedAt: o.now,
        baseSha: o.baseSha,
        ready: o.ready,
        excluded: o.excluded,
        candidates: o.candidates,
        result,
        comparisons,
        telemetry: o.telemetry ?? null,
        headroom: o.headroom ?? null,
        measuredStages: (await this.journal.records(o.now)).stages,
        missingRuns: o.missingRuns ?? {},
        observationWarnings: o.observationWarnings ?? [],
      }),
      { mode: 0o600 },
    );
    await rename(temporary, destination);
    if (result.manifest)
      await writeFile(
        join(this.config.outputDir, `${result.manifest.batchId}.json`),
        canonical(result.manifest),
        { mode: 0o600 },
      );
  }
}
