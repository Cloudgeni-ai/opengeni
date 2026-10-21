import {
  bindingKey,
  compareText,
  ejectionKey,
  type BatchSpec,
  type Candidate,
  type Config,
  type Ejection,
  type Ledger,
  type Observation,
  type Pull,
  type Run,
} from "./model";

export type Action =
  | { kind: "wait"; reason: string }
  | { kind: "record"; ledger: Ledger; reason: string }
  | { kind: "build"; spec: BatchSpec; publish: boolean; recoveryIndex: number | null }
  | { kind: "land"; candidate: Candidate }
  | { kind: "retry"; candidate: Candidate; run: Run }
  | { kind: "announce"; ejection: Ejection };

export function latestRun(candidate: Candidate, config: Config): Run | undefined {
  return candidate.runs
    .filter(
      (r) =>
        r.headSha === candidate.manifest.tipSha &&
        r.branch === candidate.branch &&
        r.workflow === config.workflow,
    )
    .sort((a, b) => b.id - a.id || b.attempt - a.attempt)[0];
}
export function fifo(pulls: Pull[], cap: number): Pull[] {
  const ordered = [...pulls].sort(
    (a, b) =>
      Date.parse(a.binding.at) - Date.parse(b.binding.at) ||
      compareText(a.binding.eventId, b.binding.eventId) ||
      a.number - b.number,
  );
  if (ordered[0]?.headRef === "changeset-release/main" || ordered[0]?.controlPlane)
    return ordered.slice(0, 1);
  const barrier = ordered.findIndex(
    (p) => p.headRef === "changeset-release/main" || p.controlPlane,
  );
  return ordered.slice(0, Math.min(cap, barrier < 0 ? ordered.length : barrier));
}
export function descendants(id: string, candidates: Candidate[]): string[] {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of candidates)
      if (
        c.manifest.predecessor &&
        ids.has(c.manifest.predecessor) &&
        !ids.has(c.manifest.batchId)
      ) {
        ids.add(c.manifest.batchId);
        changed = true;
      }
  }
  return [...ids];
}
export function plan(o: Observation, c: Config): Action {
  const ledger = structuredClone(o.ledger);
  const record = (reason: string): Action => ({ kind: "record", ledger, reason });
  const invalid = (id: string, reason: string): Action => {
    ledger.invalidated = [...new Set([...ledger.invalidated, ...descendants(id, o.candidates)])];
    return record(reason);
  };
  const fresh = new Map(o.ready.map((p) => [p.number, bindingKey(p)]));
  const matches = (p: Pull) => fresh.get(p.number) === bindingKey(p);
  for (const item of o.candidates) {
    const id = item.manifest.batchId;
    if (item.containedInBase && !ledger.landed.includes(id)) {
      ledger.landed.push(id);
      return record("reconstructed candidate tip already in main history");
    }
  }
  const live = o.candidates
    .filter(
      (x) =>
        !ledger.landed.includes(x.manifest.batchId) &&
        !ledger.invalidated.includes(x.manifest.batchId),
    )
    .sort(
      (a, b) =>
        Date.parse(a.manifest.createdAt) - Date.parse(b.manifest.createdAt) ||
        compareText(a.manifest.batchId, b.manifest.batchId),
    );
  for (const item of live) {
    if (item.manifest.pulls.some((p) => !matches(p)))
      return invalid(
        item.manifest.batchId,
        "head or ready/evidence binding changed; descendants invalidated, running CI preserved",
      );
    const parent = live.find((x) => x.manifest.batchId === item.manifest.predecessor);
    if (
      item.manifest.baseSha !== o.baseSha &&
      (!parent || parent.manifest.tipSha !== item.manifest.baseSha)
    )
      return invalid(item.manifest.batchId, "base/predecessor no longer applicable");
  }
  // Count even invalidated descendants: never cancel CI to recover a slot.
  const inflight = o.candidates.reduce(
    (n, x) =>
      n + x.runs.filter((r) => r.workflow === c.workflow && r.status !== "completed").length,
    0,
  );
  const root = live.find((x) => x.manifest.baseSha === o.baseSha);
  if (root) {
    const run = latestRun(root, c);
    if (run?.status === "completed") {
      if (run.trusted && run.outcome === "success")
        return o.mainBusy
          ? {
              kind: "wait",
              reason: "full-main CI has priority; tested candidate retained without cancellation",
            }
          : { kind: "land", candidate: root };
      if (run.trusted && run.outcome === "code_failure") {
        const children = descendants(root.manifest.batchId, o.candidates).filter(
          (id) => id !== root.manifest.batchId && !ledger.invalidated.includes(id),
        );
        if (children.length) {
          ledger.invalidated.push(...children);
          return record("code-red predecessor invalidates descendants; running CI preserved");
        }
      }
      const codeReds = new Set([
        ...(ledger.codeFailures[root.manifest.batchId] ?? []),
        ...root.runs
          .filter(
            (r) =>
              r.trusted &&
              r.outcome === "code_failure" &&
              r.status === "completed" &&
              r.headSha === root.manifest.tipSha &&
              r.branch === root.branch &&
              r.workflow === c.workflow,
          )
          .map((r) => `${r.id}/${r.attempt}`),
      ]).size;
      if (run.trusted && run.outcome === "code_failure" && (codeReds >= 2 || !run.retryable)) {
        ledger.invalidated = [
          ...new Set([...ledger.invalidated, ...descendants(root.manifest.batchId, o.candidates)]),
        ];
        const pulls: Pull[] = root.manifest.pulls.map(({ mergeSha: _, ...p }) => p);
        if (pulls.length === 1)
          ledger.ejected.push({
            pull: pulls[0]!,
            reason: !run.retryable
              ? "non-retryable exact-candidate code failure (process leak)"
              : "two exact-candidate code failures (including one whole-candidate retry)",
            batchId: root.manifest.batchId,
            announced: false,
          });
        else {
          const middle = Math.ceil(pulls.length / 2);
          ledger.recovery.unshift(
            { batchId: root.manifest.batchId, pulls: pulls.slice(0, middle) },
            { batchId: root.manifest.batchId, pulls: pulls.slice(middle) },
          );
        }
        return record(
          pulls.length === 1 ? "isolate exact-head culprit" : "deterministic bisection",
        );
      }
      const intent = ledger.retries[root.manifest.batchId];
      if (intent && intent.runId === run.id && intent.fromAttempt >= run.attempt)
        return {
          kind: "wait",
          reason:
            "retry intent awaiting provider reconciliation; no blind duplicate after unknown outcome",
        };
      const attempts = root.runs.length;
      if (attempts >= 8 && !(run.trusted && run.outcome === "code_failure"))
        return {
          kind: "wait",
          reason:
            "infrastructure retry budget exhausted; operator investigation required, no PR incriminated",
        };
      const backoff =
        run.trusted && run.outcome === "code_failure"
          ? 0
          : Math.min(3600, 60 * 2 ** Math.min(6, attempts - 1));
      if (
        !run.completedAt ||
        Date.parse(o.now) < Date.parse(run.completedAt) + backoff * 1000 ||
        inflight >= c.maxInflight ||
        o.mainBusy
      )
        return { kind: "wait", reason: "bounded retry backoff or CI capacity" };
      return { kind: "retry", candidate: root, run };
    }
    if (!run)
      return {
        kind: "wait",
        reason:
          "published candidate has no exact workflow run; inspect workflow admission/permissions",
      };
  }
  const unannounced = ledger.ejected.find((e) => !e.announced && !e.effectId);
  if (unannounced) return { kind: "announce", ejection: unannounced };
  // Recovery groups are tested sequentially against the actual landed base.
  if (!live.length && ledger.recovery.length) {
    const group = ledger.recovery[0]!;
    const pulls = group.pulls.filter(
      (p) => matches(p) && !ledger.ejected.some((e) => ejectionKey(e.pull) === ejectionKey(p)),
    );
    if (!pulls.length) {
      ledger.recovery.shift();
      return record("discard obsolete recovery bindings");
    }
    return makeBuild(
      o.baseSha,
      null,
      pulls,
      group.batchId,
      inflight < c.maxInflight && !o.mainBusy,
      0,
    );
  }
  if (ledger.recovery.length || live.some((item) => item.manifest.recoveryOf !== null))
    return { kind: "wait", reason: "bisection recovery is sequential; no speculative regrouping" };
  if (live.length >= c.speculationDepth)
    return { kind: "wait", reason: "speculation depth reached" };
  if (
    live.some((x) =>
      x.manifest.pulls.some((p) => p.headRef === "changeset-release/main" || p.controlPlane),
    )
  )
    return { kind: "wait", reason: "Version barrier in flight" };
  const assigned = new Set(live.flatMap((x) => x.manifest.pulls.map((p) => p.number)));
  const alreadyLanded = (p: Pull) =>
    o.candidates.some(
      (x) =>
        ledger.landed.includes(x.manifest.batchId) &&
        x.manifest.pulls.some(
          (member) => member.number === p.number && member.headSha === p.headSha,
        ),
    );
  const queued = o.ready.filter(
    (p) =>
      !assigned.has(p.number) &&
      !alreadyLanded(p) &&
      !ledger.ejected.some((e) => ejectionKey(e.pull) === ejectionKey(p)),
  );
  const pulls = fifo(queued, c.maxBatchSize);
  if (!pulls.length) return { kind: "wait", reason: "no eligible ready heads" };
  if (live.length && (pulls[0]!.headRef === "changeset-release/main" || pulls[0]!.controlPlane))
    return { kind: "wait", reason: "Version waits for preceding batches" };
  const tail = live.find((x) => !live.some((y) => y.manifest.predecessor === x.manifest.batchId));
  return makeBuild(
    tail?.manifest.tipSha ?? o.baseSha,
    tail?.manifest.batchId ?? null,
    pulls,
    null,
    inflight < c.maxInflight && !o.mainBusy,
    null,
  );
}
function makeBuild(
  baseSha: string,
  predecessor: string | null,
  pulls: Pull[],
  recoveryOf: string | null,
  publish: boolean,
  recoveryIndex: number | null,
): Action {
  return {
    kind: "build",
    publish,
    recoveryIndex,
    spec: {
      schemaVersion: 1,
      baseSha,
      predecessor,
      pulls,
      recoveryOf,
      createdAt: new Date(Math.max(...pulls.map((p) => Date.parse(p.binding.at)))).toISOString(),
    },
  };
}
