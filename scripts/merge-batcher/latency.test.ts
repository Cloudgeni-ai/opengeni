import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  config,
  emptyLedger,
  ejectionKey,
  type Observation,
  type Pull,
  type StageSample,
} from "./model";
import { latencySummary, ObservationJournal } from "./journal";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const at = (minutes: number) =>
  new Date(Date.parse("2026-10-23T00:00:00Z") + minutes * 60000).toISOString();
const pull: Pull = {
  number: 1,
  headSha: "a".repeat(40),
  headRef: "feature",
  binding: {
    at: at(0),
    eventId: "ready1",
    source: "queue-ready",
    evidenceId: "1",
    evidenceDigest: "a".repeat(64),
  },
};
const key = ejectionKey(pull);
const sample = (): StageSample => ({
  batchId: "one",
  readyAt: at(0),
  readyBindings: [{ key, number: 1, headSha: pull.headSha, readyAt: at(0) }],
  builtAt: at(1),
  publishedAt: null,
  ciStartedAt: at(40),
  ciCompletedAt: null,
  landedAt: null,
  observedAt: at(41),
});
test("two-hour window ages samples without deleting history or fabricating healthy evidence", () => {
  const stages = { one: sample() };
  expect(latencySummary(stages, at(159))).toEqual({ p95: 2400, samples: 1 });
  expect(latencySummary(stages, at(161))).toEqual({ p95: null, samples: 0 });
  expect(stages.one.ciStartedAt).toBe(at(40));
});
test("capacity credits are bounded, unioned and tied to exact ready binding before first start", () => {
  const s = sample();
  s.mainCapacityWaits = [
    { key, from: at(1), to: at(5), mainRunId: 10 },
    { key, from: at(3), to: at(7), mainRunId: 10 },
    { key, from: at(3), to: at(7), mainRunId: 10 },
    { key: "other", from: at(8), to: at(12), mainRunId: 10 },
    { key, from: at(10), to: at(30), mainRunId: 10 },
    { key, from: at(39), to: at(42), mainRunId: 10 },
    { key, from: "invalid", to: at(30), mainRunId: 10 },
  ];
  expect(
    latencySummary(
      { one: s, duplicate: { ...s, batchId: "duplicate", ciStartedAt: at(50) } },
      at(60),
    ),
  ).toEqual({ p95: 1980, samples: 1 });
  expect(latencySummary({ one: s }, at(60), false)).toEqual({ p95: 2400, samples: 1 });
});
test("evidenced capacity wait can clear the adjusted threshold while raw slowness remains visible", () => {
  const s = sample();
  s.mainCapacityWaits = Array.from({ length: 6 }, (_, i) => ({
    key,
    from: at(i * 5),
    to: at((i + 1) * 5),
    mainRunId: 10,
  }));
  expect(latencySummary({ one: s }, at(60))).toEqual({ p95: 600, samples: 1 });
  expect(latencySummary({ one: s }, at(60), false)).toEqual({ p95: 2400, samples: 1 });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "latency-journal-"));
  roots.push(root);
  const settings = { ...config({}), outputDir: root, runnerBudget: 52, mainReserve: 30 };
  const ledger = emptyLedger();
  ledger.stages.one = { ...sample(), ciStartedAt: null };
  const observation: Observation = {
    now: at(1),
    baseSha: "b".repeat(40),
    ready: [pull],
    excluded: [],
    candidates: [],
    stateSha: null,
    ledger,
    mainBusy: true,
    headroom: {
      allowed: false,
      reason: "main capacity",
      budget: 52,
      occupied: 45,
      mainDemand: 45,
      reservedMain: 45,
      candidateSlots: 18,
      capacity: {
        providerJobLimit: 60,
        otherRepositoryAllowance: 28,
        providerRequired: 91,
        latestMain: { runId: 10, queuedJobs: 0, oldestQueuedSeconds: null, maxStartWaitSeconds: 0 },
        mainQueuedJobs: 0,
        preFanoutMainRuns: [],
        hold: "repository-budget",
      },
    },
  };
  return { settings, observation };
}
test("recorded main holds survive journal restart and durable stage reconstruction", async () => {
  const { settings, observation: o } = await setup();
  await new ObservationJournal(settings).observe(o);
  const journal = new ObservationJournal(settings);
  await journal.observe({ ...o, now: at(3) });
  const records = await journal.records(at(3));
  expect(records.stages.one!.mainCapacityWaits).toEqual([
    { key, from: at(1), to: at(3), mainRunId: 10 },
  ]);
  const restored = await setup();
  restored.observation.ledger.stages = records.stages;
  const replay = new ObservationJournal(restored.settings);
  await replay.observe({ ...restored.observation, now: at(4), headroom: null });
  const retained = await replay.records(at(4));
  expect(retained.stages.one!.mainCapacityWaits).toHaveLength(1);
  expect(latencySummary({ one: { ...retained.stages.one!, ciStartedAt: at(40) } }, at(50))).toEqual(
    { p95: 2280, samples: 1 },
  );
});
for (const change of [
  "gap",
  "failed-scan",
  "other-demand",
  "run-change",
  "config-change",
  "ready-change",
  "not-held",
  "backwards",
  "first-started",
  "local-conflict",
  "occupied-slot",
] as const)
  test(`no invented capacity credit: ${change}`, async () => {
    const { settings, observation: o } = await setup();
    const journal = new ObservationJournal(settings);
    await journal.observe(o);
    const next = structuredClone(o);
    next.now = at(3);
    if (change === "gap") next.now = at(10);
    if (change === "failed-scan") delete next.headroom;
    if (change === "other-demand") next.headroom!.mainDemand = 0;
    if (change === "run-change") next.headroom!.capacity!.latestMain!.runId = 11;
    if (change === "config-change") next.headroom!.budget = 53;
    if (change === "ready-change") next.ready = [];
    if (change === "not-held") next.mainBusy = false;
    if (change === "backwards") next.now = at(0);
    if (change === "first-started") next.ledger.stages.one!.ciStartedAt = at(2);
    if (change === "local-conflict") await journal.conflict(pull, at(2));
    if (change === "occupied-slot")
      next.candidates = [
        {
          manifest: {
            schemaVersion: 1,
            batchId: "c".repeat(64),
            baseSha: next.baseSha,
            createdAt: at(0),
            predecessor: null,
            recoveryOf: null,
            tipSha: "c".repeat(40),
            pulls: [{ ...pull, mergeSha: "c".repeat(40) }],
          },
          branch: `${settings.branchPrefix}${"c".repeat(64)}`,
          containedInBase: false,
          runs: [],
        },
      ];
    await journal.observe(next);
    expect((await journal.records(next.now)).stages.one!.mainCapacityWaits ?? []).toHaveLength(0);
  });
