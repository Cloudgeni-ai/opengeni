import { expect, test } from "bun:test";
import { operatorOffIntervals } from "./operator-off";
import { config, type StageSample } from "./model";
import { latencySummary } from "./journal";
const at = (m: number) => new Date(Date.parse("2026-10-23T00:00:00Z") + m * 60000).toISOString();
const cfg = config({ BATCHER_MODE: "active" });
export const evidence = () => ({
  schema: "batcher-operator-off/v1",
  repository: cfg.repository,
  branchPrefix: cfg.branchPrefix,
  mode: cfg.mode,
  serviceUid: "service-one",
  controls: [
    { version: 10, at: at(5), state: "stopped", generation: "stop-00000001" },
    { version: 11, at: at(30), state: "running", generation: "start-00000002" },
  ],
  drains: [
    {
      at: at(10),
      controlVersion: 10,
      controlGeneration: "stop-00000001",
      serviceUid: "service-one",
      manualZero: true,
      writerExited: true,
      stateStable: true,
      forced: false,
    },
  ],
});
test("OFF credit begins at completed drain, ends at first START, and preserves raw latency", () => {
  const intervals = operatorOffIntervals(JSON.stringify(evidence()), cfg, at(60));
  expect(intervals).toHaveLength(1);
  expect(intervals[0]!.from).toBe(at(10));
  expect(intervals[0]!.to).toBe(at(30));
  const sample: StageSample = {
    batchId: "one",
    readyAt: at(0),
    readyBindings: [{ key: "ready", number: 1, headSha: "a".repeat(40), readyAt: at(0) }],
    builtAt: null,
    publishedAt: null,
    ciStartedAt: at(40),
    ciCompletedAt: null,
    landedAt: null,
    observedAt: at(50),
    operatorOffWaits: intervals.map((i) => ({ key: "ready", ...i })),
  };
  expect(latencySummary({ one: sample }, at(50))).toEqual({ p95: 1200, samples: 1 });
  expect(latencySummary({ one: sample }, at(50), false)).toEqual({ p95: 2400, samples: 1 });
  sample.mainCapacityWaits = [{ key: "ready", from: at(12), to: at(15), mainRunId: 1 }];
  sample.operatorOffWaits!.push(...sample.operatorOffWaits!);
  expect(latencySummary({ one: sample }, at(50)).p95).toBe(1200);
  sample.ciStartedAt = at(70);
  expect(latencySummary({ one: sample }, at(80)).p95).toBe(3000); // real residual slowness still trips
});
for (const [name, mutate] of Object.entries<(e: any) => unknown>({
  gap: (e: any) => e.controls[1].version++,
  order: (e: any) => (e.controls[1].at = at(4)),
  future: (e: any) => (e.controls[1].at = at(100)),
  scope: (e: any) => (e.branchPrefix = "queue/other/"),
  uncertain: (e: any) => (e.drains[0].writerExited = false),
  forced: (e: any) => (e.drains[0].forced = true),
  unstable: (e: any) => (e.drains[0].stateStable = false),
  notZero: (e: any) => (e.drains[0].manualZero = false),
  service: (e: any) => (e.drains[0].serviceUid = "other"),
  generation: (e: any) => (e.drains[0].controlGeneration = "stop-00000009"),
  beforeStop: (e: any) => (e.drains[0].at = at(1)),
  malformed: (e: any) => (e.controls[0].at = "invalid"),
  duplicateGeneration: (e: any) => (e.controls[1].generation = e.controls[0].generation),
}))
  test(`rejects unproven OFF credit: ${name}`, () => {
    const e = evidence();
    mutate(e);
    expect(() => operatorOffIntervals(JSON.stringify(e), cfg, at(60))).toThrow();
  });
test("no credit bridges an open STOP or drain completion after START", () => {
  const e = evidence();
  e.controls[1] = { version: 11, at: at(30), state: "stopped", generation: "stop-00000002" };
  expect(operatorOffIntervals(JSON.stringify(e), cfg, at(60))).toEqual([]);
  const late = evidence();
  late.drains[0]!.at = at(31);
  expect(operatorOffIntervals(JSON.stringify(late), cfg, at(60))).toEqual([]);
  expect(operatorOffIntervals(undefined, cfg, at(60))).toEqual([]);
});
test("interval duration bound and clipped overlap never over-credit", () => {
  const e = evidence();
  e.controls[1]!.at = at(8 * 24 * 60);
  expect(() => operatorOffIntervals(JSON.stringify(e), cfg, at(9 * 24 * 60))).toThrow();
  const intervals = operatorOffIntervals(JSON.stringify(evidence()), cfg, at(60));
  const s: StageSample = {
    batchId: "one",
    readyAt: at(20),
    readyBindings: [{ key: "k", number: 1, headSha: "a".repeat(40), readyAt: at(20) }],
    builtAt: null,
    publishedAt: null,
    ciStartedAt: at(25),
    ciCompletedAt: null,
    landedAt: null,
    observedAt: at(50),
    operatorOffWaits: intervals.map((i) => ({ key: "k", ...i })),
  };
  expect(latencySummary({ one: s }, at(50)).p95).toBe(0);
});
