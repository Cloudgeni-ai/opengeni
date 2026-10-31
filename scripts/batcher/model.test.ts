import { describe, expect, test } from "bun:test";
import {
  CI_WORKFLOW,
  DEFAULT_SETTINGS,
  decide,
  inBatchChanges,
  isControlPlane,
  nextBatch,
  numberTaken,
  numberedFiles,
  parseManifest,
  renderManifest,
  squashTitle,
  verdict,
  type Batch,
  type BatchRun,
  type Manifest,
  type QueuedPull,
} from "./model";

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const MAIN = sha(0xa);

function pull(number: number, extra: Partial<QueuedPull> = {}): QueuedPull {
  return {
    number,
    title: `Change ${number}`,
    headSha: sha(number),
    queuedAt: NOW - 30 * MINUTE + number,
    greenAt: NOW - 20 * MINUTE,
    conflict: null,
    renumber: [],
    regenerate: false,
    slots: [],
    priority: false,
    version: false,
    behind: false,
    controlPlane: false,
    ...extra,
  };
}

function run(extra: Partial<BatchRun> = {}): BatchRun {
  return {
    id: 1,
    workflow: CI_WORKFLOW,
    status: "completed",
    conclusion: "success",
    attempt: 1,
    url: "https://github.com/o/r/actions/runs/1",
    ...extra,
  };
}

function batch(numbers: number[], extra: Partial<Batch> = {}, pending: number[][] = []): Batch {
  const manifest: Manifest = {
    schemaVersion: 2,
    id: "0123456789ab",
    base: MAIN,
    members: numbers.map((number) => ({
      number,
      title: `Change ${number}`,
      head: sha(number),
      tree: sha(1000 + number),
    })),
    pending,
  };
  return {
    branch: `batch/${manifest.id}`,
    tip: sha(999),
    manifest,
    createdAt: NOW - 10 * MINUTE,
    runs: [run()],
    ...extra,
  };
}

const observe = (pulls: QueuedPull[], batches: Batch[] = []) => ({
  now: NOW,
  mainSha: MAIN,
  pulls,
  batches,
});

describe("verdict", () => {
  test("waits for CI to appear, then gives up after the start timeout", () => {
    expect(verdict(batch([1], { runs: [] }), NOW, DEFAULT_SETTINGS).kind).toBe("running");
    const old = batch([1], { runs: [], createdAt: NOW - 11 * MINUTE });
    expect(verdict(old, NOW, DEFAULT_SETTINGS).kind).toBe("missing");
  });

  test("needs every workflow on the tip to finish and pass", () => {
    const other = run({ id: 2, workflow: ".github/workflows/other.yml", status: "in_progress" });
    expect(verdict(batch([1], { runs: [run(), other] }), NOW, DEFAULT_SETTINGS).kind).toBe(
      "running",
    );
    const skipped = run({ id: 2, workflow: ".github/workflows/other.yml", conclusion: "skipped" });
    expect(verdict(batch([1], { runs: [run(), skipped] }), NOW, DEFAULT_SETTINGS).kind).toBe(
      "passed",
    );
  });

  test("retries failed jobs once before failing", () => {
    const failed = run({ conclusion: "failure" });
    expect(verdict(batch([1], { runs: [failed] }), NOW, DEFAULT_SETTINGS)).toEqual({
      kind: "retry",
      runs: [failed],
    });
    const again = run({ conclusion: "failure", attempt: 2 });
    expect(verdict(batch([1], { runs: [again] }), NOW, DEFAULT_SETTINGS).kind).toBe("failed");
  });
});

