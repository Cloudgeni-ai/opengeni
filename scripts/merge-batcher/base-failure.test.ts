import { expect, test } from "bun:test";
import { baseJobClasses, failedBaseHold } from "./base-failure";
import type { BaseCiEvidence, Run } from "./model";
const sha = "a".repeat(40);
const run = { failedClasses: ["source"] } as Run;
const evidence = (classes: NonNullable<BaseCiEvidence["classes"]>): BaseCiEvidence => ({
  sha,
  status: "red",
  runId: 12,
  attempt: 1,
  reason: "fixture",
  classes,
});
const job = (id: number, name: string, conclusion = "success") => ({
  id,
  run_id: 12,
  name,
  status: "completed",
  conclusion,
});
const rows = () => [
  job(1, "Source and type contracts"),
  job(2, "Unit tests (shard 1/2)"),
  job(3, "Unit tests (shard 2/2)"),
  job(4, "Browser and visual acceptance", "failure"),
];
test("unrelated red main class does not hold a conclusive relevant green source class", () => {
  const classes = baseJobClasses(rows(), 12);
  expect(classes).toEqual({ source: "green", units: "green" });
  expect(failedBaseHold(run, sha, evidence(classes))).toBeNull();
  const sourceRed = rows();
  sourceRed[0]!.conclusion = "failure";
  expect(failedBaseHold(run, sha, evidence(baseJobClasses(sourceRed, 12)))).not.toBeNull();
});
test("unit failure comparison needs complete main shard set, not source or browser results", () => {
  const unitRun = { failedClasses: ["units"] } as Run;
  const unitRed = rows();
  unitRed[2]!.conclusion = "failure";
  expect(failedBaseHold(unitRun, sha, evidence(baseJobClasses(unitRed, 12)))).not.toBeNull();
  expect(failedBaseHold(run, sha, evidence(baseJobClasses(unitRed, 12)))).toBeNull();
  expect(
    baseJobClasses(
      rows().filter((r) => r.id !== 3),
      12,
    ).units,
  ).toBe("unknown");
});
test("duplicate, wrong-run, renamed, skipped and incomplete job observations cannot prove relevant green", () => {
  expect(baseJobClasses([...rows(), rows()[0]!], 12)).toEqual({
    source: "unknown",
    units: "unknown",
  });
  expect(baseJobClasses(rows(), 99)).toEqual({ source: "unknown", units: "unknown" });
  const renamed = rows();
  renamed[0]!.name = "Source and type contracts lookalike";
  expect(baseJobClasses(renamed, 12).source).toBe("unknown");
  const skipped = rows();
  skipped[0]!.conclusion = "skipped";
  expect(baseJobClasses(skipped, 12).source).toBe("unknown");
});
test("red then rerun-running or API error then red never releases a failed cohort", () => {
  const red = evidence({ source: "red", units: "green" });
  for (const base of [
    red,
    { ...red, attempt: 2, status: "unknown" as const },
    undefined,
    { ...red, attempt: 2 },
  ])
    expect(failedBaseHold(run, sha, base)).not.toBeNull();
  expect(failedBaseHold(run, sha, { ...red, status: "green" })).toBeNull();
  expect(failedBaseHold(run, sha, { ...red, sha: "b".repeat(40), status: "green" })).not.toBeNull();
});
test("missing historical failure class cannot use an unrelated red base as clearance", () => {
  expect(
    failedBaseHold({} as Run, sha, evidence({ source: "green", units: "green" })),
  ).not.toBeNull();
  expect(
    failedBaseHold({} as Run, sha, {
      ...evidence({ source: "green", units: "green" }),
      status: "green",
    }),
  ).toBeNull();
});
