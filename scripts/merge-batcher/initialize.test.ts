import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicGitWriter, GitStore } from "./git";
import {
  initializeActiveState,
  reserveInitialization,
  type StoppedInitializationObservation,
} from "./initialize";
import { emptyLedger, requireInitializedState } from "./model";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const now = new Date("2026-10-22T19:30:00Z");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batcher-init-"));
  roots.push(root);
  const origin = new GitStore(join(root, "remote.git"));
  await origin.init();
  const git = new GitStore(join(root, "local.git"));
  await git.init();
  const tree = await origin.exec(["mktree"], "");
  const main = await origin.commit(tree, [], "main", now.toISOString());
  await origin.exec(["update-ref", "refs/heads/main", main]);
  const writer = new AtomicGitWriter(
    git,
    origin.dir,
    "refs/heads/batcher-state",
    "refs/heads/main",
  );
  const observation: StoppedInitializationObservation = {
    serviceUid: "fixture",
    serviceGeneration: "17",
    image: `repo@sha256:${"a".repeat(64)}`,
    stopGeneration: "stop-1",
    observedAt: now.toISOString(),
    manualZero: true,
    stopPersisted: true,
    writerExited: true,
    routingSafe: true,
    instances: 0,
    instancesComplete: true,
    pendingEffects: false,
  };
  const records: unknown[] = [];
  const deps = {
    observeStopped: async () => ({ ...observation }),
    reserve: (intent: unknown) => reserveInitialization(join(root, "init-intent.json"), intent),
    record: async (record: unknown) => {
      records.push(record);
    },
    now: () => now,
  };
  return { root, origin, git, writer, main, observation, deps, records };
}
test("virgin init creates stamped state, preserves historical shadow, refuses a second init", async () => {
  const f = await fixture();
  await f.origin.exec(["update-ref", "refs/heads/queue/shadow-traffic/history", f.main]);
  const result = await initializeActiveState(f.git, f.writer, f.deps);
  const ledger = await f.git.readLedger(result.stateSha);
  expect(ledger.initialization?.serviceGeneration).toBe("17");
  expect(ledger.effects).toEqual({});
  expect(ledger.epoch).toBe(0);
  expect(() => requireInitializedState(result.stateSha, ledger)).not.toThrow();
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("already exists");
  expect(
    (await f.git.remoteRefs(f.origin.dir)).get("refs/heads/queue/shadow-traffic/history"),
  ).toBe(f.main);
});
test("removed initialized state never replays a retained operator intent", async () => {
  const f = await fixture();
  await initializeActiveState(f.git, f.writer, f.deps);
  await f.origin.exec(["update-ref", "-d", f.writer.stateRef]);
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow();
  expect((await f.git.remoteRefs(f.origin.dir)).has(f.writer.stateRef)).toBe(false);
});
for (const ref of ["queue/live/reservation", "queue/live/base/id", "queue/unclassified"]) {
  test(`stray reservation ${ref} refuses initialization`, async () => {
    const f = await fixture();
    await f.origin.exec(["update-ref", `refs/heads/${ref}`, f.main]);
    await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("reservation");
  });
}
for (const patch of [
  { instances: 1 },
  { instancesComplete: false },
  { writerExited: false },
  { manualZero: false },
  { pendingEffects: true },
  { stopPersisted: false },
  { routingSafe: false },
  { observedAt: "2026-10-22T18:00:00Z" },
]) {
  test(`unsafe OFF evidence refuses ${JSON.stringify(patch)}`, async () => {
    const f = await fixture();
    Object.assign(f.observation, patch);
    await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("proven OFF");
    expect((await f.git.remoteRefs(f.origin.dir)).has(f.writer.stateRef)).toBe(false);
  });
}
test("activation refuses missing and unstamped state", () => {
  expect(() => requireInitializedState(null, emptyLedger())).toThrow("operator initialization");
  expect(() => requireInitializedState("a".repeat(40), emptyLedger())).toThrow(
    "operator initialization",
  );
});
test("concurrent initialization has exactly one create-only winner", async () => {
  const f = await fixture();
  const result = await Promise.allSettled([
    initializeActiveState(f.git, f.writer, f.deps),
    initializeActiveState(f.git, f.writer, {
      ...f.deps,
      reserve: (intent) => reserveInitialization(join(f.root, "other-intent.json"), intent),
    }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
test("lost push response leaves durable unknown and no retry", async () => {
  const f = await fixture();
  let pushes = 0;
  const original = f.writer.transaction.bind(f.writer);
  f.writer.transaction = async (updates) => {
    pushes++;
    await original(updates);
    throw Error("lost response");
  };
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("never replay");
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow();
  expect(pushes).toBe(1);
  expect(f.records).toContainEqual(expect.objectContaining({ outcome: "unknown-hold" }));
});
test("state race before push refuses rather than replacing", async () => {
  const f = await fixture();
  f.deps.reserve = async () => {
    await f.origin.exec(["update-ref", f.writer.stateRef, f.main]);
  };
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("never replay");
  expect((await f.git.remoteRefs(f.origin.dir)).get(f.writer.stateRef)).toBe(f.main);
});
test("stopped generation changing between observations refuses before reservation", async () => {
  const f = await fixture();
  let reads = 0;
  f.deps.observeStopped = async () => ({ ...f.observation, serviceGeneration: String(++reads) });
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow(
    "deployment changed",
  );
  expect((await f.git.remoteRefs(f.origin.dir)).has(f.writer.stateRef)).toBe(false);
});
test("new reservation racing initialization holds without deleting either ref", async () => {
  const f = await fixture();
  const reserve = f.deps.reserve;
  f.deps.reserve = async (intent) => {
    await reserve(intent);
    await f.origin.exec(["update-ref", "refs/heads/queue/live/race", f.main]);
  };
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("never replay");
  const refs = await f.git.remoteRefs(f.origin.dir);
  expect(refs.has(f.writer.stateRef)).toBe(true);
  expect(refs.get("refs/heads/queue/live/race")).toBe(f.main);
  expect(f.records).toContainEqual(expect.objectContaining({ outcome: "unknown-hold" }));
});
test("unknown push with absent state still never replays its intent", async () => {
  const f = await fixture();
  let pushes = 0;
  f.writer.transaction = async () => {
    pushes++;
    throw Error("unknown network outcome");
  };
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow("never replay");
  await expect(initializeActiveState(f.git, f.writer, f.deps)).rejects.toThrow();
  expect(pushes).toBe(1);
  expect((await f.git.remoteRefs(f.origin.dir)).has(f.writer.stateRef)).toBe(false);
});