describe("nextBatch", () => {
  test("waits for the batching window, then takes ready PRs in queue order", () => {
    const fresh = [pull(2, { greenAt: NOW - MINUTE }), pull(1, { greenAt: NOW - MINUTE })];
    expect(nextBatch(fresh, [], NOW, DEFAULT_SETTINGS)).toEqual({
      kind: "wait",
      until: NOW - MINUTE + DEFAULT_SETTINGS.windowMs,
    });
    const action = nextBatch(
      [pull(2), pull(1), pull(3, { greenAt: null })],
      [],
      NOW,
      DEFAULT_SETTINGS,
    );
    expect(action?.kind === "build" && action.members.map((p) => p.number)).toEqual([1, 2]);
  });

  test("does not wait once the batch is full", () => {
    const pulls = [1, 2, 3].map((n) => pull(n, { greenAt: NOW }));
    const action = nextBatch(pulls, [], NOW, { ...DEFAULT_SETTINGS, maxBatch: 2 });
    expect(action?.kind === "build" && action.members.map((p) => p.number)).toEqual([1, 2]);
  });

  test("runs CI and Version changes alone", () => {
    const control = [pull(1, { controlPlane: true }), pull(2)];
    const first = nextBatch(control, [], NOW, DEFAULT_SETTINGS);
    expect(first?.kind === "build" && first.members.map((p) => p.number)).toEqual([1]);
    const later = nextBatch(
      [pull(1), pull(2, { controlPlane: true }), pull(3)],
      [],
      NOW,
      DEFAULT_SETTINGS,
    );
    expect(later?.kind === "build" && later.members.map((p) => p.number)).toEqual([1, 3]);
    const barrier = nextBatch(
      [pull(1), pull(2, { version: true }), pull(3)],
      [],
      NOW,
      DEFAULT_SETTINGS,
    );
    // A queued Version PR holds the queue, so it goes first and alone.
    expect(barrier?.kind === "build" && barrier.members.map((p) => p.number)).toEqual([2]);
  });

  test("a queued Version PR holds everything else until it is green and current", () => {
    const others = [pull(1), pull(2, { priority: true }), pull(3, { controlPlane: true })];
    const waiting = pull(5, { version: true, greenAt: null, headAt: NOW - 60_000 });
    expect(nextBatch([...others, waiting], [[1], [2]], NOW, DEFAULT_SETTINGS)).toEqual({
      kind: "hold",
      number: 5,
      headSha: waiting.headSha,
      headAt: NOW - 60_000,
      behind: false,
    });
    const behind = pull(5, { version: true, behind: true });
    expect(nextBatch([...others, behind], [], NOW, DEFAULT_SETTINGS)).toMatchObject({
      kind: "hold",
      number: 5,
      behind: true,
    });
    // Green and current: it builds alone and keeps a bisection for later.
    const green = pull(5, { version: true });
    expect(nextBatch([...others, green], [[1], [2]], NOW, DEFAULT_SETTINGS)).toEqual({
      kind: "build",
      members: [green],
      pending: [[1], [2]],
    });
  });

  test("a running batch finishes while a Version PR holds the queue", () => {
    const waiting = pull(5, { version: true, greenAt: null });
    const running = batch([1, 2], { runs: [run({ status: "in_progress", conclusion: null })] });
    expect(decide(observe([pull(1), pull(2), waiting], [running]))).toEqual([]);
    const passed = batch([1, 2], { runs: [run()] });
    expect(decide(observe([pull(1), pull(2), pull(3), waiting], [passed]))).toEqual([
      { kind: "land", batch: passed },
      { kind: "hold", number: 5, headSha: waiting.headSha, headAt: 0, behind: false },
    ]);
  });

  test("priority PRs go first, together", () => {
    const pulls = [pull(1), pull(2, { priority: true }), pull(3, { priority: true })];
    const action = nextBatch(pulls, [], NOW, DEFAULT_SETTINGS);
    expect(action?.kind === "build" && action.members.map((p) => p.number)).toEqual([2, 3]);
  });

  test("continues a bisection before new PRs", () => {
    const action = nextBatch(
      [pull(1), pull(2), pull(3), pull(4)],
      [[3], [4]],
      NOW,
      DEFAULT_SETTINGS,
    );
    expect(action).toMatchObject({ kind: "build", pending: [[4]] });
    expect(action?.kind === "build" && action.members.map((p) => p.number)).toEqual([3]);
  });

  test("keeps PRs that add the same numbered file out of one batch", () => {
    const slot = "packages/db/drizzle/1072";
    const action = nextBatch(
      [pull(1, { slots: [slot] }), pull(2, { slots: [slot] }), pull(3)],
      [],
      NOW,
      DEFAULT_SETTINGS,
    );
    expect(action?.kind === "build" && action.members.map((p) => p.number)).toEqual([1, 3]);
  });
});

