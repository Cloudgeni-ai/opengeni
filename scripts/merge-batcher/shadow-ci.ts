import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reader, StepResult } from "./controller";
import { AtomicGitWriter, GitStore } from "./git";
import { bindingKey, canonical, type Config, type Manifest, type Observation } from "./model";
import { fifo, latestRun } from "./planner";

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
    // readiness writes. The separately authorized state ref is the CAS slot.
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
  constructor(
    readonly config: Config,
    readonly reader: Reader,
    readonly git: GitStore,
    readonly publisher: CandidatePublisher,
    readonly owner: string,
    readonly outcomes?: OutcomeReader,
  ) {
    if (config.mode !== "shadow-ci") throw new Error("Shadow-ci controller requires explicit mode");
  }
  async step(): Promise<StepResult> {
    const o = await this.reader.observe();
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
    // Published-but-not-started also holds the slot. Count invalid/stale heads:
    // neither this mode nor the active controller cancels a running candidate.
    if (
      o.candidates.some(
        (candidate) =>
          !latestRun(candidate, this.config) ||
          candidate.runs.some(
            (run) => run.status !== "completed" && run.workflow === this.config.workflow,
          ),
      )
    )
      return wait("one hosted candidate slot occupied, including pending workflow admission");
    if (o.ledger.owner !== this.owner && Date.parse(o.ledger.expiresAt) > Date.parse(o.now))
      return wait("another shadow-ci writer holds the durable lease");
    const pulls = fifo(o.ready, this.config.maxBatchSize);
    if (!pulls.length) return wait("no eligible ready heads");
    const spec = {
      schemaVersion: 1 as const,
      baseSha: o.baseSha,
      predecessor: null,
      recoveryOf: null,
      createdAt: new Date(Math.max(...pulls.map((p) => Date.parse(p.binding.at)))).toISOString(),
      pulls,
    };
    const manifest = await this.git.build(spec);
    if (o.candidates.some((c) => c.manifest.batchId === manifest.batchId))
      return wait(
        "exact shadow candidate already observed; no automatic rerun or duplicate publication",
      );
    // No stale observed snapshot is knowingly published. A later PR metadata
    // race remains possible, but can never land on main from this mode.
    const fresh = await this.reader.observe();
    if (
      fresh.stateSha !== o.stateSha ||
      fresh.baseSha !== o.baseSha ||
      pulls.some((p) => !fresh.ready.some((current) => bindingKey(current) === bindingKey(p))) ||
      fresh.candidates.some(
        (c) =>
          !latestRun(c, this.config) ||
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
    const nextState = await this.git.stateCommit(ledger, o.stateSha, o.now);
    await this.publisher.publish(o.stateSha, nextState, manifest);
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
