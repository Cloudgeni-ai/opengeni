import { expect, test } from "bun:test";
import { priorityActive } from "./github-admission";
import {
  config,
  digest,
  emptyLedger,
  type BaseCiEvidence,
  type Candidate,
  type Manifest,
  type Observation,
  type Pull,
  type Run,
} from "./model";
import { exactBaseRed, fifo, plan } from "./planner";

const NOW = "2026-10-26T12:00:00.000Z";
const BASE = "b".repeat(40);
const cfg = config({});

function pull(number: number, second = number, headRef = `feature-${number}`): Pull {
  return {
    number,
    headSha: String(number % 10).repeat(40),
    headRef,
    binding: {
      eventId: `event-${number}`,
      at: new Date(Date.parse(NOW) - 3600_000 + second * 1000).toISOString(),
      source: "queue-ready",
      evidenceId: `${number}`,
      evidenceDigest: digest(number),
    },
  };
}
function candidate(pulls: Pull[], baseSha = BASE, predecessor: string | null = null): Candidate {
  const spec = {
    schemaVersion: 1 as const,
    baseSha,
    predecessor,
    recoveryOf: null,
    createdAt: NOW,
    pulls,
  };
  const batchId = digest(spec);
  const manifest: Manifest = {
    ...spec,
    batchId,
    tipSha: digest(batchId).slice(0, 40),
    pulls: pulls.map((p) => ({ ...p, mergeSha: digest(p).slice(0, 40) })),
  };
  return { manifest, branch: `${cfg.branchPrefix}${batchId}`, runs: [], containedInBase: false };
}
function run(c: Candidate, status: Run["status"], outcome: Run["outcome"], id = 100): Run {
  return {
    id,
    attempt: 1,
    headSha: c.manifest.tipSha,
    branch: c.branch,
    workflow: cfg.workflow,
    status,
    outcome,
    trusted: status === "completed",
    retryable: outcome === "code_failure",
    completedAt: status === "completed" ? NOW : null,
    ...(outcome === "code_failure" ? { failedClasses: ["units" as const] } : {}),
  };
}
const red: BaseCiEvidence = {
  sha: BASE,
  status: "red",
  runId: 50,
  attempt: 1,
  reason: "fixture red main",
  classes: { source: "green", units: "red" },
};
function observation(
  ready: Pull[],
  candidates: Candidate[],
  priority: number[] = [],
  baseCI: BaseCiEvidence | null = red,
): Observation {
  return {
    now: NOW,
    baseSha: BASE,
    ...(baseCI ? { baseCI } : {}),
    ready,
    excluded: [],
    candidates,
    stateSha: null,
    ledger: emptyLedger(),
    ...(priority.length ? { priority } : {}),
  };
}
/** The incident: a 16-PR batch failed on a red base and held the only slot. */
function incident() {
  const members = Array.from({ length: 16 }, (_, i) => pull(i + 1));
  const fix = pull(6266, 9999);
  const root = candidate(members);
  root.runs = [run(root, "completed", "code_failure")];
  return { members, fix, root };
}