describe("decide", () => {
  test("ejects conflicting PRs", () => {
    const actions = decide(observe([pull(1, { conflict: "it conflicts with main." }), pull(2)]));
    expect(actions[0]).toMatchObject({
      kind: "eject",
      number: 1,
      reason: "it conflicts with main.",
    });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([2]);
  });

  test("moves a migration main took the number of, and batches the PR only after that", () => {
    const moving = ["packages/db/drizzle/1071_usage_residency.sql"];
    const actions = decide(observe([pull(1, { renumber: moving }), pull(2)]));
    expect(actions[0]).toEqual({ kind: "renumber", number: 1, paths: moving });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([2]);
  });

  test("regenerates a conflicting PR before it can be batched, even a priority one", () => {
    const actions = decide(observe([pull(1, { regenerate: true, priority: true }), pull(2)]));
    expect(actions[0]).toEqual({ kind: "regenerate", number: 1 });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([2]);
  });

  test("lands a passed batch and starts the next one", () => {
    const actions = decide(observe([pull(1), pull(2), pull(3)], [batch([1, 2])]));
    expect(actions.map((a) => a.kind)).toEqual(["land", "build"]);
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([3]);
  });

  test("leaves a running batch alone", () => {
    const running = batch([1], { runs: [run({ status: "in_progress", conclusion: null })] });
    expect(decide(observe([pull(1), pull(2)], [running]))).toEqual([]);
  });

  test("splits a failed batch and tests the first half next", () => {
    const failed = batch([1, 2, 3], { runs: [run({ conclusion: "failure", attempt: 2 })] });
    const actions = decide(observe([pull(1), pull(2), pull(3)], [failed]));
    expect(actions[0]).toMatchObject({ kind: "abandon", reason: "its CI failed" });
    expect(actions[1]).toMatchObject({ kind: "build", pending: [[3]] });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([1, 2]);
  });

  test("splits a failed batch of priority PRs instead of building it again whole", () => {
    const urgent = { priority: true };
    const failed = batch([1, 2, 3, 4], { runs: [run({ conclusion: "failure", attempt: 2 })] });
    const pulls = [pull(1, urgent), pull(2, urgent), pull(3, urgent), pull(4, urgent)];
    const actions = decide(observe(pulls, [failed]));
    expect(actions[0]).toMatchObject({ kind: "abandon", reason: "its CI failed" });
    expect(actions[1]).toMatchObject({ kind: "build", pending: [[3, 4]] });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([1, 2]);
  });

  test("a new priority PR goes before the halves of a failed priority batch", () => {
    const urgent = { priority: true };
    const failed = batch([1, 2, 3, 4], { runs: [run({ conclusion: "failure", attempt: 2 })] });
    // Queued after the batch's members, and a CI change, so it runs alone.
    const fix = pull(5, { priority: true, controlPlane: true, queuedAt: NOW });
    const pulls = [pull(1, urgent), pull(2, urgent), pull(3, urgent), pull(4, urgent), fix];
    const actions = decide(observe(pulls, [failed]));
    expect(actions[1]).toMatchObject({
      kind: "build",
      pending: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([5]);
  });

  test("ejects a PR that fails alone, keeping the rest of the bisection", () => {
    const failed = batch([3], { runs: [run({ conclusion: "failure", attempt: 2 })] }, [[4]]);
    const actions = decide(observe([pull(3), pull(4), pull(5)], [failed]));
    expect(actions.map((a) => a.kind)).toEqual(["abandon", "eject", "build"]);
    expect(actions[1]).toMatchObject({ number: 3 });
    expect(actions[2]?.kind === "build" && actions[2].members.map((p) => p.number)).toEqual([4]);
  });

  test("retries failed jobs instead of judging", () => {
    const flaky = batch([1], { runs: [run({ conclusion: "failure" })] });
    expect(decide(observe([pull(1)], [flaky])).map((a) => a.kind)).toEqual(["retry"]);
  });

  test("rebuilds when main moved or a member changed", () => {
    const moved = decide({ ...observe([pull(1)], [batch([1])]), mainSha: sha(0xb) });
    expect(moved[0]).toMatchObject({
      kind: "abandon",
      reason: "main moved since the batch was built",
    });
    expect(moved[1]?.kind).toBe("build");
    expect(moved[0]).not.toHaveProperty("changed");
    const changed = decide(observe([pull(1, { headSha: sha(77) })], [batch([1])]));
    expect(changed[0]).toMatchObject({ kind: "abandon", reason: "#1 has a new head", changed: 1 });
    const sameTree = decide(
      observe([pull(1, { headSha: sha(77) })], [batch([1], { sameTree: { 1: sha(77) } })]),
    );
    expect(sameTree.some((a) => a.kind === "abandon")).toBe(false);
    const left = decide(observe([pull(2)], [batch([1, 2])]));
    expect(left[0]).toMatchObject({ kind: "abandon", reason: "#1 left the queue", changed: 1 });
    // The rest is rebuilt at once, without waiting for the batching window.
    expect(left[1]?.kind === "build" && left[1].members.map((p) => p.number)).toEqual([2]);
  });

  test("a ready priority PR waits for the running batch, then goes next", () => {
    const running = batch([1], { runs: [run({ status: "in_progress", conclusion: null })] });
    const waiting = decide(observe([pull(1), pull(2, { priority: true })], [running]));
    expect(waiting).toEqual([]);
    const passed = batch([1], { runs: [run({ status: "completed", conclusion: "success" })] });
    const actions = decide(observe([pull(1), pull(2, { priority: true }), pull(3)], [passed]));
    expect(actions[0]).toMatchObject({ kind: "land" });
    expect(actions[1]?.kind === "build" && actions[1].members.map((p) => p.number)).toEqual([2]);
  });

  test("keeps only the newest batch", () => {
    const older = batch([1], { createdAt: NOW - 20 * MINUTE, branch: "batch/old" });
    const newer = batch([1], { runs: [run({ status: "in_progress", conclusion: null })] });
    const actions = decide(observe([pull(1)], [older, newer]));
    expect(actions).toEqual([
      { kind: "abandon", batch: older, reason: "only one batch runs at a time" },
    ]);
  });
});

describe("inBatchChanges", () => {
  test("adds missing members and removes everyone else", () => {
    expect(inBatchChanges([1, 2, 3], [2, 4, 5])).toEqual({ add: [1, 3], remove: [4, 5] });
    expect(inBatchChanges([], [7])).toEqual({ add: [], remove: [7] });
    expect(inBatchChanges([7], [7])).toEqual({ add: [], remove: [] });
  });
});

describe("manifest and titles", () => {
  test("round-trips and rejects anything malformed", () => {
    const manifest = batch([1, 2], {}, [[3]]).manifest;
    expect(parseManifest(`unrelated\n\n${renderManifest(manifest).split("\n\n")[1]}`)).toEqual(
      manifest,
    );
    expect(parseManifest(renderManifest({ ...manifest, base: "main" }))).toBeNull();
    expect(parseManifest("Batch-Manifest: {")).toBeNull();
    expect(parseManifest("no trailer")).toBeNull();
  });

  test("squash titles carry the PR number once", () => {
    expect(squashTitle({ number: 12, title: "Fix the thing" })).toBe("Fix the thing (#12)");
    expect(squashTitle({ number: 12, title: " Fix the thing (#12) " })).toBe("Fix the thing (#12)");
  });

  test("CI and batcher changes are control-plane", () => {
    expect(isControlPlane(["packages/a/x.ts", ".github/workflows/ci.yml"])).toBe(true);
    expect(isControlPlane(["scripts/batcher/pass.ts"])).toBe(true);
    expect(isControlPlane(["packages/a/x.ts", "docs/x.md"])).toBe(false);
  });

  test("a migration number main already uses for another file is taken", () => {
    const main = numberedFiles([
      "packages/db/drizzle/1071_site_project_placements.sql",
      "packages/db/drizzle/README.md",
    ]);
    expect(main).toEqual([
      {
        slot: "packages/db/drizzle/1071",
        number: "1071",
        path: "packages/db/drizzle/1071_site_project_placements.sql",
      },
    ]);
    const taken = numberTaken(
      numberedFiles(["packages/db/drizzle/1071_usage_residency.sql", "packages/db/src/x.ts"]),
      main,
    );
    expect(taken).toBe(
      "`1071_usage_residency.sql` uses number 1071, which main already uses for `1071_site_project_placements.sql`. Merge main into the branch and move it to the next free number: `bun scripts/renumber-migration.ts 1071_usage_residency --next`.",
    );
    // The same file already on main, and a free number, are fine.
    expect(numberTaken(main, main)).toBeNull();
    expect(numberTaken(numberedFiles(["packages/db/drizzle/1072_x.sql"]), main)).toBeNull();
  });
});
