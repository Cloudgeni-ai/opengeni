import { expect, test } from "bun:test";
import {
  reconcileStopped,
  settledEffect,
} from "../docs/merge-batcher-admin/stopped-reconciliation";
import { reconcileRetainedStop } from "../docs/merge-batcher-admin/resume-stop";
import { verifyStop } from "../docs/merge-batcher-admin/off";
const stateSha = "a".repeat(40),
  mainSha = "b".repeat(40);
const scope = { project: "fixture-project", region: "fixture-region" };
const obsolete = {
  kind: "rerun",
  status: "blocked",
  attempts: 0,
  lastError: "Candidate readiness changed before retry; obsolete intent not submitted",
};
function fixture() {
  const target = {
    uid: "uid",
    image: `registry/image@sha256:${"c".repeat(64)}`,
    uri: "https://fixture.run.app",
  };
  const witness = {
    uid: "uid",
    generation: "66",
    mode: "active",
    instance: "exited-instance",
    controlGeneration: "stop-bf7e90b5-b757-4e79-a264-3bdf58336178",
  };
  const stop = {
    command: "stop",
    disabled: true,
    manualZero: true,
    stopPersisted: true,
    forced: false,
    taggedRevisionsMayRemain: false,
    drainProven: true,
    priorDrainProof: false,
    outcome: "unknown",
    stateBefore: stateSha,
    stateAfter: stateSha,
    drainWitness: witness,
    writer: {
      state: "stopped",
      instance: witness.instance,
      control: { generation: witness.controlGeneration },
      writerActive: false,
      writerPid: null,
      unprovenWriterPid: null,
      uncertainOutcome: true,
      reconciliationRequired: true,
    },
  };
  const receipt = { ...target, drainWitness: witness };
  const live = {
    ...target,
    generation: "66",
    observedGeneration: "66",
    etag: "etag",
    reconciling: false,
    template: { containers: [{ image: target.image }] },
    scaling: { scalingMode: "MANUAL", manualInstanceCount: 0 },
    traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
  };
  const state = {
    schemaVersion: 1,
    epoch: 943,
    landed: [],
    invalidated: [],
    effects: { old: obsolete },
  };
  const get = async (path: string) =>
    path.startsWith("git/blobs/")
      ? { encoding: "base64", content: Buffer.from(JSON.stringify(state)).toString("base64") }
      : path.startsWith("git/commits/")
        ? { tree: { sha: "d".repeat(40) } }
        : path.startsWith("git/trees/")
          ? { tree: [{ path: "state.json", type: "blob", sha: "c".repeat(40) }] }
          : path.includes("matching-refs")
            ? []
            : { object: { sha: path.endsWith("main") ? mainSha : stateSha } };
  const api = async (url: string) =>
    url.includes("secretmanager")
      ? {
          name: "version55",
          payload: {
            data: Buffer.from(
              JSON.stringify({ state: "stopped", generation: witness.controlGeneration }),
            ).toString("base64"),
          },
        }
      : live;
  return { target, witness, stop, receipt, live, state, get, api };
}
test("REST-only uncertainty is retained but never blocks Manual; ref effects still block", () => {
  for (const kind of ["rerun", "comment", "followup", "disable-auto-merge"])
    for (const status of ["pending", "blocked", "uncertain", "done"])
      for (const attempts of [0, 1])
        expect(settledEffect({ kind, status, attempts, checks: 0 })).toBe(true);
  for (const kind of ["publish", "land", "record", "unknown"])
    expect(settledEffect({ kind, status: "pending", attempts: 0 })).toBe(false);
});
test("stopped recovery leaves REST effects unchanged and refuses possible ref writes", async () => {
  const f = fixture();
  expect((await reconcileStopped("active", stateSha, f.get)).effects).toBe(1);
  f.state.effects.old = { ...obsolete, attempts: 1 };
  const original = JSON.stringify(f.state);
  expect((await reconcileStopped("active", stateSha, f.get)).effects).toBe(1);
  expect(JSON.stringify(f.state)).toBe(original);
  f.state.effects.old = { ...obsolete, kind: "publish" };
  await expect(reconcileStopped("active", stateSha, f.get)).rejects.toThrow("Unresolved");
});
test("blob reads support state larger than the Contents API inline limit", async () => {
  const f = fixture();
  Object.assign(f.state, { padding: "x".repeat(1_100_000) });
  expect((await reconcileStopped("active", stateSha, f.get)).stateSha).toBe(stateSha);
});
test("proof-only continuation retains unknown original and verifies real drain", async () => {
  const f = fixture(),
    original = JSON.stringify(f.stop);
  const out = await reconcileRetainedStop(
    f.stop,
    f.receipt,
    f.target,
    "batcher",
    "control",
    f.api,
    f.get,
    scope,
  );
  expect(() => verifyStop(out.result, out.receipt, f.target)).not.toThrow();
  expect(JSON.stringify(f.stop)).toBe(original);
  expect(out.originalOutcome).toBe("unknown");
});
test("proof-only continuation refuses live writer, generation changes and tagged routing", async () => {
  for (const patch of [
    { generation: "67" },
    { scaling: { scalingMode: "MANUAL", manualInstanceCount: 1 } },
    { traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100, tag: "old" }] },
  ]) {
    const f = fixture();
    Object.assign(f.live, patch);
    await expect(
      reconcileRetainedStop(f.stop, f.receipt, f.target, "batcher", "control", f.api, f.get, scope),
    ).rejects.toThrow();
  }
  const f = fixture();
  f.stop.writer.writerActive = true;
  await expect(
    reconcileRetainedStop(f.stop, f.receipt, f.target, "batcher", "control", f.api, f.get, scope),
  ).rejects.toThrow();
});
test("changed control or moving refs cannot authorize restoration", async () => {
  const f = fixture();
  const api = async (url: string) =>
    url.includes("secretmanager")
      ? {
          name: "new",
          payload: {
            data: Buffer.from(
              JSON.stringify({ state: "running", generation: "start-new" }),
            ).toString("base64"),
          },
        }
      : f.live;
  await expect(
    reconcileRetainedStop(f.stop, f.receipt, f.target, "batcher", "control", api, f.get, scope),
  ).rejects.toThrow();
  let reads = 0;
  const get = async (path: string) =>
    path.endsWith("main")
      ? { object: { sha: ++reads === 1 ? mainSha : "d".repeat(40) } }
      : f.get(path);
  await expect(
    reconcileRetainedStop(f.stop, f.receipt, f.target, "batcher", "control", f.api, get, scope),
  ).rejects.toThrow("snapshot changed");
});