test("fifo sorts trusted priority heads first and runs one alone, ahead of Version", () => {
  const version = pull(5, 0, "changeset-release/main");
  const older = [pull(1), pull(2), pull(3)];
  expect(fifo([...older, pull(9, 99)], 16).map((p) => p.number)).toEqual([1, 2, 3, 9]);
  expect(fifo([...older, pull(9, 99)], 16, new Set([9])).map((p) => p.number)).toEqual([9]);
  expect(fifo([version, ...older, pull(9, 99)], 16, new Set([9]))).toEqual([pull(9, 99)]);
  expect(
    fifo([pull(8, 98), pull(9, 99), ...older], 16, new Set([9, 8])).map((p) => p.number),
  ).toEqual([8]);
  // A label on a PR outside the admitted set changes nothing.
  expect(fifo(older, 16, new Set([9])).map((p) => p.number)).toEqual([1, 2, 3]);
});
test("without a priority fix, a failed red-base batch keeps its existing hold", () => {
  const { members, fix, root } = incident();
  const action = plan(observation([...members, fix], [root]), cfg);
  expect(action).toMatchObject({ kind: "wait" });
  expect((action as { reason: string }).reason).toContain("no retry, split or parking");
});
test("a priority fix abandons a failed red-base batch without blame and then runs alone", () => {
  const { members, fix, root } = incident();
  const o = observation([...members, fix], [root], [fix.number]);
  const action = plan(o, cfg);
  expect(action.kind).toBe("abandon");
  if (action.kind !== "abandon") throw Error("expected abandon");
  expect(action.runs).toEqual([]);
  expect(action.ledger.invalidated).toEqual([root.manifest.batchId]);
  expect(action.ledger.parked ?? []).toEqual([]);
  expect(action.ledger.ejected).toEqual([]);
  expect(action.ledger.recovery).toEqual([]);
  // Next tick: the members return to the FIFO behind the fix, which runs alone.
  const next = plan({ ...o, ledger: action.ledger }, cfg);
  expect(next).toMatchObject({ kind: "build", publish: true });
  if (next.kind !== "build") throw Error("expected build");
  expect(next.spec.pulls.map((p) => p.number)).toEqual([fix.number]);
  expect(next.spec.baseSha).toBe(BASE);
  expect(next.spec.predecessor).toBeNull();
});
test("a running red-base batch and its speculative child are abandoned and their Batch CI cancelled", () => {
  const fix = pull(6266, 9999);
  const root = candidate([pull(1), pull(2)]);
  root.runs = [run(root, "in_progress", "unknown", 100)];
  const child = candidate([pull(3)], root.manifest.tipSha, root.manifest.batchId);
  child.runs = [run(child, "queued", "unknown", 101)];
  const o = observation([pull(1), pull(2), pull(3), fix], [root, child], [fix.number]);
  const settings = { ...cfg, maxInflight: 2 };
  const action = plan(o, settings);
  expect(action.kind).toBe("abandon");
  if (action.kind !== "abandon") throw Error("expected abandon");
  expect(action.ledger.invalidated.sort()).toEqual(
    [root.manifest.batchId, child.manifest.batchId].sort(),
  );
  expect(action.runs.map((r) => r.id).sort()).toEqual([100, 101]);
  // Until the provider reports the cancellations terminal, the slots stay
  // reserved: the fix is built locally but not published, and nothing repeats.
  const ledger = structuredClone(action.ledger);
  for (const r of action.runs)
    ledger.effects[`cancel-${r.id}`] = {
      id: `cancel-${r.id}`,
      kind: "cancel",
      run: r,
      batchId: r.branch.slice(cfg.branchPrefix.length),
      status: "done",
      attempts: 1,
      checks: 0,
      nextAt: NOW,
      lastError: null,
    };
  const waiting = plan({ ...o, ledger }, settings);
  expect(waiting).toMatchObject({ kind: "build", publish: false });
  root.runs[0] = { ...root.runs[0]!, status: "completed", outcome: "cancelled", completedAt: NOW };
  child.runs[0] = {
    ...child.runs[0]!,
    status: "completed",
    outcome: "cancelled",
    completedAt: NOW,
  };
  const freed = plan({ ...o, ledger }, settings);
  expect(freed).toMatchObject({ kind: "build", publish: true });
  if (freed.kind !== "build") throw Error("expected build");
  expect(freed.spec.pulls.map((p) => p.number)).toEqual([fix.number]);
});
test("preemption needs a conclusively red exact base", () => {
  const { members, fix, root } = incident();
  const variants: (BaseCiEvidence | null)[] = [
    null,
    { ...red, status: "unknown" },
    { ...red, status: "green" },
    { ...red, sha: "c".repeat(40) },
    { ...red, runId: null },
    { ...red, status: "classes", classes: { source: "green", units: "unknown" } },
  ];
  for (const base of variants) {
    expect(exactBaseRed(base ?? undefined, BASE)).toBe(false);
    expect(plan(observation([...members, fix], [root], [fix.number], base), cfg).kind).not.toBe(
      "abandon",
    );
  }
  const failingJob = { ...red, status: "classes" as const };
  expect(exactBaseRed(failingJob, BASE)).toBe(true);
  expect(plan(observation([...members, fix], [root], [fix.number], failingJob), cfg).kind).toBe(
    "abandon",
  );
});
test("a tested green tip, a priority candidate, a run-less reservation and an ineligible fix are never abandoned", () => {
  const { members, fix, root } = incident();
  const green = candidate(members);
  green.runs = [run(green, "completed", "success")];
  expect(plan(observation([...members, fix], [green], [fix.number]), cfg).kind).toBe("land");

  const fixRoot = candidate([fix]);
  fixRoot.runs = [run(fixRoot, "completed", "code_failure")];
  expect(
    plan(observation([...members, fix, pull(7000, 9998)], [fixRoot], [fix.number, 7000]), cfg).kind,
  ).toBe("wait");

  const published = candidate(members);
  expect(plan(observation([...members, fix], [published], [fix.number]), cfg).kind).toBe("wait");

  const parked = observation([...members, fix], [root], [fix.number]);
  parked.ledger.parked = [
    {
      pull: fix,
      baseSha: BASE,
      batchId: "f".repeat(64),
      cohortId: "f".repeat(64),
      runId: 9,
      attempt: 1,
      parkedAt: NOW,
      announced: true,
    },
  ];
  expect(plan(parked, cfg).kind).toBe("wait");
  // A label on a PR that is not admitted ready grants nothing.
  expect(plan(observation(members, [root], [fix.number]), cfg).kind).toBe("wait");
});
test("invalidated running Batch CI is cancelled only to free the slot for a priority fix", () => {
  const fix = pull(6266, 9999);
  const stale = candidate([pull(1)], "c".repeat(40));
  stale.runs = [run(stale, "in_progress", "unknown", 300)];
  const o = observation([pull(1), fix], [stale], [fix.number]);
  o.ledger.invalidated = [stale.manifest.batchId];
  const action = plan(o, cfg);
  expect(action).toMatchObject({ kind: "abandon" });
  if (action.kind !== "abandon") throw Error("expected abandon");
  expect(action.runs.map((r) => r.id)).toEqual([300]);
  expect(plan({ ...o, priority: [] }, cfg)).toMatchObject({ kind: "build", publish: false });
  expect(plan({ ...o, baseCI: { ...red, status: "green" } }, cfg)).toMatchObject({
    kind: "build",
    publish: false,
  });
});
test("on a red base a priority fix runs before pending bisection groups, which then resume", () => {
  const fix = pull(6266, 9999);
  const o = observation([pull(1), pull(2), fix], [], [fix.number]);
  o.ledger.recovery = [{ batchId: "e".repeat(64), pulls: [pull(1), pull(2)] }];
  const action = plan(o, cfg);
  expect(action).toMatchObject({ kind: "build", publish: true });
  if (action.kind !== "build") throw Error("expected build");
  expect(action.spec.pulls.map((p) => p.number)).toEqual([fix.number]);
  expect(action.spec.recoveryOf).toBeNull();
  expect(action.recoveryIndex).toBeNull();
  const green = plan({ ...o, baseCI: { ...red, status: "green" } }, cfg);
  if (green.kind !== "build") throw Error("expected build");
  expect(green.spec.pulls.map((p) => p.number)).toEqual([1, 2]);
});
test("priority label state needs a present label and a latest add event", () => {
  const add = { id: "a", at: "2026-10-26T10:00:00Z", enabled: true };
  const remove = { id: "b", at: "2026-10-26T11:00:00Z", enabled: false };
  expect(priorityActive(true, [add])).toBe(true);
  expect(priorityActive(true, [add, remove])).toBe(false);
  expect(priorityActive(true, [remove, { ...add, at: "2026-10-26T12:00:00Z" }])).toBe(true);
  expect(priorityActive(false, [add])).toBe(false);
  expect(priorityActive(true, [])).toBe(false);
  expect(priorityActive(true, [{ ...add, at: "not a time" }])).toBe(false);
});
